// Block Arena server (Cloudflare Worker).
//   /auth/google              → Google sign-in (the sign-in the game uses); /auth/google/callback finishes it
//   /auth/facebook            → Facebook login dialog (kept for later; Meta requires business verification to go public)
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
//   /api/chat*                → private chat between friends (history, send, mark read)
//   /api/friends*             → in-game friends: friend codes, requests, list with who's online
//   /hub                      → WebSocket to the Hub (online status, room invites, friend requests in real time)
//   /api/track/ping|match POST → anonymous play stats (who's playing now, matches per mode), guests included
//   /api/admin/stats          → numbers for the private stats page at /admin (administrators only)
// Everything else is the game itself, served from /public.
import { rankOf, rpDelta, applyDelta } from './rank.js';
import { PRICES, SLOTS, DEFAULTS, MAX_PER_MATCH, MIN_GAP_MS, DAILY_CAP, ACH_COINS, COINS_PER_SEC, GUEST_IMPORT } from './shop.js';
export { Room } from './room.js';
export { Hub } from './hub.js';

const GRAPH = 'https://graph.facebook.com/v25.0';
const DIALOG = 'https://www.facebook.com/v25.0/dialog/oauth';
const SESSION_DAYS = 60;
const MIN_MATCH_MS = 20000, MAX_MATCH_MS = 15 * 60000;
const RP_DAILY_CAP = 300;    // most rank points one account can gain in a day
// Administrators (the stats page). Google tells us the email at sign-in; we compare its SHA-256 here and never store it.
// More admins: add their hash here, or list emails in an ADMIN_EMAILS variable (comma separated) in the dashboard.
const ADMIN_EMAIL_HASHES = ['cde02621d81cbb0797099f0a55b3623f960cacf14e40dc21137f98fb1152040c'];
// Stats days start at midnight in this time zone (minutes from UTC; Philippines = 480). Override with STATS_TZ_MINUTES.
const tzMs = env => (Number.isFinite(+env.STATS_TZ_MINUTES) && env.STATS_TZ_MINUTES !== undefined ? +env.STATS_TZ_MINUTES : 480) * 60000;
const dayOf = (env, t) => Math.floor((t + tzMs(env)) / 864e5);
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
    env.DB.prepare('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS messages_pair ON messages (from_id, to_id, created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS messages_unseen ON messages (to_id, seen)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS messages_age ON messages (created_at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS admins (user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE)'),
    // one row per visitor per day: vid is a random id the game makes fresh every day, uid is set when signed in
    env.DB.prepare('CREATE TABLE IF NOT EXISTS daily (day INTEGER NOT NULL, vid TEXT NOT NULL, uid INTEGER REFERENCES users (id) ON DELETE SET NULL, first_ts INTEGER NOT NULL, PRIMARY KEY (day, vid))'),
    // one row per finished match in any mode
    env.DB.prepare('CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL, ts INTEGER NOT NULL, mode TEXT NOT NULL, size INTEGER NOT NULL, won INTEGER NOT NULL, ms INTEGER NOT NULL, vid TEXT NOT NULL, uid INTEGER REFERENCES users (id) ON DELETE SET NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS plays_day ON plays (day)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS plays_vid ON plays (vid, ts)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS counters (day INTEGER NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, key))'),
    // per-player daily counts (matches played, rank points gained, friend requests sent)
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ucounters (day INTEGER NOT NULL, uid INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, uid, key))'),
  ]);
  schemaReady = true;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/s/') || p.startsWith('/room/') || p === '/hub') await ensureSchema(env);
      if (p.startsWith('/s/')) return await sharePage(req, env, url, p);
      if (p === '/auth/google') return googleStart(req, env, url);
      if (p === '/auth/google/callback') return await googleCallback(req, env, url);
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
function timingSafeEq(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function cookies(req) { const out = {}; for (const part of (req.headers.get('Cookie') || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out; }
const secure = url => url.protocol === 'https:' ? '; Secure' : '';
const setCookie = (url, name, val, maxAge) => `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(url)}`;
// "back to" paths after sign-in: anything that doesn't resolve to this site becomes "/"
function safeBack(url, v) {
  if (!v || typeof v !== 'string' || v[0] !== '/') return '/';
  // always hand back a full same-site address: a bare path like //evil.com would otherwise leave the site
  try { const t = new URL(v, url.origin); return t.origin === url.origin ? t.origin + t.pathname.replace(/^\/+/, '/') + t.search : '/'; } catch (e) { return '/'; }
}
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
  const back = safeBack(url, url.searchParams.get('back'));
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
  const back = safeBack(url, cookies(req).ba_back);
  const res = await startSession(env, url, user.id, back + (back.includes('?') ? '&' : '?') + 'login=ok');
  res.headers.append('Set-Cookie', clear);
  res.headers.append('Set-Cookie', setCookie(url, 'ba_back', '', 0));
  return res;
}
// ---------- Google sign-in (OpenID Connect, server-side code flow) ----------
// Only the basic scopes: name, picture and email. These need no Google app verification.
// The email is used once, to recognise the game's administrator, and is never stored.
// Accounts are stored with a "g:" prefix on the provider id, so they never collide with Facebook ids.
function googleStart(req, env, url) {
  if (!env.GOOGLE_CLIENT_ID) return new Response('Google sign-in is not configured yet (GOOGLE_CLIENT_ID missing).', { status: 503 });
  const state = rand(16), back = safeBack(url, url.searchParams.get('back'));
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/auth/google/callback`, response_type: 'code', scope: 'openid profile email', state, prompt: 'select_account' });
  const res = redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, { 'Set-Cookie': setCookie(url, 'ba_state', state, 600) });
  res.headers.append('Set-Cookie', setCookie(url, 'ba_back', back, 600));
  return res;
}
async function googleCallback(req, env, url) {
  const state = url.searchParams.get('state'), code = url.searchParams.get('code');
  const clear = setCookie(url, 'ba_state', '', 0);
  if (!code || !state || state !== cookies(req).ba_state) return redirect('/?login=failed', { 'Set-Cookie': clear });
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET || '', redirect_uri: `${url.origin}/auth/google/callback`, grant_type: 'authorization_code' }),
  });
  const tok = await tr.json().catch(() => ({}));
  if (!tok.access_token) return redirect('/?login=failed', { 'Set-Cookie': clear });
  const mr = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const me = await mr.json().catch(() => ({}));
  if (!me.sub) return redirect('/?login=failed', { 'Set-Cookie': clear });
  const user = await upsertUser(env, 'g:' + me.sub, String(me.name || me.given_name || 'Player').slice(0, 40), me.picture ? String(me.picture).replace(/=s\d+-c$/, '=s128-c') : null);
  if (me.email && me.email_verified !== false && await isAdminEmail(env, me.email)) await env.DB.prepare('INSERT OR IGNORE INTO admins (user_id) VALUES (?)').bind(user.id).run();
  else if (me.email) await env.DB.prepare('DELETE FROM admins WHERE user_id = ?').bind(user.id).run();
  const back = safeBack(url, cookies(req).ba_back);
  const res = await startSession(env, url, user.id, back + (back.includes('?') ? '&' : '?') + 'login=ok');
  res.headers.append('Set-Cookie', clear);
  res.headers.append('Set-Cookie', setCookie(url, 'ba_back', '', 0));
  return res;
}
async function isAdminEmail(env, email) {
  const e = String(email).trim().toLowerCase();
  if (String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean).includes(e)) return true;
  return ADMIN_EMAIL_HASHES.includes(await sha256(e));
}
const isAdmin = async (env, u) => !!u && !!(await env.DB.prepare('SELECT 1 FROM admins WHERE user_id = ?').bind(u.id).first());
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
  if (url.searchParams.get('admin') === '1') await env.DB.prepare('INSERT OR IGNORE INTO admins (user_id) VALUES (?)').bind(user.id).run();
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
  let got, data;
  try { got = [...b64(sig)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); } catch (e) { return json({ error: 'bad_request' }, 400); }
  if (got.length !== expect.length || !timingSafeEq(got, expect)) return json({ error: 'bad_signature' }, 400);
  try { data = JSON.parse(b64(payload)); } catch (e) { return json({ error: 'bad_request' }, 400); }
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
  let name; try { name = decodeURIComponent(p.slice(6)); } catch (e) { return new Response('Bad room name', { status: 400 }); }
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
  if (p === '/api/track/ping' && m === 'POST') return trackPing(req, env, u);
  if (p === '/api/track/match' && m === 'POST') return trackMatch(req, env, u);
  if (p === '/api/admin/stats' && m === 'GET') return (await isAdmin(env, u)) ? adminStats(env, url) : json({ error: 'forbidden' }, 403);
  if (p === '/api/me' && m === 'GET') {
    const login = env.GOOGLE_CLIENT_ID ? 'google' : env.FB_APP_ID ? 'facebook' : null;
    if (!u) return json({ user: null, fbConfigured: !!login, login, appId: env.FB_APP_ID || null, friendsEnabled: env.FB_FRIENDS === '1' });
    const fc = await env.DB.prepare('SELECT COUNT(*) AS c FROM friendships WHERE user_id = ?').bind(u.id).first();
    return json({ user: { ...publicUser(u), admin: await isAdmin(env, u), via: String(u.fb_id).startsWith('g:') ? 'Google' : String(u.fb_id).startsWith('dev-') ? 'test login' : 'Facebook', friends: fc?.c || 0 }, profile: JSON.parse(u.profile || '{}'), fbConfigured: true, login, appId: env.FB_APP_ID, friendsEnabled: env.FB_FRIENDS === '1' });
  }
  if (!u) return json({ error: 'not_signed_in' }, 401);
  if (p === '/api/profile' && m === 'PUT') return saveProfile(req, env, u);
  if (p === '/api/coins/earn' && m === 'POST') return coinsEarn(req, env, u);
  if (p === '/api/coins/import' && m === 'POST') return coinsImport(req, env, u);
  if (p === '/api/shop/buy' && m === 'POST') return shopBuy(req, env, u);
  if (p === '/api/shop/equip' && m === 'POST') return shopEquip(req, env, u);
  if (p === '/api/share' && m === 'POST') return createShare(req, env, url, u);
  if (p === '/api/friends' && m === 'GET') return friendsList(env, u);
  if (p === '/api/chat' && m === 'GET') return chatHistory(env, u, url);
  if (p === '/api/chat/send' && m === 'POST') return chatSend(req, env, u);
  if (p === '/api/chat/read' && m === 'POST') return chatRead(req, env, u);
  if (p === '/api/friends/request' && m === 'POST') return friendRequest(req, env, u);
  if (p === '/api/friends/respond' && m === 'POST') return friendRespond(req, env, u);
  if (p === '/api/friends/remove' && m === 'POST') return friendRemove(req, env, u);
  if (p === '/api/match/start' && m === 'POST') return matchStart(req, env, u);
  if (p === '/api/match/finish' && m === 'POST') return matchFinish(req, env, u);
  if (p === '/api/account' && m === 'DELETE') {
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
    await hubCall(env, '/kick', { uid: u.id });
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(url, 'ba_sess', '', 0) });
  }
  return json({ error: 'not_found' }, 404);
}
async function body(req, max = 4096) {
  try { const t = await req.text(); if (t.length > max) return {}; const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
}

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
  let bonus = [...new Set(newAch)].length * ACH_COINS;
  const sql = `UPDATE users SET profile = json_set(COALESCE(profile, '{}'), '$.xp', ?, '$.wins', ?, '$.games', ?, '$.bestCombo', ?, '$.classic', ?, '$.sprint', ?, '$.ach', json(?),
      '$.coins', COALESCE(json_extract(profile, '$.coins'), 0) + ?), updated_at = ? WHERE id = ?`;
  const args = [next.xp, next.wins, next.games, next.bestCombo, next.classic, next.sprint, JSON.stringify(next.ach)];
  // the coin bonus is paid only if nobody else saved achievements in the meantime (two saves can't both pay)
  const r1 = await env.DB.prepare(sql + ` AND json(COALESCE(json_extract(profile, '$.ach'), '[]')) = json(?)`).bind(...args, bonus, now(), u.id, JSON.stringify(Array.isArray(cur.ach) ? cur.ach : [])).run();
  if (!r1.meta.changes) { bonus = 0; await env.DB.prepare(sql).bind(...args, 0, now(), u.id).run(); }
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
  const asked = amt; let reason = '';
  if (t - (e.t || 0) < MIN_GAP_MS) { amt = 0; reason = 'too_soon'; }
  // coins come at the pace of real play: no more than ~1.25 a second since the last payout today
  if (e.t && amt > Math.floor((t - e.t) / 1000 * COINS_PER_SEC)) { amt = Math.floor((t - e.t) / 1000 * COINS_PER_SEC); reason = reason || 'pace'; }
  if (amt > DAILY_CAP - e.n) { amt = Math.max(0, DAILY_CAP - e.n); reason = 'daily'; }
  const earn = { day, n: e.n + amt, t: amt ? t : e.t };
  if (amt) {
    const r = await env.DB.prepare(`UPDATE users SET profile = json_set(COALESCE(profile, '{}'), '$.coins', COALESCE(json_extract(profile, '$.coins'), 0) + ?, '$.earn', json(?)), updated_at = ?
        WHERE id = ? AND COALESCE(json_extract(profile, '$.earn.t'), 0) = ? AND COALESCE(json_extract(profile, '$.earn.n'), 0) = ?`)
      .bind(amt, JSON.stringify(earn), t, u.id, pr.earn?.t || 0, pr.earn?.n || 0).run();
    if (!r.meta.changes) amt = 0;          // another payout landed first
    else await bump(env, 'coins', amt);
  }
  return json({ added: amt, capped: amt < asked, reason: amt < asked ? reason : '', ...wallet(await freshProfile(env, u)) });
}
// a guest's coins and items move to their account the first time they sign in (once, capped)
async function coinsImport(req, env, u) {
  const b = await body(req), pr = await freshProfile(env, u);
  if (pr.imported || now() - (u.created_at || 0) > 30 * 60000) return json({ ...wallet(pr), imported: false });   // only right after the account is made
  let budget = GUEST_IMPORT; const items = [];
  const wanted = [...new Set((Array.isArray(b.owned) ? b.owned : []).filter(id => id in PRICES && PRICES[id] > 0 && !(pr.owned || []).includes(id)))].sort((x, y) => PRICES[x] - PRICES[y]);
  for (const id of wanted) if (PRICES[id] <= budget) { items.push(id); budget -= PRICES[id]; }
  const add = Math.max(0, Math.min(budget, Math.floor(+b.coins || 0)));
  const owned = [...(pr.owned || []), ...items];
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
  // one statement: enough coins, not already owned, add the item, equip it
  const r = await env.DB.prepare(`UPDATE users SET profile = json_set(COALESCE(profile, '{}'),
        '$.coins', COALESCE(json_extract(profile, '$.coins'), 0) - ?,
        '$.owned', json_insert(COALESCE(json_extract(profile, '$.owned'), json('[]')), '$[#]', ?),
        '$.eq', json_patch(COALESCE(json_extract(profile, '$.eq'), json('{}')), json_object(?, ?))), updated_at = ?
      WHERE id = ? AND COALESCE(json_extract(profile, '$.coins'), 0) >= ?
        AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(users.profile, '$.owned'), json('[]'))) WHERE value = ?)`)
    .bind(PRICES[id], id, id.split(':')[0], id, now(), u.id, PRICES[id], id).run();
  const w2 = wallet(await freshProfile(env, u));
  if (r.meta.changes) { await bump(env, 'buys', 1); await bump(env, 'spent', PRICES[id]); }
  return r.meta.changes ? json(w2) : json({ error: 'not_enough', ...w2 }, 400);
}
async function shopEquip(req, env, u) {
  const id = String((await body(req)).id || ''), pr = await freshProfile(env, u), slot = id.split(':')[0];
  if (!(id in PRICES) || !SLOTS.includes(slot)) return json({ error: 'unknown_item' }, 400);
  const w = wallet(pr);
  if (PRICES[id] > 0 && !w.owned.includes(id)) return json({ error: 'not_owned' }, 400);
  await env.DB.prepare(`UPDATE users SET profile = json_set(COALESCE(profile, '{}'), '$.eq', json_patch(COALESCE(json_extract(profile, '$.eq'), json('{}')), json_object(?, ?))), updated_at = ? WHERE id = ?`).bind(slot, id, now(), u.id).run();
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
  if (age < MIN_MATCH_MS || age > MAX_MATCH_MS) {
    await env.DB.prepare('UPDATE matches SET finished_at = ?, place = 0, delta = 0 WHERE id = ? AND finished_at IS NULL').bind(now(), mt.id).run();
    return json({ error: 'bad_timing' }, 400);
  }
  const place = Math.max(1, Math.min(mt.size, Math.floor(+b.place || mt.size)));
  const draw = !!b.draw && mt.size === 2;
  let d = rpDelta({ kind: mt.kind, level: mt.level || 'normal', size: mt.size, place, draw }, u.rp);
  // results are reported by the game, so rank gains are capped per day: a cheater can't rocket to the top
  if (d > 0) {
    const g = await ucount(env, u.id, 'rp');
    d = Math.min(d, Math.max(0, RP_DAILY_CAP - (g?.n || 0)));
  }
  const rp = applyDelta(u.rp, d), real = rp - u.rp, win = place === 1 && !draw ? 1 : 0;
  const claim = await env.DB.prepare('UPDATE matches SET finished_at = ?, place = ?, delta = ? WHERE id = ? AND finished_at IS NULL').bind(now(), place, real, mt.id).run();
  if (!claim.meta.changes) return json({ error: 'unknown_match' }, 404);       // the same result sent twice counts once
  if (real > 0) await ubump(env, u.id, 'rp', real);
  await env.DB.prepare('UPDATE users SET rp = ?, peak_rp = MAX(peak_rp, ?), ranked_games = ranked_games + 1, ranked_wins = ranked_wins + ?, updated_at = ? WHERE id = ?').bind(rp, rp, win, now(), u.id).run();
  const before = rankOf(u.rp), after = rankOf(rp);
  return json({ delta: real, rp, before: before.name, after: after.name, promoted: rp > u.rp && after.name !== before.name, demoted: rp < u.rp && after.name !== before.name });
}
// ---------- share cards ----------
// The game draws a 1200×630 card (rank, match result or achievement) and uploads it. /s/<id> is the link people
// share: Facebook reads its preview tags, people who click it land in the game.
async function createShare(req, env, url, u) {
  const b = await body(req, 900000);
  const kind = ['rank', 'match', 'achievement'].includes(b.kind) ? b.kind : null;
  const m = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.png || ''));
  if (!kind || !m) return json({ error: 'bad_request' }, 400);
  let bytes;
  try { const bin = atob(m[1]); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch (e) { return json({ error: 'bad_image' }, 400); }
  const png = bytes[0] === 0x89 && bytes[1] === 0x50, jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (bytes.length > 300000 || !(png || jpg)) return json({ error: 'bad_image' }, 400);
  // the database is small (free tier), so cards are kept small, a few a day, for 30 days (Facebook caches them by then)
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM shares WHERE user_id = ? AND created_at > ?').bind(u.id, now() - 864e5).first();
  if ((recent?.c || 0) >= 5) return json({ error: 'too_many' }, 429);
  if (Math.random() < .2) await env.DB.prepare('DELETE FROM shares WHERE created_at < ?').bind(now() - 30 * 864e5).run();
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
  if (m[2]) { const img = new Uint8Array(row.png); return new Response(img, { headers: { 'Content-Type': img[0] === 0xff ? 'image/jpeg' : 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } }); }
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
  const { results: un } = await env.DB.prepare('SELECT from_id, COUNT(*) AS c FROM messages WHERE to_id = ? AND seen = 0 GROUP BY from_id').bind(u.id).all();
  const unread = Object.fromEntries(un.map(r => [r.from_id, r.c]));
  const pub = r => ({ id: r.id, name: r.name, pic: r.pic, rp: r.rp, rank: rankOf(r.rp).name });
  return json({
    code: await friendCode(u.id),
    friends: f.results.map(r => ({ ...pub(r), st: status[r.id]?.st || null, room: status[r.id]?.st === 'room' ? status[r.id].room : null, unread: unread[r.id] || 0 })),
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
  // no more than 30 new requests a day, so nobody can pester every player in turn
  if (((await ucount(env, u.id, 'frq'))?.n || 0) >= 30) return json({ error: 'too_many' }, 429);
  await ubump(env, u.id, 'frq', 1);
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
// ---------- chat between friends ----------
// Friends only, 200 characters, at most 6 messages per 10 seconds; strong swear words are masked.
// Messages are kept 30 days. Delivery is live through the hub when the friend is online.
const CHAT_MAX = 200, CHAT_KEEP = 30 * 864e5;
const SWEAR = /\b(f+u+c+k+\w*|sh+i+t+\w*|b+i+t+c+h+\w*|c+u+n+t+\w*|putang\s*ina\w*|tang\s*ina\w*|puta\b|gago\w*|kupal\w*)/gi;
const cleanChat = t => String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX).replace(SWEAR, w => w[0] + '*'.repeat(Math.max(1, w.length - 1)));
const areFriends = (env, a, b) => env.DB.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').bind(a, b).first();
async function chatHistory(env, u, url) {
  const id = Math.floor(+url.searchParams.get('with') || 0);
  if (!id || !await areFriends(env, u.id, id)) return json({ error: 'not_friends' }, 403);
  const before = Math.floor(+url.searchParams.get('before') || 0) || 9e15;
  const { results } = await env.DB.prepare(`SELECT id, from_id, body, created_at FROM messages
      WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND id < ? ORDER BY id DESC LIMIT 50`).bind(u.id, id, id, u.id, before).all();
  return json({ messages: results.reverse().map(r => ({ id: r.id, mine: r.from_id === u.id, text: r.body, ts: r.created_at })) });
}
async function chatSend(req, env, u) {
  const b = await body(req), id = Math.floor(+b.to || 0), text = cleanChat(b.text), t = now();
  if (!text) return json({ error: 'empty' }, 400);
  if (!id || !await areFriends(env, u.id, id)) return json({ error: 'not_friends' }, 403);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM messages WHERE from_id = ? AND created_at > ?').bind(u.id, t - 10000).first();
  if ((recent?.c || 0) >= 6) return json({ error: 'slow_down' }, 429);
  const r = await env.DB.prepare('INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?, ?, ?, ?)').bind(u.id, id, text, t).run();
  const msg = { id: r.meta.last_row_id, text, ts: t };
  await hubCall(env, '/notify', { to: id, msg: { t: 'dm', from: { id: u.id, name: u.name, pic: u.pic }, m: msg } });
  // old messages go, so the free database never fills up
  if (Math.random() < .05) await env.DB.prepare('DELETE FROM messages WHERE created_at < ?').bind(t - CHAT_KEEP).run();
  return json({ message: { ...msg, mine: true } });
}
async function chatRead(req, env, u) {
  const id = Math.floor(+(await body(req)).with || 0);
  await env.DB.prepare('UPDATE messages SET seen = 1 WHERE to_id = ? AND from_id = ? AND seen = 0').bind(u.id, id).run();
  return json({ ok: true });
}
async function leaderboard(req, env, url) {
  const limit = Math.max(1, Math.min(100, Math.floor(+url.searchParams.get('limit') || 50)));
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

// ---------- play stats ----------
// Every open game (guest or signed in) pings about once a minute while it's on screen, and reports each finished
// match. Nothing here identifies a guest: their id is random and the game replaces it every day.
// Everything is kept as daily totals (a handful of rows per day), so the free database never fills up and the
// stats page stays cheap to read. Guests add no rows at all.
const VID = /^[a-z0-9]{8,32}$/;
const TRACK_MODES = ['cpu', 'arena', 'survival', 'powerup', 'sprint', 'classic', 'local', 'online', 'quick'];
const bump = (env, key, n, day) => env.DB.prepare('INSERT INTO counters (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n').bind(day ?? dayOf(env, now()), key, n).run().catch(() => {});
const ubump = (env, uid, key, n) => env.DB.prepare('INSERT INTO ucounters (day, uid, key, n) VALUES (?, ?, ?, ?) ON CONFLICT (day, uid, key) DO UPDATE SET n = n + excluded.n').bind(dayOf(env, now()), uid, key, n).run().catch(() => {});
const ucount = (env, uid, key) => env.DB.prepare('SELECT n FROM ucounters WHERE day = ? AND uid = ? AND key = ?').bind(dayOf(env, now()), uid, key).first();
// a light per-address limit (per server instance) so a script can't burn through the daily database writes
const hits = new Map();
function tooMany(req, max) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local', t = now(), h = hits.get(ip);
  if (!h || t - h.t > 60000) { hits.set(ip, { t, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  return ++h.n > max;
}
async function trackPing(req, env, u) {
  const b = await body(req), vid = String(b.vid || '');
  if (!VID.test(vid)) return json({ error: 'bad_request' }, 400);
  if (tooMany(req, 30)) return json({ ok: true });
  const st = ['menu', 'room', 'match'].includes(b.st) ? b.st : 'menu';
  const r = await hubCall(env, '/ping', { key: 'v' + vid, st, uid: u ? u.id : 0, day: dayOf(env, now()) });
  if (u) {
    // one row per signed-in player per day
    await env.DB.prepare('INSERT OR IGNORE INTO daily (day, vid, uid, first_ts) VALUES (?, ?, ?, ?)').bind(dayOf(env, now()), 'u' + u.id, u.id, now()).run();
  } else if (r.fresh) await bump(env, 'guests', 1);      // a guest the Hub hasn't seen today
  return json({ ok: true });
}
const lastMatch = new Map();
async function trackMatch(req, env, u) {
  const b = await body(req), vid = String(b.vid || '');
  if (!VID.test(vid) || !TRACK_MODES.includes(b.mode)) return json({ error: 'bad_request' }, 400);
  const t = now(), key = u ? 'u' + u.id : vid;
  if (tooMany(req, 20) || t - (lastMatch.get(key) || 0) < 8000) return json({ ok: true, skipped: true });
  lastMatch.set(key, t); if (lastMatch.size > 5000) lastMatch.clear();
  const ms = Math.max(0, Math.min(36e5, Math.floor(+b.ms || 0)));
  await env.DB.batch([
    ...[['matches', 1], ['m:' + b.mode, 1], ['ms', ms]].map(([k, n]) => env.DB.prepare('INSERT INTO counters (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n').bind(dayOf(env, t), k, n)),
    env.DB.prepare('INSERT INTO counters (day, key, n) VALUES (0, ?, 1) ON CONFLICT (day, key) DO UPDATE SET n = n + 1').bind('matches'),     // lifetime total
    ...(u ? [env.DB.prepare('INSERT INTO ucounters (day, uid, key, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, uid, key) DO UPDATE SET n = n + 1').bind(dayOf(env, t), u.id, 'm')] : []),
  ]).catch(() => {});
  if (Math.random() < .01) {           // keep about a year of history
    const old = dayOf(env, t) - 400;
    await env.DB.batch(['daily', 'ucounters'].map(tb => env.DB.prepare(`DELETE FROM ${tb} WHERE day < ?`).bind(old)).concat(env.DB.prepare('DELETE FROM counters WHERE day > 0 AND day < ?').bind(old))).catch(() => {});
  }
  return json({ ok: true });
}
// The page asks for live numbers every 20 s (cheap: only the Hub) and for the history every 5 minutes;
// history is also kept for 5 minutes here, so leaving the page open all day costs almost nothing.
let statsCache = null;
async function adminStats(env, url) {
  const live = { online: 0, signedIn: 0, guests: 0, menu: 0, room: 0, match: 0, rooms: 0, quick: 0, ...(await hubCall(env, '/stats', {})) };
  if (url.searchParams.get('live') === '1') return json({ at: now(), live });
  if (!statsCache || now() - statsCache.at > 5 * 60000 || url.searchParams.get('fresh') === '1') statsCache = { at: now(), data: await statsHistory(env) };
  return json({ at: now(), cachedAt: statsCache.at, live, ...statsCache.data });
}
async function statsHistory(env) {
  const t = now(), today = dayOf(env, t), off = tzMs(env), q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const win = n => today - n + 1;
  const rows = (await env.DB.batch([
    q('SELECT COUNT(*) AS n FROM users'),
    q("SELECT n FROM counters WHERE day = 0 AND key = 'matches'"),
    ...[1, 7, 30].flatMap(n => [
      q('SELECT COUNT(DISTINCT uid) AS n FROM daily WHERE day >= ? AND uid IS NOT NULL', win(n)),
      q('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', (win(n) * 864e5) - off),
    ]),
    q('SELECT day, key, n FROM counters WHERE day >= ?', win(30)),
    q('SELECT day, COUNT(*) AS n FROM daily WHERE day >= ? AND uid IS NOT NULL GROUP BY day', win(30)),
    q('SELECT CAST((created_at + ?) / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day', off, (win(30) * 864e5) - off),
    q('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', t - 7 * 864e5),
    q('SELECT name, pic, rp, ranked_games AS games FROM users WHERE ranked_games > 0 ORDER BY rp DESC LIMIT 10'),
    q('SELECT name, pic, created_at FROM users ORDER BY created_at DESC LIMIT 8'),
    q("SELECT u.name, u.pic, SUM(c.n) AS n FROM ucounters c JOIN users u ON u.id = c.uid WHERE c.day >= ? AND c.key = 'm' GROUP BY c.uid ORDER BY n DESC LIMIT 8", win(7)),
  ])).map(x => x.results);
  const one = i => rows[i][0] || {};
  const C = rows[8], sumC = (key, from) => C.filter(c => c.key === key && c.day >= from).reduce((a, c) => a + c.n, 0);
  const windows = {};
  ['today', 'week', 'month'].forEach((k, i) => {
    const from = win([1, 7, 30][i]);
    windows[k] = { signedIn: one(2 + i * 2).n || 0, guestVisits: sumC('guests', from), newPlayers: one(3 + i * 2).n || 0, matches: sumC('matches', from), minutes: Math.round(sumC('ms', from) / 6e4) };
  });
  const by = list => Object.fromEntries(list.map(x => [x.day, x.n]));
  const signed = by(rows[9]), sig = by(rows[10]);
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = win(30) + i, g = C.find(c => c.day === d && c.key === 'guests')?.n || 0, s2 = signed[d] || 0;
    return { date: new Date(d * 864e5).toISOString().slice(0, 10), visitors: s2 + g, signedIn: s2, matches: C.find(c => c.day === d && c.key === 'matches')?.n || 0, signups: sig[d] || 0 };
  });
  const modes = Object.entries(C.filter(c => c.key.startsWith('m:') && c.day >= win(7)).reduce((a, c) => (a[c.key.slice(2)] = (a[c.key.slice(2)] || 0) + c.n, a), {})).map(([mode, n]) => ({ mode, n })).sort((a, b) => b.n - a.n);
  return {
    tzMinutes: off / 60000,
    totals: { players: one(0).n || 0, matches: one(1).n || 0 },
    windows, modes, days,
    economy: { coinsEarned: sumC('coins', win(7)), itemsBought: sumC('buys', win(7)), coinsSpent: sumC('spent', win(7)), chatMessages: one(11).n || 0 },
    top: rows[12].map(x => ({ ...x, rank: rankOf(x.rp).name })), newest: rows[13], busiest: rows[14],
  };
}
