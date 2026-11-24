// Garlic Phone — Cloudflare Worker + Durable Object (one Durable Object = one room)
//
// Normal mode, same rules as the original:
//   turn 1  everyone WRITES a sentence      (50 s)
//   turn 2  everyone DRAWS the sentence they got   (150 s)
//   turn 3  everyone DESCRIBES the drawing they got (40 s)   ... and so on, alternating,
//   one turn per player ("ALL"). Speed: FAST x0.5, NORMAL x1, SLOW x2, INFINITE (no clock).
//   A turn ends early when everybody has pressed DONE. Then the host shows every album.
//
// Cost design: this uses the WebSocket *Hibernation* API. While players are just
// drawing/typing the Durable Object is evicted from memory (no duration billing),
// pings are answered by the runtime without waking it, and all timers are alarms.

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 20;
const MAX_MSG = 900000;           // bytes in one websocket message
const MAX_IMG = 800000;           // bytes in one drawing (data URL)
const MAX_TEXT = 60;              // same limit as the original
const GRACE_MS = 4000;            // after the clock hits zero, wait for last-second submits
const LOBBY_DROP_MS = 8000;       // keep a disconnected lobby player this long (page refresh)
const AVATARS = 61;

const SPEED = { fast: 0.5, normal: 1, slow: 2, infinite: 0 };
const TURNS = { few: 0.5, most: 0.75, all: 1 };
const BASE_MS = { start: 50000, draw: 150000, write: 40000 }; // original constants (normal speed)

const rid = (n = 12) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join('');

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const cleanName = (s) =>
  String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
const cleanAvatar = (a) => (Number.isInteger(a) ? Math.max(0, Math.min(AVATARS - 1, a)) : 0);

