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
//   /api/coins/earn     POST  → add coins after a match (capped)
//   /api/shop/buy|equip POST  → buy or equip a cosmetic
//   /api/friends*             → in-game friends: friend codes, requests, list with who's online
//   /hub                      → WebSocket to the Hub (online status, room invites, friend requests in real time)
// Everything else is the game itself, served from /public.
import { rankOf, rpDelta, applyDelta } from './rank.js';
import { PRICES, SLOTS, DEFAULTS, MAX_PER_MATCH, MIN_GAP_MS, DAILY_CAP, ACH_COINS } from './shop.js';
export { Room } from './room.js';
export { Hub } from './hub.js';

const GRAPH = 'https://graph.facebook.com/v25.0';
const DIALOG = 'https://www.facebook.com/v25.0/dialog/oauth';
const SESSION_DAYS = 60;
const MIN_MATCH_MS = 20000, MAX_MATCH_MS = 15 * 60000;
const ACHIEVEMENTS = ['first_win', 'combo5', 'combo10', 'quad', 'tspin', 'pc', 'bomber', 'ko3', 'arena6', 'expert', 'classic100k', 'sprint60', 'gold', 'master', 'online'];

// New tables are created on first use, so updates never need a manual database step.
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS friendships (user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, friend_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, PRIMARY KEY (user_id, friend_id))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, png BLOB NOT NULL, created_at INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS shares_user ON shares (user_id, created_at DESC)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS friend_requests (from_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests (to_id)'),
  ]);
  schemaReady = true;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/s/') || p.startsWith('/room/') || p === '/hub') await ensureSchema(env);
      if (p.startsWith('/s/')) return await sharePage(req, env, url, p);
      if (p === '/auth/facebook') return fbStart(req, env, url);
      if (p === '/auth/facebook/callback') return await fbCallback(req, env, url);
      if (p === '/auth/facebook/delete' && req.method === 'POST') return await fbDelete(req, env, url);
      if (p === '/auth/facebook/delete') return deletionInstructions();
      if (p === '/auth/dev' && env.DEV_LOGIN === '1') return await devLogin(req, env, url);
      if (p === '/auth/logout') return await logout(req, env, url);
      if (p === '/deletion') return deletionStatus(env, url);
      if (p.startsWith('/room/')) return await room(req, env, p);
      if (p === '/hub') return await hub(req, env);
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
  // "App friends" (user_friends) needs Meta App Review before it works for the public; turn it on with FB_FRIENDS=1
  const scope = env.FB_FRIENDS === '1' ? 'public_profile,user_friends' : 'public_profile';
  const back = /^\/[^/]/.test(url.searchParams.get('back') || '') ? url.searchParams.get('back') : '/';
  const q = new URLSearchParams({ client_id: env.FB_APP_ID, redirect_uri: `${url.origin}/auth/facebook/callback`, state, scope, response_type: 'code' });
  const res = redirect(`${DIALOG}?${q}`, { 'Set-Cookie': setCookie(url, 'ba_state', state, 600) });
  res.headers.append('Set-Cookie', setCookie(url, 'ba_back', back, 600));
  return res;
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
  await syncFriends(env, user.id, tok.access_token, proof).catch(() => {});
  const back = cookies(req).ba_back || '/';
  const res = await startSession(env, url, user.id, back + (back.includes('?') ? '&' : '?') + 'login=ok');
  res.headers.append('Set-Cookie', clear);
  res.headers.append('Set-Cookie', setCookie(url, 'ba_back', '', 0));
  return res;
}
// Friends who also play (only when the user granted "App friends"); stored both ways so either side sees it
async function syncFriends(env, userId, token, proof) {
  let next = `${GRAPH}/me/friends?limit=500&access_token=${encodeURIComponent(token)}&appsecret_proof=${proof}`, ids = [];
  for (let page = 0; next && page < 10; page++) {
    const r = await fetch(next); const j = await r.json().catch(() => ({}));
    if (!Array.isArray(j.data)) break;
    ids.push(...j.data.map(f => String(f.id)));
    next = j.paging?.next || null;
  }
  if (!ids.length) return;
  const stmts = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90), qs = chunk.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT id FROM users WHERE fb_id IN (${qs})`).bind(...chunk).all();
    for (const f of results) {
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').bind(userId, f.id));
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').bind(f.id, userId));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}
// local testing only: enabled with DEV_LOGIN=1 in .dev.vars, never in production
async function devLogin(req, env, url) {
  const name = (url.searchParams.get('name') || 'Tester').slice(0, 40);
  const user = await upsertUser(env, 'dev-' + name.toLowerCase(), name, null);
  const friend = url.searchParams.get('friend');
  if (friend) { const f = await env.DB.prepare('SELECT id FROM users WHERE fb_id = ?').bind('dev-' + friend.toLowerCase()).first(); if (f) await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO friendships VALUES (?, ?)').bind(user.id, f.id), env.DB.prepare('INSERT OR IGNORE INTO friendships VALUES (?, ?)').bind(f.id, user.id)]); }
  return startSession(env, url, user.id, '/?login=ok');
}
async function logout(req, env, url) {
  const tok = cookies(req).ba_sess;
  if (tok) { const h = await sha256(tok); await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(h).run(); }
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
  if (!u) return new Response('Sign in with Facebook to play online', { status: 401 });
  const fwd = new Request(req); fwd.headers.set('X-BA-User', String(u.id));
  return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(fwd);
}

async function hub(req, env) {
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
  const u = await currentUser(req, env);
  if (!u) return new Response('Sign in first', { status: 401 });
  const fwd = new Request(req); fwd.headers.set('X-BA-User', String(u.id));
  return hubStub(env).fetch(fwd);
}
const hubStub = env => env.HUB.get(env.HUB.idFromName('global'));
const hubCall = (env, path, data) => hubStub(env).fetch('https://hub' + path, { method: 'POST', body: JSON.stringify(data) }).then(r => r.json()).catch(() => ({}));

// ---------- API ----------
async function api(req, env, url, p) {
  const m = req.method;
  if (m !== 'GET' && req.headers.get('X-BA') !== '1') return json({ error: 'forbidden' }, 403); // forces a CORS preflight, so other sites can't post here
  if (p === '/api/leaderboard' && m === 'GET') return leaderboard(req, env, url);
  const u = await currentUser(req, env);
  if (p === '/api/me' && m === 'GET') {
    if (!u) return json({ user: null, fbConfigured: !!env.FB_APP_ID, appId: env.FB_APP_ID || null, friendsEnabled: env.FB_FRIENDS === '1' });
    const fc = await env.DB.prepare('SELECT COUNT(*) AS c FROM friendships WHERE user_id = ?').bind(u.id).first();
    return json({ user: { ...publicUser(u), friends: fc?.c || 0 }, profile: JSON.parse(u.profile || '{}'), fbConfigured: true, appId: env.FB_APP_ID, friendsEnabled: env.FB_FRIENDS === '1' });
  }
  if (!u) return json({ error: 'not_signed_in' }, 401);
  if (p === '/api/profile' && m === 'PUT') return saveProfile(req, env, u);
  if (p === '/api/coins/earn' && m === 'POST') return coinsEarn(req, env, u);
  if (p === '/api/coins/import' && m === 'POST') return coinsImport(req, env, u);
  if (p === '/api/shop/buy' && m === 'POST') return shopBuy(req, env, u);
  if (p === '/api/shop/equip' && m === 'POST') return shopEquip(req, env, u);
  if (p === '/api/share' && m === 'POST') return createShare(req, env, url, u);
  if (p === '/api/friends' && m === 'GET') return friendsList(env, u);
  if (p === '/api/friends/request' && m === 'POST') return friendRequest(req, env, u);
  if (p === '/api/friends/respond' && m === 'POST') return friendRespond(req, env, u);
  if (p === '/api/friends/remove' && m === 'POST') return friendRemove(req, env, u);
  if (p === '/api/match/start' && m === 'POST') return matchStart(req, env, u);
  if (p === '/api/match/finish' && m === 'POST') return matchFinish(req, env, u);
  if (p === '/api/account' && m === 'DELETE') {
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(url, 'ba_sess', '', 0) });
  }
  return json({ error: 'not_found' }, 404);
}
async function body(req, max = 4096) { try { const t = await req.text(); return t.length > max ? {} : JSON.parse(t); } catch (e) { return {}; } }

async function saveProfile(req, env, u) {
  const b = await body(req), cur = JSON.parse(u.profile || '{}');
  const n = (v, max) => Math.max(0, Math.min(max, Math.floor(+v || 0)));
  // progress only moves forward, and XP can't jump more than one big match at a time
  const newAch = (Array.isArray(b.ach) ? b.ach : []).filter(a => ACHIEVEMENTS.includes(a) && !(cur.ach || []).includes(a));
  const next = {
    xp: Math.max(cur.xp || 0, Math.min(n(b.xp, 1e7), (cur.xp || 0) + 800)),
    wins: Math.max(cur.wins || 0, Math.min(n(b.wins, 1e6), (cur.wins || 0) + 1)),
    games: Math.max(cur.games || 0, Math.min(n(b.games, 1e6), (cur.games || 0) + 1)),
    bestCombo: Math.max(cur.bestCombo || 0, n(b.bestCombo, 60)),
    classic: Math.max(cur.classic || 0, n(b.classic, 1e8)),
    ach: [...new Set([...(Array.isArray(cur.ach) ? cur.ach : []), ...(Array.isArray(b.ach) ? b.ach : [])].filter(a => ACHIEVEMENTS.includes(a)))],
    sprint: cur.sprint && b.sprint ? Math.min(cur.sprint, Math.max(15000, n(b.sprint, 36e5))) : (cur.sprint || (b.sprint ? Math.max(15000, n(b.sprint, 36e5)) : 0)),
  };
  // only the fields this call manages are written, and coins are added in the same statement, so a
  // coin payout or purchase landing at the same moment is never overwritten
  const bonus = [...new Set(newAch)].length * ACH_COINS;
  await env.DB.prepare(`UPDATE users SET profile = json_set(COALESCE(profile, '{}'), '$.xp', ?, '$.wins', ?, '$.games', ?, '$.bestCombo', ?, '$.classic', ?, '$.sprint', ?, '$.ach', json(?),
      '$.coins', COALESCE(json_extract(profile, '$.coins'), 0) + ?), updated_at = ? WHERE id = ?`)
    .bind(next.xp, next.wins, next.games, next.bestCombo, next.classic, next.sprint, JSON.stringify(next.ach), bonus, now(), u.id).run();
  return json({ profile: next, coinsAdded: bonus });
}

// ---------- coins and the shop ----------
// Coins live in the profile: { coins, owned: [ids], eq: { block, ghost, fx, bg }, earn: { day, n, t } }.
// Match payouts are worked out by the game and capped here: per match, by time between matches, and per day.
const wallet = pr => ({ coins: pr.coins || 0, owned: pr.owned || [], eq: { ...DEFAULTS, ...(pr.eq || {}) } });
const freshProfile = async (env, u) => JSON.parse((await env.DB.prepare('SELECT profile FROM users WHERE id = ?').bind(u.id).first())?.profile || '{}');
async function coinsEarn(req, env, u) {
  const b = await body(req), pr = await freshProfile(env, u), t = now(), day = Math.floor(t / 864e5);
  const e = pr.earn && pr.earn.day === day ? pr.earn : { day, n: 0, t: 0 };
  let amt = Math.max(0, Math.min(MAX_PER_MATCH, Math.floor(+b.amount || 0)));
  if (t - (e.t || 0) < MIN_GAP_MS) amt = 0;
  amt = Math.min(amt, Math.max(0, DAILY_CAP - e.n));
  const earn = { day, n: e.n + amt, t: amt ? t : e.t };
  await env.DB.prepare(`UPDATE users SET profile = json_set(COALESCE(profile, '{}'), '$.coins', COALESCE(json_extract(profile, '$.coins'), 0) + ?, '$.earn', json(?)), updated_at = ? WHERE id = ?`)
    .bind(amt, JSON.stringify(earn), t, u.id).run();
  return json({ added: amt, capped: amt < Math.floor(+b.amount || 0), ...wallet(await freshProfile(env, u)) });
}
// a guest's coins and items move to their account the first time they sign in (once, capped)
async function coinsImport(req, env, u) {
  const b = await body(req), pr = await freshProfile(env, u);
  if (pr.imported) return json({ ...wallet(pr), imported: false });
  const add = Math.max(0, Math.min(3000, Math.floor(+b.coins || 0)));
  const owned = [...new Set([...(pr.owned || []), ...(Array.isArray(b.owned) ? b.owned : []).filter(id => id in PRICES && PRICES[id] > 0)])];
  const r = await env.DB.prepare(`UPDATE users SET profile = json_set(COALESCE(profile, '{}'), '$.imported', json('true'), '$.coins', COALESCE(json_extract(profile, '$.coins'), 0) + ?, '$.owned', json(?)), updated_at = ?
      WHERE id = ? AND json_extract(profile, '$.imported') IS NULL`).bind(add, JSON.stringify(owned), now(), u.id).run();
  return json({ ...wallet(await freshProfile(env, u)), imported: r.meta.changes > 0 });
}
async function shopBuy(req, env, u) {
  const id = String((await body(req)).id || ''), pr = await freshProfile(env, u);
  if (!(id in PRICES)) return json({ error: 'unknown_item' }, 400);
  const w = wallet(pr);
  if (PRICES[id] === 0 || w.owned.includes(id)) return json({ ...w, already: true });
  if (w.coins < PRICES[id]) return json({ error: 'not_enough', ...w }, 400);
  // the balance check happens inside the update, so two quick taps can't spend the same coins twice
  const r = await env.DB.prepare(`UPDATE users SET profile = json_set(COALESCE(profile, '{}'), '$.coins', COALESCE(json_extract(profile, '$.coins'), 0) - ?, '$.owned', json(?), '$.eq', json(?)), updated_at = ?
      WHERE id = ? AND COALESCE(json_extract(profile, '$.coins'), 0) >= ?`)
    .bind(PRICES[id], JSON.stringify([...w.owned, id]), JSON.stringify({ ...w.eq, [id.split(':')[0]]: id }), now(), u.id, PRICES[id]).run();   // buying equips it
  const w2 = wallet(await freshProfile(env, u));
  return r.meta.changes ? json(w2) : json({ error: 'not_enough', ...w2 }, 400);
}
async function shopEquip(req, env, u) {
  const id = String((await body(req)).id || ''), pr = await freshProfile(env, u), slot = id.split(':')[0];
  if (!(id in PRICES) || !SLOTS.includes(slot)) return json({ error: 'unknown_item' }, 400);
  const w = wallet(pr);
  if (PRICES[id] > 0 && !w.owned.includes(id)) return json({ error: 'not_owned' }, 400);
  await env.DB.prepare(`UPDATE users SET profile = json_set(COALESCE(profile, '{}'), '$.eq', json(?)), updated_at = ? WHERE id = ?`).bind(JSON.stringify({ ...w.eq, [slot]: id }), now(), u.id).run();
  return json(wallet(await freshProfile(env, u)));
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
// ---------- share cards ----------
// The game draws a 1200×630 card (rank, match result or achievement) and uploads it. /s/<id> is the link people
// share: Facebook reads its preview tags, people who click it land in the game.
async function createShare(req, env, url, u) {
  const b = await body(req, 900000);
  const kind = ['rank', 'match', 'achievement'].includes(b.kind) ? b.kind : null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.png || ''));
  if (!kind || !m) return json({ error: 'bad_request' }, 400);
  const bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
  if (bytes.length > 650000 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return json({ error: 'bad_image' }, 400);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM shares WHERE user_id = ? AND created_at > ?').bind(u.id, now() - 864e5).first();
  if ((recent?.c || 0) >= 30) return json({ error: 'too_many' }, 429);
  const id = rand(8), clean = (t, n) => String(t || '').replace(/[<>"&]/g, '').slice(0, n);
  await env.DB.prepare('INSERT INTO shares (id, user_id, kind, title, description, png, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, u.id, kind, clean(b.title, 90) || 'Block Arena', clean(b.description, 200) || 'Play Block Arena with me', bytes, now()).run();
  return json({ id, url: `${url.origin}/s/${id}` });
}
async function sharePage(req, env, url, p) {
  const m = /^\/s\/([a-f0-9]{16})(\.png)?$/.exec(p);
  if (!m) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare('SELECT id, title, description, png, kind FROM shares WHERE id = ?').bind(m[1]).first();
  if (!row) return redirect('/');
  if (m[2]) return new Response(new Uint8Array(row.png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  const img = `${url.origin}/s/${row.id}.png`, link = `${url.origin}/s/${row.id}`;
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${row.title}</title>
<meta property="og:type" content="website"><meta property="og:site_name" content="Block Arena">
<meta property="og:title" content="${row.title}"><meta property="og:description" content="${row.description}">
<meta property="og:url" content="${link}"><meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
${env.FB_APP_ID ? `<meta property="fb:app_id" content="${env.FB_APP_ID}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=/?ref=share">
</head><body style="background:#04050b;color:#fff;font-family:system-ui;text-align:center;padding:40px 16px">
<img src="${img}" alt="" style="max-width:100%;border:3px solid #27356f"><p><a href="/?ref=share" style="color:#ffd21a">Play Block Arena</a></p></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
// ---------- friends, presence and invites ----------
// A friend code is the user id in base 36 plus two check characters, so typos are caught.
const MAX_PENDING = 50;
async function friendCode(id) { return (id.toString(36) + (await sha256('ba-friend-' + id)).slice(0, 2)).toUpperCase(); }
async function parseCode(code) {
  const c = String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (c.length < 3 || c.length > 12) return null;
  const id = parseInt(c.slice(0, -2), 36);
  return id > 0 && (await friendCode(id)).toLowerCase() === c ? id : null;
}
async function friendsList(env, u) {
  const [f, inc, out] = await env.DB.batch([
    env.DB.prepare('SELECT u.id, u.name, u.pic, u.rp FROM friendships f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY u.rp DESC LIMIT 300').bind(u.id),
    env.DB.prepare('SELECT u.id, u.name, u.pic, u.rp FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.created_at DESC LIMIT 50').bind(u.id),
    env.DB.prepare('SELECT u.id, u.name, u.pic, u.rp FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC LIMIT 50').bind(u.id),
  ]);
  const status = f.results.length ? await hubCall(env, '/status', { ids: f.results.map(r => r.id) }) : {};
  const pub = r => ({ id: r.id, name: r.name, pic: r.pic, rp: r.rp, rank: rankOf(r.rp).name });
  return json({
    code: await friendCode(u.id),
    friends: f.results.map(r => ({ ...pub(r), st: status[r.id]?.st || null, room: status[r.id]?.st === 'room' ? status[r.id].room : null })),
    incoming: inc.results.map(pub), outgoing: out.results.map(pub),
  });
}
async function makeFriends(env, a, b) {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').bind(a, b),
    env.DB.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').bind(b, a),
    env.DB.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').bind(a, b, b, a),
  ]);
}
async function friendRequest(req, env, u) {
  const b = await body(req);
  const id = b.code ? await parseCode(b.code) : Math.floor(+b.id || 0);
  if (!id) return json({ error: 'bad_code' }, 400);
  if (id === u.id) return json({ error: 'self' }, 400);
  const them = await env.DB.prepare('SELECT id, name FROM users WHERE id = ?').bind(id).first();
  if (!them) return json({ error: 'not_found' }, 404);
  if (await env.DB.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').bind(u.id, id).first()) return json({ status: 'friends', name: them.name });
  // they already asked me, so this is an accept
  if (await env.DB.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(id, u.id).first()) { await makeFriends(env, u.id, id); await hubCall(env, '/notify', { to: id, msg: { t: 'acc', id: u.id, name: u.name } }); return json({ status: 'friends', id, name: them.name }); }
  const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM friend_requests WHERE from_id = ?').bind(u.id).first();
  if (n.c >= MAX_PENDING) return json({ error: 'too_many' }, 429);
  await env.DB.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)').bind(u.id, id, now()).run();
  await hubCall(env, '/notify', { to: id, msg: { t: 'req', from: { id: u.id, name: u.name, pic: u.pic } } });
  return json({ status: 'sent', id, name: them.name });
}
async function friendRespond(req, env, u) {
  const b = await body(req), id = Math.floor(+b.id || 0);
  const r = await env.DB.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(id, u.id).first();
  if (!r) return json({ error: 'not_found' }, 404);
  if (b.accept) { await makeFriends(env, u.id, id); await hubCall(env, '/notify', { to: id, msg: { t: 'acc', id: u.id, name: u.name } }); }
  else await env.DB.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(id, u.id).run();
  return json({ ok: true });
}
async function friendRemove(req, env, u) {
  const id = Math.floor(+(await body(req)).id || 0);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').bind(u.id, id, id, u.id),
    env.DB.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').bind(u.id, id, id, u.id),
  ]);
  await hubCall(env, '/notify', { to: id, msg: { t: 'unfriend', id: u.id } });
  return json({ ok: true });
}
async function leaderboard(req, env, url) {
  const limit = Math.max(1, Math.min(100, +url.searchParams.get('limit') || 50));
  const u = await currentUser(req, env);
  const friends = url.searchParams.get('scope') === 'friends' && u;
  const { results } = friends
    ? await env.DB.prepare('SELECT id, name, pic, rp, ranked_games, ranked_wins FROM users WHERE id = ? OR id IN (SELECT friend_id FROM friendships WHERE user_id = ?) ORDER BY rp DESC, updated_at ASC LIMIT ?').bind(u.id, u.id, limit).all()
    : await env.DB.prepare('SELECT id, name, pic, rp, ranked_games, ranked_wins FROM users WHERE ranked_games > 0 ORDER BY rp DESC, updated_at ASC LIMIT ?').bind(limit).all();
  let me = null;
  if (u) {
    const pos = await env.DB.prepare('SELECT COUNT(*) AS c FROM users WHERE ranked_games > 0 AND rp > ?').bind(u.rp).first();
    me = { ...publicUser(u), position: u.ranked_games > 0 ? (pos.c + 1) : null };
  }
  if (friends && me) me.position = results.findIndex(r => r.id === u.id) + 1 || null;
  return json({ scope: friends ? 'friends' : 'global', top: results.map((r, i) => ({ position: i + 1, id: r.id, name: r.name, pic: r.pic, rp: r.rp, rank: rankOf(r.rp).name, tier: rankOf(r.rp).tier, games: r.ranked_games, wins: r.ranked_wins })), me });
}
