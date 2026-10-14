// Room: one Durable Object per room name. It relays live match traffic between the players in it.
// Each player keeps one presence object (board snapshot, nickname, scores); the room merges patches
// and forwards the whole object to everyone else. Topic messages (`start`) go to everyone, sender included.
const MAX_PRESENCE = 4096, MAX_MSG = 8192, MAX_PEERS = 8, RATE = 60; // messages per second per player

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.presence = new Map();   // peer -> full presence (memory; rebuilt from live updates after a wake-up)
  }
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_PEERS) return new Response('Room is full', { status: 429 });
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    const peer = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const by = req.headers.get('X-BA-User') || null;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peer, by, lite: {}, n: 0, t: 0 });
    const peers = this.ctx.getWebSockets().filter(ws => ws !== server).map(ws => this.describe(ws));
    server.send(JSON.stringify({ t: 'hello', peer, by, peers }));
    this.broadcast({ t: 'join', peer, by, presence: {} }, server);
    return new Response(null, { status: 101, webSocket: client });
  }
  describe(ws) {
    const a = ws.deserializeAttachment() || {};
    return { peer: a.peer, by: a.by || null, presence: this.presence.get(a.peer) || a.lite || {} };
  }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) { try { ws.send(s); } catch (e) {} }
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    const a = ws.deserializeAttachment() || {};
    const now = Date.now();
    if (now - a.t > 1000) { a.t = now; a.n = 0; }
    if (++a.n > RATE) { ws.serializeAttachment(a); return; }
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m && m.t === 'p' && m.d && typeof m.d === 'object') {
      const cur = { ...(this.presence.get(a.peer) || a.lite || {}) };
      for (const k of Object.keys(m.d)) { if (m.d[k] === null) delete cur[k]; else cur[k] = m.d[k]; }
      if (JSON.stringify(cur).length > MAX_PRESENCE) return;
      this.presence.set(a.peer, cur);
      // a small copy survives hibernation, so late joiners still see names in the lobby
      a.lite = { nick: cur.nick, st: cur.st, mid: cur.mid, jt: cur.jt, rules: cur.rules, rbots: cur.rbots, size: cur.size };
      ws.serializeAttachment(a);
      this.broadcast({ t: 'p', peer: a.peer, d: cur }, ws);
    } else if (m && m.t === 'e' && typeof m.topic === 'string' && /^[a-z][a-z0-9_.-]{0,47}$/.test(m.topic)) {
      ws.serializeAttachment(a);
      this.broadcast({ t: 'e', peer: a.peer, by: a.by || null, topic: m.topic, data: m.data ?? null });
    } else ws.serializeAttachment(a);
  }
  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }
  leave(ws) {
    const a = ws.deserializeAttachment() || {};
    this.presence.delete(a.peer);
    this.broadcast({ t: 'leave', peer: a.peer }, ws);
    try { ws.close(1000, 'bye'); } catch (e) {}
  }
}
