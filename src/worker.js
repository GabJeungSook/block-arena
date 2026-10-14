// Block Arena server (Cloudflare Worker).
//   /auth/facebook            → Facebook login dialog
//   /auth/facebook/callback   → finish login, create the session cookie
//   /auth/facebook/delete     → Meta's data deletion callback
//   /auth/logout              → end the session
//   /api/me                   → who is signed in, their rank and saved progress
//   /api/profile        PUT   → save progress (XP, best scores)
//   /api/match/start    POST  → begin a ranked match
//   /api/match/finish   POST  → report the result; the server computes the rank change
//   /api/leaderboard          → top players and your position
//   /api/account        DELETE→ delete your account
//   /room/<name>              → WebSocket for an online room (Durable Object)
// Everything else is the game itself, served from /public.
import { rankOf, rpDelta, applyDelta } from './rank.js';
export { Room } from './room.js';

const GRAPH = 'https://graph.facebook.com/v25.0';
const DIALOG = 'https://www.facebook.com/v25.0/dialog/oauth';
const SESSION_DAYS = 60;
const MIN_MATCH_MS = 20000, MAX_MATCH_MS = 15 * 60000;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p === '/auth/facebook') return fbStart(req, env, url);
      if (p === '/auth/facebook/callback') return await fbCallback(req, env, url);
      if (p === '/auth/facebook/delete' && req.method === 'POST') return await fbDelete(req, env, url);
      if (p === '/auth/facebook/delete') return deletionInstructions();
      if (p === '/auth/dev' && env.DEV_LOGIN === '1') return await devLogin(req, env, url);
      if (p === '/auth/logout') return await logout(req, env, url);
      if (p === '/deletion') return deletionStatus(env, url);
      if (p.startsWith('/room/')) return await room(req, env, p);
      if (p.startsWith('/api/')) return await api(req, env, url, p);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error' }, 500);
    }
  },
};

