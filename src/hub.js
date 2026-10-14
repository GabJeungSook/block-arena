// Hub: one Durable Object for the whole game that keeps a WebSocket open to every signed-in player.
// It knows who is online and what they're doing (menu, in a room, in a match), tells your friends when
// that changes, and delivers room invites and friend requests instantly. Sockets hibernate between
// messages, so an idle player costs nothing.
const MAX_MSG = 1024, MAX_FRIENDS = 150, RATE = 10;   // messages per 10 s per socket
const ST = ['menu', 'room', 'match'];

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    // keep-alive pings are answered without waking the object up
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) {}
  }
  socketsOf(uid) { return this.ctx.getWebSockets('u' + uid); }
  statusOf(uid, skip) {
    // a player may have several tabs open; report the "busiest" one
    let best = null;
    for (const ws of this.socketsOf(uid)) {
      if (ws === skip) continue;
      const a = ws.deserializeAttachment() || {};
      if (!best || ST.indexOf(a.st) > ST.indexOf(best.st)) best = { st: a.st || 'menu', room: a.room || null };
    }
    return best;
  }
  send(uid, obj) { const s = JSON.stringify(obj); for (const ws of this.socketsOf(uid)) { try { ws.send(s); } catch (e) {} } }
  tellFriends(uid, fr, skip) {
    const st = this.statusOf(uid, skip);
    for (const f of fr || []) this.send(f, { t: 'fr', id: uid, st: st ? st.st : null, room: st && st.st === 'room' ? st.room : null });
  }
  async friendsOf(uid) {
    const { results } = await this.env.DB.prepare('SELECT friend_id FROM friendships WHERE user_id = ? LIMIT ?').bind(uid, MAX_FRIENDS).all();
    return results.map(r => r.friend_id);
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') === 'websocket') {
      const uid = +req.headers.get('X-BA-User');
      if (!uid) return new Response('No user', { status: 401 });
      if (this.socketsOf(uid).length >= 5) return new Response('Too many tabs', { status: 429 });
      const fr = await this.friendsOf(uid);
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ['u' + uid]);
      server.serializeAttachment({ uid, st: 'menu', room: null, fr, n: 0, t: 0 });
      // who of my friends is online right now
      const online = {};
      for (const f of fr) { const s = this.statusOf(f); if (s) online[f] = s; }
      server.send(JSON.stringify({ t: 'hello', online }));
      this.tellFriends(uid, fr);
      return new Response(null, { status: 101, webSocket: client });
    }
    // internal calls from the Worker (Durable Objects aren't reachable from the internet)
    const b = await req.json().catch(() => ({}));
    if (url.pathname === '/status') {
      const out = {};
      for (const id of (b.ids || []).slice(0, 500)) { const s = this.statusOf(id); if (s) out[id] = s; }
      return Response.json(out);
    }
    if (url.pathname === '/notify') {
      // friend request / acceptance / removal
      const { to, msg } = b;
      if (msg?.t === 'acc' || msg?.t === 'unfriend') {
        // keep both players' friend lists in sync on their open sockets
        for (const [x, y] of [[to, msg.id], [msg.id, to]]) for (const ws of this.socketsOf(x)) {
          const a = ws.deserializeAttachment() || {}; const s = new Set(a.fr || []);
          if (msg.t === 'acc') s.add(y); else s.delete(y);
          a.fr = [...s].slice(0, MAX_FRIENDS); ws.serializeAttachment(a);
        }
        if (msg.t === 'acc') { const s1 = this.statusOf(msg.id), s2 = this.statusOf(to); if (s1) this.send(to, { t: 'fr', id: msg.id, st: s1.st, room: s1.room }); if (s2) this.send(msg.id, { t: 'fr', id: to, st: s2.st, room: s2.room }); }
      }
      this.send(to, msg);
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    const a = ws.deserializeAttachment() || {}, now = Date.now();
    if (now - a.t > 10000) { a.t = now; a.n = 0; }
    if (++a.n > RATE) { ws.serializeAttachment(a); return; }
    let m; try { m = JSON.parse(raw); } catch (e) { ws.serializeAttachment(a); return; }
    if (m.t === 'st' && ST.includes(m.st)) {
      const room = m.st === 'room' ? String(m.room || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || null : null;
      const changed = a.st !== m.st || a.room !== room;
      a.st = m.st; a.room = room; ws.serializeAttachment(a);
      if (changed) this.tellFriends(a.uid, a.fr);
    } else if (m.t === 'inv') {
      ws.serializeAttachment(a);
      const to = +m.to, room = String(m.room || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
      if (!room || !(a.fr || []).includes(to)) { ws.send(JSON.stringify({ t: 'invfail', to, why: 'not_friends' })); return; }
      if (!this.socketsOf(to).length) { ws.send(JSON.stringify({ t: 'invfail', to, why: 'offline' })); return; }
      const me = await this.env.DB.prepare('SELECT id, name, pic FROM users WHERE id = ?').bind(a.uid).first();
      this.send(to, { t: 'inv', from: me, room });
      ws.send(JSON.stringify({ t: 'invsent', to }));
    } else if (m.t === 'q' && (m.size === 2 || m.size === 6)) {
      a.q = { size: m.size, at: now }; ws.serializeAttachment(a);
      this.matchmake(m.size, false);
    } else if (m.t === 'qx') {
      const size = a.q?.size; a.q = null; ws.serializeAttachment(a); if (size) this.matchmake(size, false);
    } else if (m.t === 'qgo') {
      ws.serializeAttachment(a); if (a.q) this.matchmake(a.q.size, true);
    } else ws.serializeAttachment(a);
  }
  // ---- quick match ----
  // Players waiting for a quick match carry { q: { size, at } } on their socket, so the queue survives the
  // object sleeping. Full groups start at once; after 20 s a waiting player asks to start with whoever is
  // there ('qgo'), and bots fill the rest of the seats.
  matchmake(size, force) {
    const seen = new Set();
    const list = this.ctx.getWebSockets().map(ws => [ws, ws.deserializeAttachment() || {}])
      .filter(([, a]) => a.q && a.q.size === size).sort((x, y) => x[1].q.at - y[1].q.at)
      .filter(([, a]) => !seen.has(a.uid) && seen.add(a.uid));
    while (list.length >= size) this.makeMatch(list.splice(0, size), size);
    if (force && list.length) this.makeMatch(list.splice(0, list.length), size);
    const msg = JSON.stringify({ t: 'qn', n: list.length });
    for (const [ws] of list) { try { ws.send(msg); } catch (e) {} }
  }
  makeMatch(group, size) {
    const room = 'qm' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const msg = JSON.stringify({ t: 'match', room, size, n: group.length });
    for (const [ws, a] of group) {
      // the same player in another tab stops searching too
      for (const w2 of this.socketsOf(a.uid)) { const b = w2.deserializeAttachment() || {}; if (b.q) { b.q = null; w2.serializeAttachment(b); } }
      try { ws.send(msg); } catch (e) {}
    }
  }
  async webSocketClose(ws) { this.gone(ws); }
  async webSocketError(ws) { this.gone(ws); }
  gone(ws) {
    const a = ws.deserializeAttachment() || {};
    try { ws.close(1000, 'bye'); } catch (e) {}
    // only "offline" once their last tab is gone (statusOf skips this closing socket)
    if (a.uid) this.tellFriends(a.uid, a.fr, ws);
    if (a.q) { a.q = null; try { ws.serializeAttachment(a); } catch (e) {} this.matchmake(2, false); this.matchmake(6, false); }
  }
}