function sanitize(kind, content) {
  if (typeof content !== 'string') return '';
  if (kind === 'draw') {
    if (!content || content.length > MAX_IMG) return '';
    return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(content) ? content : '';
  }
  return content.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

const fresh = () => ({
  players: [], hostId: null, phase: 'lobby',
  settings: { speed: 'normal', turns: 'all' },
  game: null, view: null, tasks: [],
});

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.s = fresh();
    // pings from clients are answered by the runtime without waking this object
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch { /* not in tests */ }
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('s');
      if (saved) this.s = saved;
    });
  }

  save() { return this.ctx.storage.put('s', this.s); }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- socket helpers ----------
  socketOf(pid) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.pid === pid) return ws;
    }
    return null;
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* dead socket */ } }
  sendTo(p, obj) { const ws = p.connected && this.socketOf(p.id); if (ws) this.send(ws, obj); }
  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.pid) { try { ws.send(msg); } catch { /* ignore */ } }
    }
  }
  fail(ws, msg) {
    this.send(ws, { t: 'error', msg, fatal: true });
    try { ws.close(1000, 'bye'); } catch { /* ignore */ }
  }

  // ---------- hibernation entry points ----------
  async webSocketMessage(ws, data) {
    await this.ready;
    if (typeof data !== 'string' || data.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const att = ws.deserializeAttachment();
    if (!att || !att.pid) {
      if (m.t === 'join') this.onJoin(ws, m);
      return;
    }
    const me = this.s.players.find((p) => p.id === att.pid);
    if (!me) return;
    this.onMessage(me, m);
  }

  async webSocketClose(ws) {
    await this.ready;
    const att = ws.deserializeAttachment();
    if (!att || !att.pid) return;
    // a newer socket may already have replaced this one
    const live = this.ctx.getWebSockets().some((o) => o !== ws && (o.deserializeAttachment() || {}).pid === att.pid);
    if (live) return;
    const p = this.s.players.find((x) => x.id === att.pid);
    if (p) this.onLeave(p);
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }

  // ---------- tasks (alarms) ----------
  schedule(kind, ms, arg) {
    this.s.tasks.push({ at: Date.now() + ms, kind, arg });
    this.arm();
  }
  cancel(kind) { this.s.tasks = this.s.tasks.filter((t) => t.kind !== kind); this.arm(); }
  arm() {
    if (!this.s.tasks.length) return this.ctx.storage.deleteAlarm();
    return this.ctx.storage.setAlarm(Math.min(...this.s.tasks.map((t) => t.at)));
  }
  async alarm() {
    await this.ready;
    const now = Date.now() + 20;
    const due = this.s.tasks.filter((t) => t.at <= now);
    this.s.tasks = this.s.tasks.filter((t) => t.at > now);
    for (const t of due) {
      if (t.kind === 'timeup') this.onTimeUp(t.arg);
      else if (t.kind === 'grace' || t.kind === 'finish') await this.finishRound(t.arg);
      else if (t.kind === 'drop') this.dropLobbyPlayer(t.arg);
    }
    this.save();
    this.arm();
  }

  // ---------- join / leave ----------
  onJoin(ws, m) {
    const s = this.s;
    let p = m.token ? s.players.find((x) => x.token === m.token) : null;
    if (p) {
      const old = this.socketOf(p.id);
      if (old && old !== ws) { try { old.serializeAttachment({ pid: null }); old.close(1000, 'replaced'); } catch { /* ignore */ } }
      p.connected = true;
      s.tasks = s.tasks.filter((t) => !(t.kind === 'drop' && t.arg === p.id));
      if (s.phase === 'lobby') { p.name = cleanName(m.name || p.name); p.avatar = cleanAvatar(m.avatar); }
    } else {
      if (m.create) {
        if (s.players.length) return this.fail(ws, 'That room code is taken — try again.');
      } else if (!s.players.length) {
        return this.fail(ws, 'The room you are trying to join no longer exists');
      }
      if (s.phase !== 'lobby') return this.fail(ws, 'This room is no longer available. The game has already begun');
      if (s.players.length >= MAX_PLAYERS) return this.fail(ws, 'This room has reached its capacity');
      p = { id: rid(6), token: rid(24), name: cleanName(m.name), avatar: cleanAvatar(m.avatar), connected: true };
      s.players.push(p);
    }
    ws.serializeAttachment({ pid: p.id });
    this.ensureHost();
    this.send(ws, { t: 'welcome', you: p.id, token: p.token });
    this.broadcastState();
    if (s.phase === 'play') this.sendTurn(p);
    if (s.phase === 'results') this.sendBooks(p);
    this.arm();
    this.save();
  }

  onLeave(p) {
    const s = this.s;
    p.connected = false;
    this.ensureHost();
    if (s.phase === 'lobby') this.schedule('drop', LOBBY_DROP_MS, p.id);
    this.broadcastState();
    if (s.phase === 'play') this.checkRoundComplete();
    this.save();
  }

  dropLobbyPlayer(pid) {
    const s = this.s;
    const p = s.players.find((x) => x.id === pid);
    if (!p || p.connected || s.phase !== 'lobby') return;
    s.players = s.players.filter((x) => x !== p);
    this.ensureHost();
    this.broadcastState();
  }

  ensureHost() {
    const s = this.s;
    const cur = s.players.find((p) => p.id === s.hostId);
    if (cur && cur.connected) return;
    const next = s.players.find((p) => p.connected);
    s.hostId = next ? next.id : (s.players[0] ? s.players[0].id : null);
  }

  // ---------- messages ----------
  onMessage(me, m) {
    const s = this.s;
    const isHost = me.id === s.hostId;
    switch (m.t) {
      case 'profile':
        if (s.phase !== 'lobby') return;
        me.name = cleanName(m.name); me.avatar = cleanAvatar(m.avatar);
        break;
      case 'settings':
        if (!isHost || s.phase !== 'lobby') return;
        if (m.speed in SPEED) s.settings.speed = m.speed;
        if (m.turns in TURNS) s.settings.turns = m.turns;
        break;
      case 'kick': {
        if (!isHost || s.phase !== 'lobby' || m.id === me.id) return;
        const t = s.players.find((p) => p.id === m.id);
        if (!t) return;
        const ws = this.socketOf(t.id);
        if (ws) { this.send(ws, { t: 'error', msg: 'You have been kicked out from the room by the host', fatal: true }); try { ws.serializeAttachment({ pid: null }); ws.close(1000, 'kicked'); } catch { /* ignore */ } }
        s.players = s.players.filter((p) => p !== t);
        break;
      }
      case 'start':
        if (!isHost || s.phase !== 'lobby') return;
        if (s.players.filter((p) => p.connected).length < MIN_PLAYERS) return;
        return this.startGame();
      case 'submit':
        return this.onSubmit(me, m);
      case 'edit': { // text turns: take back "Done" and keep typing
        const g = s.game;
        if (s.phase !== 'play' || !g || g.finishing || g.type === 'draw') return;
        delete g.submitted[me.id];
        break;
      }
      case 'skip': // host only, only useful with the INFINITE clock
        if (!isHost || s.phase !== 'play') return;
        return this.finishRound(s.game.round);
      case 'album': {
        if (!isHost || s.phase !== 'results') return;
        const n = s.game.n;
        s.view = {
          started: true, book: Math.max(0, Math.min(n - 1, m.book | 0)), step: 1,
          auto: !!m.auto, flow: m.flow === 'end' ? 'end' : 'start', seq: ((s.view && s.view.seq) || 0) + 1,
        };
        break;
      }
      case 'step': {
        if (!isHost || s.phase !== 'results' || !s.view || !s.view.started) return;
        s.view.step = Math.max(1, Math.min(s.game.turns, m.step | 0));
        break;
      }
      case 'again':
        if (!isHost || s.phase !== 'results') return;
        s.phase = 'lobby'; s.game = null; s.view = null;
        s.players = s.players.filter((p) => p.connected);
        this.cancel('timeup'); this.cancel('grace'); this.cancel('finish');
        this.clearStored().catch(() => {});
        this.ensureHost();
        break;
      default: return;
    }
    this.broadcastState();
    this.save();
  }

  async clearStored() {
    const keys = [...(await this.ctx.storage.list({ prefix: 'ent:' })).keys(), ...(await this.ctx.storage.list({ prefix: 'sub:' })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
  }

  // ---------- state ----------
  publicState() {
    const s = this.s, g = s.game;
    return {
      t: 'state', phase: s.phase, hostId: s.hostId, settings: s.settings, min: MIN_PLAYERS, max: MAX_PLAYERS,
      players: s.players.map((p) => ({
        id: p.id, name: p.name, avatar: p.avatar, connected: p.connected,
        done: !!(g && s.phase === 'play' && g.submitted[p.id]),
      })),
      game: g ? { gid: g.gid, round: g.round, total: g.turns, books: g.n, type: g.type, order: g.order } : null,
      view: s.phase === 'results' ? s.view : null,
    };
  }
  broadcastState() { this.broadcast(this.publicState()); }

  // ---------- game ----------
  msFor(type) {
    const mult = SPEED[this.s.settings.speed];
    return mult ? Math.round(BASE_MS[type] * mult) : 0;
  }

  async startGame() {
    const s = this.s;
    s.players = s.players.filter((p) => p.connected);
    const order = shuffle(s.players.map((p) => p.id));
    const n = order.length;
    // "ALL" = one turn per player; FEW / MOST use fewer turns (never fewer than 4, never more than n)
    const turns = Math.min(n, Math.max(Math.round(TURNS[s.settings.turns] * n), 4));
    s.game = { gid: rid(6), order, n, turns, round: -1, type: null, submitted: {}, deadline: null, duration: 0, finishing: false };
    s.phase = 'play';
    s.view = null;
    await this.clearStored();
    this.beginRound(0);
    this.save();
  }

  beginRound(r) {
    const g = this.s.game;
    this.cancel('timeup'); this.cancel('grace'); this.cancel('finish');
    g.round = r; g.submitted = {}; g.finishing = false;
    g.type = r === 0 ? 'start' : r % 2 === 1 ? 'draw' : 'write';
    g.duration = this.msFor(g.type);
    const lead = r === 0 ? 3000 : 0; // 3-2-1 countdown before the first turn
    g.deadline = g.duration ? Date.now() + g.duration + lead : null;
    if (g.duration) this.schedule('timeup', g.duration + lead, r);
    this.broadcastState();
    for (const p of this.s.players) this.sendTurn(p);
    this.save();
  }

  bookIndexFor(pid, r) {
    const g = this.s.game;
    const j = g.order.indexOf(pid);
    return j < 0 ? -1 : (((j - r) % g.n) + g.n) % g.n;
  }

  async sendTurn(p) {
    const s = this.s, g = s.game;
    if (!g || s.phase !== 'play') return;
    const b = this.bookIndexFor(p.id, g.round);
    if (b < 0) return;
    let prompt = null;
    if (g.round > 0) {
      const prev = await this.ctx.storage.get(`ent:${b}:${g.round - 1}`);
      prompt = !prev || !prev.content
        ? { kind: 'empty' }
        : { kind: prev.kind === 'draw' ? 'image' : 'text', content: prev.content, by: prev.by };
    }
    this.sendTo(p, {
      t: 'turn', gid: g.gid, round: g.round, total: g.turns, type: g.type, prompt,
      duration: g.duration, remaining: g.deadline ? Math.max(0, g.deadline - Date.now()) : null,
      submitted: !!g.submitted[p.id],
    });
  }

  onTimeUp(r) {
    const g = this.s.game;
    if (!g || g.round !== r || this.s.phase !== 'play') return;
    this.broadcast({ t: 'timeup', round: r });
    this.schedule('grace', GRACE_MS, r);
  }

  async onSubmit(me, m) {
    const s = this.s, g = s.game;
    if (!g || s.phase !== 'play' || m.round !== g.round) return;
    if (!g.order.includes(me.id) || g.finishing) return;
    const clean = sanitize(g.type === 'draw' ? 'draw' : 'text', m.content);
    await this.ctx.storage.put(`sub:${me.id}`, clean);
    g.submitted[me.id] = true;
    this.broadcastState();
    this.save();
    this.checkRoundComplete();
  }

  checkRoundComplete() {
    const s = this.s, g = s.game;
    if (!g || s.phase !== 'play' || g.finishing) return;
    const byId = new Map(s.players.map((p) => [p.id, p]));
    if (!g.order.some((id) => byId.get(id) && byId.get(id).connected)) return; // everyone left: pause
    const all = g.order.every((id) => g.submitted[id] || !(byId.get(id) && byId.get(id).connected));
    if (!all) return;
    g.finishing = true;
    this.schedule('finish', 600, g.round);
    this.save();
  }

  async finishRound(r) {
    const s = this.s, g = s.game;
    if (!g || s.phase !== 'play' || g.round !== r) return;
    this.cancel('timeup'); this.cancel('grace'); this.cancel('finish');
    const kind = r % 2 === 1 ? 'draw' : 'text';
    const subs = await this.ctx.storage.get(g.order.map((pid) => `sub:${pid}`));
    const puts = {};
    g.order.forEach((pid, j) => {
      const b = (((j - r) % g.n) + g.n) % g.n;
      const content = g.submitted[pid] ? (subs.get(`sub:${pid}`) || '') : '';
      puts[`ent:${b}:${r}`] = { by: pid, kind, content, skipped: !content };
    });
    await this.ctx.storage.put(puts);
    await this.ctx.storage.delete(g.order.map((pid) => `sub:${pid}`));
    if (r + 1 >= g.turns) await this.endGame();
    else this.beginRound(r + 1);
    this.save();
  }

  async endGame() {
    const s = this.s;
    s.phase = 'results';
    s.view = { started: false, book: 0, step: 1, auto: false, flow: 'start', seq: 0 };
    for (const p of s.players) await this.sendBooks(p);
    this.broadcastState();
  }

  async sendBooks(p) {
    const g = this.s.game;
    if (!g) return;
    const all = await this.ctx.storage.list({ prefix: 'ent:' });
    for (let b = 0; b < g.n; b++) {
      const entries = [];
      for (let r = 0; r < g.turns; r++) entries.push(all.get(`ent:${b}:${r}`) || { by: null, kind: r % 2 ? 'draw' : 'text', content: '', skipped: true });
      this.sendTo(p, { t: 'book', index: b, total: g.n, owner: g.order[b], entries });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const code = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (code.length < 3) return new Response('Bad room code', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    return new Response('Garlic Phone server is running.', {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  },
};