// ---------- helpers ----------
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const now = () => Date.now();
const rand = (n = 32) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();
async function sha256(s) { const h = await crypto.subtle.digest('SHA-256', enc.encode(s)); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function cookies(req) { const out = {}; for (const part of (req.headers.get('Cookie') || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out; }
const secure = url => url.protocol === 'https:' ? '; Secure' : '';
const setCookie = (url, name, val, maxAge) => `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(url)}`;
const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { Location: to, ...headers } });

async function currentUser(req, env) {
  const tok = cookies(req).ba_sess; if (!tok) return null;
  const sid = await sha256(tok);
  const row = await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?').bind(sid, now()).first();
  return row || null;
}
const publicUser = u => {
  const r = rankOf(u.rp);
  return { id: u.id, name: u.name, pic: u.pic, rp: u.rp, peak: u.peak_rp, rank: r.name, tier: r.tier, rankedGames: u.ranked_games, rankedWins: u.ranked_wins };
};
async function startSession(env, url, userId, back = '/') {
  const tok = rand(32), sid = await sha256(tok);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(sid, userId, now() + SESSION_DAYS * 864e5).run();
  return redirect(back, { 'Set-Cookie': setCookie(url, 'ba_sess', tok, SESSION_DAYS * 86400) });
}
async function upsertUser(env, fbId, name, pic) {
  const t = now();
  await env.DB.prepare(`INSERT INTO users (fb_id, name, pic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (fb_id) DO UPDATE SET name = excluded.name, pic = excluded.pic, updated_at = excluded.updated_at`).bind(fbId, name, pic, t, t).run();
  return env.DB.prepare('SELECT * FROM users WHERE fb_id = ?').bind(fbId).first();
}

// ---------- Facebook login (server-side code flow) ----------
function fbStart(req, env, url) {
  if (!env.FB_APP_ID) return new Response('Facebook login is not configured yet (FB_APP_ID missing).', { status: 503 });
  const state = rand(16);
  const q = new URLSearchParams({ client_id: env.FB_APP_ID, redirect_uri: `${url.origin}/auth/facebook/callback`, state, scope: 'public_profile', response_type: 'code' });
  return redirect(`${DIALOG}?${q}`, { 'Set-Cookie': setCookie(url, 'ba_state', state, 600) });
}
async function fbCallback(req, env, url) {
  const state = url.searchParams.get('state'), code = url.searchParams.get('code');
  const clear = setCookie(url, 'ba_state', '', 0);
  if (!code || !state || state !== cookies(req).ba_state) return redirect('/?login=failed', { 'Set-Cookie': clear });
  const tq = new URLSearchParams({ client_id: env.FB_APP_ID, client_secret: env.FB_APP_SECRET, redirect_uri: `${url.origin}/auth/facebook/callback`, code });
  const tr = await fetch(`${GRAPH}/oauth/access_token?${tq}`);
  const tok = await tr.json().catch(() => ({}));
  if (!tok.access_token) return redirect('/?login=failed', { 'Set-Cookie': clear });
  const proof = await hmacHex(env.FB_APP_SECRET, tok.access_token);
  const mr = await fetch(`${GRAPH}/me?fields=id,name,picture.width(128).height(128)&access_token=${encodeURIComponent(tok.access_token)}&appsecret_proof=${proof}`);
  const me = await mr.json().catch(() => ({}));
  if (!me.id) return redirect('/?login=failed', { 'Set-Cookie': clear });
  const user = await upsertUser(env, me.id, String(me.name || 'Player').slice(0, 40), me.picture?.data?.url || null);
  const res = await startSession(env, url, user.id, '/?login=ok');
  res.headers.append('Set-Cookie', clear);
  return res;
}
// local testing only: enabled with DEV_LOGIN=1 in .dev.vars, never in production
async function devLogin(req, env, url) {
  const name = (url.searchParams.get('name') || 'Tester').slice(0, 40);
  const user = await upsertUser(env, 'dev-' + name.toLowerCase(), name, null);
  return startSession(env, url, user.id, '/?login=ok');
}
async function logout(req, env, url) {
  const tok = cookies(req).ba_sess;
  if (tok) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(tok)).run();
  return redirect('/', { 'Set-Cookie': setCookie(url, 'ba_sess', '', 0) });
}
// Meta calls this when someone removes the app and asks for their data to be deleted
async function fbDelete(req, env, url) {
  const form = await req.formData(), sr = String(form.get('signed_request') || '');
  const [sig, payload] = sr.split('.');
  if (!sig || !payload) return json({ error: 'bad_request' }, 400);
  const b64 = s => atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  const expect = await hmacHex(env.FB_APP_SECRET, payload);
  const got = [...b64(sig)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  if (got !== expect) return json({ error: 'bad_signature' }, 400);
  const data = JSON.parse(b64(payload));
  await env.DB.prepare('DELETE FROM users WHERE fb_id = ?').bind(String(data.user_id)).run();
  const code = rand(8);
  await env.DB.prepare('INSERT INTO deletions (code, created_at) VALUES (?, ?)').bind(code, now()).run();
  return json({ url: `${url.origin}/deletion?code=${code}`, confirmation_code: code });
}
// what a person sees if they open the deletion address in a browser (Meta also checks this page exists)
function deletionInstructions() {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Delete your Block Arena data</title><body style="font-family:system-ui;background:#04050b;color:#fff;padding:32px 16px;max-width:640px;margin:auto;line-height:1.6"><h1>Delete your Block Arena data</h1><p>Signed-in players can delete their account at any time:</p><ol><li>Open Block Arena and sign in.</li><li>Go to <b>Settings → Account → Delete my account</b>.</li><li>Confirm. Your rank, match history and saved progress are removed immediately.</li></ol><p>Or remove Block Arena in Facebook under <b>Settings → Apps and websites</b> and choose to delete your data; Facebook tells us and we delete your account automatically.</p><p><a style="color:#ffd21a" href="/">Back to Block Arena</a> · <a style="color:#ffd21a" href="/privacy">Privacy policy</a></p>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
async function deletionStatus(env, url) {
  const code = url.searchParams.get('code') || '';
  const row = code ? await env.DB.prepare('SELECT code FROM deletions WHERE code = ?').bind(code).first() : null;
  const msg = row ? `Request ${code}: your Block Arena account and all its data have been deleted.` : 'No deletion request with that code was found.';
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Block Arena data deletion</title><body style="font-family:system-ui;background:#04050b;color:#fff;padding:32px;max-width:640px;margin:auto"><h1>Data deletion</h1><p>${msg}</p><p><a style="color:#ffd21a" href="/">Back to Block Arena</a></p>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------- rooms ----------
async function room(req, env, p) {
  const name = decodeURIComponent(p.slice(6));
  if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(name)) return new Response('Bad room name', { status: 400 });
  const u = await currentUser(req, env);
  const fwd = new Request(req); if (u) fwd.headers.set('X-BA-User', String(u.id)); else fwd.headers.delete('X-BA-User');
  return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(fwd);
}

// ---------- API ----------
async function api(req, env, url, p) {
  const m = req.method;
  if (m !== 'GET' && req.headers.get('X-BA') !== '1') return json({ error: 'forbidden' }, 403); // forces a CORS preflight, so other sites can't post here
  if (p === '/api/leaderboard' && m === 'GET') return leaderboard(req, env, url);
  const u = await currentUser(req, env);
  if (p === '/api/me' && m === 'GET') {
    if (!u) return json({ user: null, fbConfigured: !!env.FB_APP_ID });
    return json({ user: publicUser(u), profile: JSON.parse(u.profile || '{}'), fbConfigured: true });
  }
  if (!u) return json({ error: 'not_signed_in' }, 401);
  if (p === '/api/profile' && m === 'PUT') return saveProfile(req, env, u);
  if (p === '/api/match/start' && m === 'POST') return matchStart(req, env, u);
  if (p === '/api/match/finish' && m === 'POST') return matchFinish(req, env, u);
  if (p === '/api/account' && m === 'DELETE') {
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(url, 'ba_sess', '', 0) });
  }
  return json({ error: 'not_found' }, 404);
}
async function body(req) { try { const t = await req.text(); return t.length > 4096 ? {} : JSON.parse(t); } catch (e) { return {}; } }

