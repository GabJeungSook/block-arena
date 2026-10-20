// Room: one Durable Object per room name. It relays live match traffic between the players in it.
// Each player keeps one presence object (board snapshot, nickname, scores); the room merges patches
// and forwards the whole object to everyone else. Topic messages (`start`) go to everyone, sender included.
//
// Keeping the room clean:
//  - one seat per account: if the same account connects again (a phone that dropped and reconnected), the new
//    connection takes over the old seat, with the same peer id, so a match in progress carries on;
//  - silent connections time out: games send a small "ping" every 15 s, and anyone silent for 40 s is removed;
//  - the host (whoever joined first) can remove a player, who then can't rejoin this room for 10 minutes.
const MAX_PRESENCE = 4096, MAX_MSG = 8192, MAX_PEERS = 6, RATE = 20; // matches are up to 6 players; normal play sends ~10 messages/s
const STALE_MS = 40000, SWEEP_MS = 15000, BAN_MS = 10 * 60000;
const CLOSE_REPLACED = 4001, CLOSE_KICKED = 4002, CLOSE_STALE = 4003;

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.presence = new Map();   // peer -> full presence (memory; rebuilt from live updates after a wake-up)
    this.recent = new Map();     // account -> its last seat, for 5 minutes after it drops, so a reconnect gets the same seat back
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) {}
  }
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const by = req.headers.get('X-BA-User') || null;
    if (by) {
      const until = await this.ctx.storage.get('ban:' + by);
      if (until && until > Date.now()) return new Response('Removed by the host', { status: 403 });
    }
    // the same account already has a seat here: take it over (same peer id, same presence)
    const old = by ? this.live().find(ws => (ws.deserializeAttachment() || {}).by === by) : null;
    if (!old && this.live().length >= MAX_PEERS) return new Response('Room is full', { status: 429 });
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    let peer = crypto.randomUUID().replace(/-/g, '').slice(0, 16), lite = {};
    const back = !old && by ? this.recent.get(by) : null;
    if (back && Date.now() - back.t < 5 * 60000) { peer = back.peer; lite = back.lite || {}; }
    if (by) this.recent.delete(by);
    if (old) {
      const oa = old.deserializeAttachment() || {};
      peer = oa.peer; lite = oa.lite || {};
      oa.replaced = true; try { old.serializeAttachment(oa); } catch (e) {}
      try { old.close(CLOSE_REPLACED, 'replaced'); } catch (e) {}
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peer, by, lite, n: 0, t: 0, seen: Date.now() });
    const peers = this.ctx.getWebSockets().filter(ws => ws !== server && ws !== old).map(ws => this.describe(ws));
    server.send(JSON.stringify({ t: 'hello', peer, by, peers }));
    if (!old) this.broadcast({ t: 'join', peer, by, presence: lite }, server);
    await this.arm();
    return new Response(null, { status: 101, webSocket: client });
  }
  describe(ws) {
    const a = ws.deserializeAttachment() || {};
    return { peer: a.peer, by: a.by || null, presence: this.presence.get(a.peer) || a.lite || {} };
  }
  live() { return this.ctx.getWebSockets().filter(ws => !(ws.deserializeAttachment() || {}).replaced); }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.live()) if (ws !== except) { try { ws.send(s); } catch (e) {} }
  }
  // the host is whoever joined first (join time in presence), ties broken by peer id: the same rule the game uses
  hostPeer() {
    const ps = this.live().map(ws => { const a = ws.deserializeAttachment() || {}; const pr = this.presence.get(a.peer) || a.lite || {}; return { peer: a.peer, jt: +pr.jt || 9e15 }; });
    ps.sort((x, y) => (x.jt - y.jt) || (x.peer < y.peer ? -1 : 1));
    return ps[0]?.peer || null;
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    const a = ws.deserializeAttachment() || {};
    if (a.replaced) return;
    const now = Date.now();
    a.seen = now;
    if (now - a.t > 1000) { a.t = now; a.n = 0; }
    if (++a.n > RATE) { ws.serializeAttachment(a); return; }
    let m; try { m = JSON.parse(raw); } catch (e) { ws.serializeAttachment(a); return; }
    if (m && m.t === 'p' && m.d && typeof m.d === 'object') {
      const cur = { ...(this.presence.get(a.peer) || a.lite || {}) };
      for (const k of Object.keys(m.d)) { if (m.d[k] === null) delete cur[k]; else cur[k] = m.d[k]; }
      if (JSON.stringify(cur).length > MAX_PRESENCE) { ws.serializeAttachment(a); return; }
      this.presence.set(a.peer, cur);
      // a small copy survives hibernation, so late joiners still see names in the lobby
      a.lite = { nick: cur.nick, st: cur.st, mid: cur.mid, jt: cur.jt, rules: cur.rules, rbots: cur.rbots, size: cur.size, pic: cur.pic };
      if (JSON.stringify(a.lite).length > 1200) a.lite = { nick: String(cur.nick || '').slice(0, 20), st: cur.st, mid: cur.mid, jt: cur.jt };   // attachments must stay small
      ws.serializeAttachment(a);
      this.broadcast({ t: 'p', peer: a.peer, d: cur }, ws);
    } else if (m && m.t === 'e' && typeof m.topic === 'string' && /^[a-z][a-z0-9_.-]{0,47}$/.test(m.topic)) {
      ws.serializeAttachment(a);
      this.broadcast({ t: 'e', peer: a.peer, by: a.by || null, topic: m.topic, data: m.data ?? null });
    } else if (m && m.t === 'kick' && typeof m.peer === 'string') {
      ws.serializeAttachment(a);
      if (this.hostPeer() !== a.peer || m.peer === a.peer) { try { ws.send(JSON.stringify({ t: 'kickfail' })); } catch (e) {} return; }
      const target = this.live().find(w => (w.deserializeAttachment() || {}).peer === m.peer);
      if (!target) return;
      const ta = target.deserializeAttachment() || {};
      if (ta.by) await this.ctx.storage.put('ban:' + ta.by, Date.now() + BAN_MS);
      this.drop(target, CLOSE_KICKED, 'kicked');
    } else ws.serializeAttachment(a);
  }
  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }
  leave(ws) {
    const a = ws.deserializeAttachment() || {};
    try { ws.close(1000, 'bye'); } catch (e) {}
    if (a.replaced) return;                 // its seat already belongs to the new connection
    this.remember(a);
    this.presence.delete(a.peer);
    this.broadcast({ t: 'leave', peer: a.peer }, ws);
  }
  drop(ws, code, why) {
    const a = ws.deserializeAttachment() || {};
    a.replaced = true; try { ws.serializeAttachment(a); } catch (e) {}   // so the close event doesn't announce it twice
    try { ws.close(code, why); } catch (e) {}
    if (code !== CLOSE_KICKED) this.remember(a);
    this.presence.delete(a.peer);
    this.broadcast({ t: 'leave', peer: a.peer }, ws);
  }
  remember(a) {
    if (!a.by) return;
    this.recent.set(a.by, { peer: a.peer, lite: a.lite || {}, t: Date.now() });
    if (this.recent.size > 50) this.recent.delete(this.recent.keys().next().value);
  }
  async arm() { if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS); }
  // every 15 s while anyone is here: remove connections that have gone silent (a phone that lost signal never says goodbye)
  async alarm() {
    const now = Date.now(), all = this.live();
    for (const ws of all) {
      const a = ws.deserializeAttachment() || {};
      let auto = 0; try { auto = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0; } catch (e) {}
      if (now - Math.max(a.seen || 0, auto) > STALE_MS) this.drop(ws, CLOSE_STALE, 'timeout');
    }
    if (this.live().length) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    else {
      // empty room: forget expired bans
      const bans = await this.ctx.storage.list({ prefix: 'ban:' });
      const old = [...bans].filter(([, v]) => v < now).map(([k]) => k);
      if (old.length) await this.ctx.storage.delete(old);
    }
  }
}
