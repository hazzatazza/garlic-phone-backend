// Doodle Phone — Cloudflare Worker + Durable Object (one Durable Object = one room)
// Normal mode: everyone writes a sentence, then books get passed around:
// draw it -> describe it -> draw it ... and everyone sees the chains at the end.

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
const MAX_MSG = 900000;          // bytes of a single websocket message we accept
const MAX_IMG = 800000;          // max size of one drawing (data URL)
const GRACE_MS = 4000;           // wait after the timer ends for last-second submits
const LOBBY_DROP_MS = 6000;      // how long a disconnected lobby player is kept (page refresh)

const SPEEDS = { fast: 0.6, normal: 1, slow: 1.6, none: 0 };
const BASE_SECONDS = { start: 45, draw: 90, write: 45 };

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

function sanitize(kind, content) {
  if (typeof content !== 'string') return '';
  if (kind === 'draw') {
    if (!content || content.length > MAX_IMG) return '';
    return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(content) ? content : '';
  }
  return content.replace(/\s+/g, ' ').trim().slice(0, 120);
}

export class Room {
  constructor(state, env) {
    this.players = []; // { id, token, name, avatar, ws, connected, dropTimer }
    this.hostId = null;
    this.phase = 'lobby'; // lobby | play | results
    this.settings = { speed: 'normal' };
    this.game = null;
    this.view = { book: 0, step: 1 };
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.handleSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- sockets ----------
  handleSocket(ws) {
    let me = null;
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > MAX_MSG) return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (!me) {
        if (m.t === 'join') me = this.onJoin(ws, m);
        return;
      }
      this.onMessage(me, m);
    });
    const gone = () => { if (me && me.ws === ws) this.onLeave(me); };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket already dead */ }
  }
  sendTo(p, obj) { if (p.ws && p.connected) this.send(p.ws, obj); }
  broadcast(obj) { for (const p of this.players) this.sendTo(p, obj); }

  fail(ws, msg) {
    this.send(ws, { t: 'error', msg, fatal: true });
    try { ws.close(1000, 'bye'); } catch { /* ignore */ }
    return null;
  }

  // ---------- join / leave ----------
  onJoin(ws, m) {
    let p = m.token ? this.players.find((x) => x.token === m.token) : null;
    if (p) {
      // returning player (refresh / reconnect)
      if (p.ws && p.ws !== ws) { try { p.ws.close(1000, 'replaced'); } catch { /* ignore */ } }
      clearTimeout(p.dropTimer);
      p.ws = ws;
      p.connected = true;
      if (this.phase === 'lobby') {
        p.name = cleanName(m.name || p.name);
        if (Number.isInteger(m.avatar)) p.avatar = Math.max(0, Math.min(23, m.avatar));
      }
    } else {
      if (m.create) {
        if (this.players.length) return this.fail(ws, 'That room code is taken — try again.');
      } else if (!this.players.length) {
        return this.fail(ws, "Room not found. Double-check the code!");
      }
      if (this.phase !== 'lobby') return this.fail(ws, 'That game has already started.');
      if (this.players.length >= MAX_PLAYERS) return this.fail(ws, 'That room is full.');
      p = {
        id: rid(6), token: rid(24), name: cleanName(m.name),
        avatar: Number.isInteger(m.avatar) ? Math.max(0, Math.min(23, m.avatar)) : 0,
        ws, connected: true, dropTimer: null,
      };
      this.players.push(p);
    }
    this.ensureHost();
    this.send(ws, { t: 'welcome', you: p.id, token: p.token });
    this.broadcastState();
    if (this.phase === 'play') this.sendTurn(p);
    if (this.phase === 'results') this.sendBooks(p);
    return p;
  }

  onLeave(p) {
    p.connected = false;
    p.ws = null;
    this.ensureHost();
    if (this.phase === 'lobby') {
      clearTimeout(p.dropTimer);
      p.dropTimer = setTimeout(() => {
        if (p.connected) return;
        this.players = this.players.filter((x) => x !== p);
        this.ensureHost();
        this.broadcastState();
      }, LOBBY_DROP_MS);
    }
    this.broadcastState();
    if (this.phase === 'play') this.checkRoundComplete();
  }

  ensureHost() {
    const cur = this.players.find((p) => p.id === this.hostId);
    if (cur && cur.connected) return;
    const next = this.players.find((p) => p.connected);
    this.hostId = next ? next.id : (this.players[0] ? this.players[0].id : null);
  }

  // ---------- messages ----------
  onMessage(me, m) {
    const isHost = me.id === this.hostId;
    switch (m.t) {
      case 'ping':
        return this.sendTo(me, { t: 'pong' });
      case 'profile':
        if (this.phase !== 'lobby') return;
        me.name = cleanName(m.name);
        if (Number.isInteger(m.avatar)) me.avatar = Math.max(0, Math.min(23, m.avatar));
        return this.broadcastState();
      case 'settings':
        if (!isHost || this.phase !== 'lobby') return;
        if (m.speed in SPEEDS) this.settings.speed = m.speed;
        return this.broadcastState();
      case 'kick': {
        if (!isHost || this.phase !== 'lobby' || m.id === me.id) return;
        const t = this.players.find((p) => p.id === m.id);
        if (!t) return;
        this.send(t.ws, { t: 'error', msg: 'You were removed from the room.', fatal: true });
        try { t.ws.close(1000, 'kicked'); } catch { /* ignore */ }
        this.players = this.players.filter((p) => p !== t);
        return this.broadcastState();
      }
      case 'start':
        if (!isHost || this.phase !== 'lobby') return;
        if (this.players.filter((p) => p.connected).length < MIN_PLAYERS) return;
        return this.startGame();
      case 'submit':
        return this.onSubmit(me, m);
      case 'skip': // host forces the round to end (someone is AFK)
        if (!isHost || this.phase !== 'play') return;
        return this.finishRound(this.game.round);
      case 'view':
        if (!isHost || this.phase !== 'results') return;
        {
          const n = this.game.n;
          const book = Math.max(0, Math.min(n - 1, m.book | 0));
          const step = Math.max(1, Math.min(n, m.step | 0));
          this.view = { book, step };
        }
        return this.broadcastState();
      case 'again':
        if (!isHost || this.phase !== 'results') return;
        this.phase = 'lobby';
        this.game = null;
        this.players = this.players.filter((p) => p.connected);
        this.ensureHost();
        return this.broadcastState();
    }
  }

  // ---------- state ----------
  publicState() {
    const g = this.game;
    return {
      t: 'state',
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      min: MIN_PLAYERS,
      max: MAX_PLAYERS,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, avatar: p.avatar, connected: p.connected,
        done: !!(g && this.phase === 'play' && g.submitted[p.id] !== undefined),
      })),
      game: g ? { gid: g.gid, round: g.round, total: g.n, type: g.type, order: g.order } : null,
      view: this.phase === 'results' ? this.view : null,
    };
  }
  broadcastState() { this.broadcast(this.publicState()); }

  // ---------- game ----------
  secondsFor(type) {
    const mult = SPEEDS[this.settings.speed];
    return mult ? Math.round(BASE_SECONDS[type] * mult) : 0;
  }

  startGame() {
    this.players = this.players.filter((p) => p.connected);
    const order = shuffle(this.players.map((p) => p.id));
    this.game = {
      gid: rid(6), order, n: order.length, round: -1, type: null,
      books: order.map((owner) => ({ owner, entries: [] })),
      submitted: {}, timer: null, grace: null, deadline: null, duration: 0, finishing: false,
    };
    this.phase = 'play';
    this.beginRound(0);
  }

  beginRound(r) {
    const g = this.game;
    clearTimeout(g.timer);
    clearTimeout(g.grace);
    g.round = r;
    g.submitted = {};
    g.finishing = false;
    g.type = r === 0 ? 'start' : r % 2 === 1 ? 'draw' : 'write';
    g.duration = this.secondsFor(g.type);
    g.deadline = g.duration ? Date.now() + g.duration * 1000 : null;
    g.timer = g.duration ? setTimeout(() => this.onTimeUp(r), g.duration * 1000) : null;
    this.broadcastState();
    for (const p of this.players) this.sendTurn(p);
  }

  bookIndexFor(playerId, r) {
    const g = this.game;
    const j = g.order.indexOf(playerId);
    if (j < 0) return -1;
    return (((j - r) % g.n) + g.n) % g.n;
  }

  sendTurn(p) {
    const g = this.game;
    if (!g || this.phase !== 'play') return;
    const b = this.bookIndexFor(p.id, g.round);
    if (b < 0) return;
    let prompt = null;
    if (g.round > 0) {
      const prev = g.books[b].entries[g.round - 1];
      prompt = !prev || !prev.content
        ? { kind: 'empty' }
        : { kind: prev.kind === 'draw' ? 'image' : 'text', content: prev.content };
    }
    this.sendTo(p, {
      t: 'turn', gid: g.gid, round: g.round, total: g.n, type: g.type, prompt,
      duration: g.duration, remaining: g.deadline ? Math.max(0, g.deadline - Date.now()) : null,
      submitted: g.submitted[p.id] !== undefined,
    });
  }

  onTimeUp(r) {
    const g = this.game;
    if (!g || g.round !== r || this.phase !== 'play') return;
    this.broadcast({ t: 'timeup', round: r });
    g.grace = setTimeout(() => this.finishRound(r), GRACE_MS);
  }

  onSubmit(me, m) {
    const g = this.game;
    if (!g || this.phase !== 'play' || m.round !== g.round) return;
    if (!g.order.includes(me.id) || g.submitted[me.id] !== undefined) return;
    g.submitted[me.id] = sanitize(g.type === 'draw' ? 'draw' : 'text', m.content);
    this.broadcastState();
    this.checkRoundComplete();
  }

  checkRoundComplete() {
    const g = this.game;
    if (!g || this.phase !== 'play' || g.finishing) return;
    const byId = new Map(this.players.map((p) => [p.id, p]));
    const anyConnected = g.order.some((id) => byId.get(id) && byId.get(id).connected);
    if (!anyConnected) return; // everyone left: just pause
    const all = g.order.every((id) => g.submitted[id] !== undefined || !(byId.get(id) && byId.get(id).connected));
    if (!all) return;
    g.finishing = true;
    const r = g.round;
    setTimeout(() => this.finishRound(r), 500);
  }

  finishRound(r) {
    const g = this.game;
    if (!g || this.phase !== 'play' || g.round !== r) return;
    clearTimeout(g.timer);
    clearTimeout(g.grace);
    const kind = r % 2 === 1 ? 'draw' : 'text';
    g.order.forEach((pid, j) => {
      const b = (((j - r) % g.n) + g.n) % g.n;
      const sub = g.submitted[pid];
      const content = sub === undefined ? '' : sub;
      g.books[b].entries.push({ by: pid, kind, content, skipped: !content });
    });
    if (r + 1 >= g.n) this.endGame();
    else this.beginRound(r + 1);
  }

  endGame() {
    this.phase = 'results';
    this.view = { book: 0, step: 1 };
    for (const p of this.players) this.sendBooks(p);
    this.broadcastState();
  }

  sendBooks(p) {
    const g = this.game;
    if (!g) return;
    g.books.forEach((b, index) => {
      this.sendTo(p, { t: 'book', index, total: g.n, owner: b.owner, entries: b.entries });
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket', { status: 426 });
      }
      const code = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (code.length < 3) return new Response('Bad room code', { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    return new Response('Doodle Phone server is running.', {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  },
};