async function saveProfile(req, env, u) {
  const b = await body(req), cur = JSON.parse(u.profile || '{}');
  const n = (v, max) => Math.max(0, Math.min(max, Math.floor(+v || 0)));
  // progress only moves forward, and XP can't jump more than one big match at a time
  const next = {
    xp: Math.max(cur.xp || 0, Math.min(n(b.xp, 1e7), (cur.xp || 0) + 800)),
    wins: Math.max(cur.wins || 0, Math.min(n(b.wins, 1e6), (cur.wins || 0) + 1)),
    games: Math.max(cur.games || 0, Math.min(n(b.games, 1e6), (cur.games || 0) + 1)),
    bestCombo: Math.max(cur.bestCombo || 0, n(b.bestCombo, 60)),
    classic: Math.max(cur.classic || 0, n(b.classic, 1e8)),
    sprint: cur.sprint && b.sprint ? Math.min(cur.sprint, Math.max(15000, n(b.sprint, 36e5))) : (cur.sprint || (b.sprint ? Math.max(15000, n(b.sprint, 36e5)) : 0)),
  };
  await env.DB.prepare('UPDATE users SET profile = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(next), now(), u.id).run();
  return json({ profile: next });
}

const KINDS = ['cpu', 'arena', 'online'], LEVELS = ['easy', 'normal', 'hard', 'expert'];
async function matchStart(req, env, u) {
  const b = await body(req);
  if (!KINDS.includes(b.kind)) return json({ error: 'bad_kind' }, 400);
  const size = b.kind === 'cpu' ? 2 : Math.max(2, Math.min(6, Math.floor(+b.size || 2)));
  const level = b.kind === 'online' ? null : (LEVELS.includes(b.level) ? b.level : 'normal');
  // an unfinished ranked match left in the last 15 minutes counts as a loss (quitting mid-match)
  let rp = u.rp, penalty = 0;
  const open = await env.DB.prepare('SELECT * FROM matches WHERE user_id = ? AND finished_at IS NULL AND started_at > ? ORDER BY started_at DESC LIMIT 1').bind(u.id, now() - MAX_MATCH_MS).first();
  if (open && now() - open.started_at > MIN_MATCH_MS) {
    penalty = rpDelta({ kind: open.kind, level: open.level || 'normal', size: open.size, place: open.size }, rp);
    rp = applyDelta(rp, penalty);
    await env.DB.batch([
      env.DB.prepare('UPDATE matches SET finished_at = ?, place = ?, delta = ? WHERE id = ?').bind(now(), open.size, rp - u.rp, open.id),
      env.DB.prepare('UPDATE users SET rp = ?, ranked_games = ranked_games + 1, updated_at = ? WHERE id = ?').bind(rp, now(), u.id),
    ]);
  }
  await env.DB.prepare('DELETE FROM matches WHERE user_id = ? AND finished_at IS NULL').bind(u.id).run();
  const id = rand(12);
  await env.DB.prepare('INSERT INTO matches (id, user_id, kind, level, size, started_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, u.id, b.kind, level, size, now()).run();
  return json({ id, rp, quitPenalty: rp - u.rp });
}
async function matchFinish(req, env, u) {
  const b = await body(req);
  const mt = await env.DB.prepare('SELECT * FROM matches WHERE id = ? AND user_id = ?').bind(String(b.id || ''), u.id).first();
  if (!mt || mt.finished_at) return json({ error: 'unknown_match' }, 404);
  const age = now() - mt.started_at;
  if (age < MIN_MATCH_MS || age > MAX_MATCH_MS) return json({ error: 'bad_timing' }, 400);
  const place = Math.max(1, Math.min(mt.size, Math.floor(+b.place || mt.size)));
  const draw = !!b.draw && mt.size === 2;
  const d = rpDelta({ kind: mt.kind, level: mt.level || 'normal', size: mt.size, place, draw }, u.rp);
  const rp = applyDelta(u.rp, d), real = rp - u.rp, win = place === 1 && !draw ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare('UPDATE matches SET finished_at = ?, place = ?, delta = ? WHERE id = ?').bind(now(), place, real, mt.id),
    env.DB.prepare('UPDATE users SET rp = ?, peak_rp = MAX(peak_rp, ?), ranked_games = ranked_games + 1, ranked_wins = ranked_wins + ?, updated_at = ? WHERE id = ?').bind(rp, rp, win, now(), u.id),
  ]);
  const before = rankOf(u.rp), after = rankOf(rp);
  return json({ delta: real, rp, before: before.name, after: after.name, promoted: rp > u.rp && after.name !== before.name, demoted: rp < u.rp && after.name !== before.name });
}
async function leaderboard(req, env, url) {
  const limit = Math.max(1, Math.min(100, +url.searchParams.get('limit') || 50));
  const { results } = await env.DB.prepare('SELECT id, name, pic, rp, ranked_games, ranked_wins FROM users WHERE ranked_games > 0 ORDER BY rp DESC, updated_at ASC LIMIT ?').bind(limit).all();
  const u = await currentUser(req, env);
  let me = null;
  if (u) {
    const pos = await env.DB.prepare('SELECT COUNT(*) AS c FROM users WHERE ranked_games > 0 AND rp > ?').bind(u.rp).first();
    me = { ...publicUser(u), position: u.ranked_games > 0 ? (pos.c + 1) : null };
  }
  return json({ top: results.map((r, i) => ({ position: i + 1, id: r.id, name: r.name, pic: r.pic, rp: r.rp, rank: rankOf(r.rp).name, tier: rankOf(r.rp).tier, games: r.ranked_games, wins: r.ranked_wins })), me });
}
