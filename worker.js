// Garlic Phone — Cloudflare Worker + Durable Object (one Durable Object = one room)
//
// Room (below) owns sockets, the lobby, hibernation and alarms.
// Every game mode is a small module in MODES with the same hooks:
//   min, start(R), sync(R,p), pub(R,g), onSubmit(R,me,m), onMessage(R,me,m), onTask(R,arg), onLeave(R,p)
// Modes: normal, story, forgery, pixel, zoom, evolution, fakeartist, panic.
// Uses the WebSocket Hibernation API: idle rooms cost nothing, pings never wake the object.

const MAX_PLAYERS = 20;
const MAX_MSG = 900000;
const MAX_IMG = 800000;
const MAX_TEXT = 100;
const GRACE_MS = 4000;
const LOBBY_DROP_MS = 8000;
const AVATARS = 61;

const SPEED = { fast: 0.5, normal: 1, slow: 2, infinite: 0 };
const TURNS = { few: 0.5, most: 0.75, all: 1 };
const BASE_MS = { start: 50000, draw: 150000, write: 40000 };

const rid = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join('');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
const cleanAvatar = (a) => (Number.isInteger(a) ? Math.max(0, Math.min(AVATARS - 1, a)) : 0);
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
const cleanImg = (c) => (typeof c === 'string' && c && c.length <= MAX_IMG && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(c) ? c : '');
const cleanText = (c, n = MAX_TEXT) => (typeof c === 'string' ? c.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const CANVAS_W = 758, CANVAS_H = 424;

// ------------------------------------------------------------------ content
const MUTATIONS = ['Make it evil', '100 years later', 'Underwater', 'On fire', 'Add a villain', 'Make it tiny', 'Make it giant', 'Turn it into a robot', 'Make it delicious',
  'Make it haunted', 'In outer space', 'During a storm', 'Add a party', 'Make it a cartoon villain', 'Add a dragon', 'Make it ancient', 'In the future', 'Make it fluffy',
  'Add too many eyes', 'Make it a superhero', 'Everything is made of cheese', 'Add a ridiculous hat', 'Make it cursed', 'Winter is coming', 'It is a wedding now', 'Add a giant monster',
  'Make it a crime scene', 'Make it a jungle', 'Turn it into a pirate ship', 'Make it spooky', 'Add a chase scene', 'Make it fancy', 'Add a volcano', 'Make it sad', 'Now it is a circus',
  'Make it a video game', 'Add a UFO', 'Make everything melt', 'Add a baby version', 'Make it a disaster'];
const FORGERY_PROMPTS = ['A seagull stealing a wedding cake', 'A grandma riding a motorcycle through a car wash', 'A knight eating soup with a spoon way too small', 'A cat DJing for a room full of confused fish',
  'A robot trying to hug a cactus', 'A snowman melting at his own birthday party', 'A dragon who is scared of a tiny mouse', 'A raccoon in a tuxedo robbing a bakery',
  'A giraffe stuck inside a phone booth', 'A pirate ship sailing through a bowl of cereal', 'A ghost sitting in traffic', 'A shark learning to knit', 'A wizard whose spell turned him into a toaster',
  'A penguin on a first date at a pizza place', 'A dinosaur using a self-checkout machine', 'A very proud potato getting an award', 'An octopus trying to put on eight socks', 'A tiny king arguing with a giant chicken',
  'A pigeon pilot landing on a hot dog', 'A bear in a bathtub reading the news', 'A squirrel running for president', 'A flamingo doing yoga on a skateboard', 'A banana slipping on a person',
  'A haunted vending machine', 'A mermaid stuck in a very small bathtub', 'A llama in a suit giving a speech', 'A frog conducting an orchestra of crickets', 'A mad scientist making a sandwich',
  'A sleepy volcano wearing pajamas', 'A crab opening a tiny restaurant', 'A vampire who is afraid of sunlight and also clouds', 'A walrus winning a dance contest', 'A burger with a very angry face',
  'A spaceship parked in a grocery store lot', 'A camel at the world\'s smallest oasis', 'A duck chasing a bus', 'A zombie politely asking for directions', 'A hedgehog on a hot air balloon',
  'A turtle in a sports car', 'A moose in a library', 'A bored alien in a waiting room', 'A snail delivering a very urgent pizza', 'A cow auditioning for a talent show',
  'A mummy stuck in a revolving door', 'A werewolf getting a haircut', 'A kangaroo carrying way too many groceries', 'A fox selling umbrellas in a desert', 'A chef fighting a lobster with a baguette',
  'A cloud having a really bad day', 'A hippo trying to fit in a tiny car', 'A rooster at a rave'];
const FA_WORDS = [
  { cat: 'Monster', words: ['Vampire', 'Zombie', 'Werewolf', 'Mummy', 'Ghost', 'Dragon', 'Frankenstein', 'Kraken', 'Medusa', 'Bigfoot'] },
  { cat: 'Animal', words: ['Elephant', 'Penguin', 'Giraffe', 'Octopus', 'Kangaroo', 'Hedgehog', 'Flamingo', 'Panda', 'Chameleon', 'Narwhal'] },
  { cat: 'Food', words: ['Pizza', 'Hamburger', 'Spaghetti', 'Ice Cream', 'Sushi', 'Pancake', 'Taco', 'Popcorn', 'Cotton Candy', 'Pineapple Pizza'] },
  { cat: 'Vehicle', words: ['Helicopter', 'Submarine', 'Bicycle', 'Rocket', 'Tractor', 'Sailboat', 'Train', 'Skateboard', 'Hot Air Balloon', 'Monster Truck'] },
  { cat: 'Building', words: ['Castle', 'Lighthouse', 'Igloo', 'Windmill', 'Pyramid', 'Treehouse', 'Skyscraper', 'Barn', 'Haunted House', 'Space Station'] },
  { cat: 'Sport', words: ['Basketball', 'Surfing', 'Archery', 'Skiing', 'Boxing', 'Bowling', 'Fencing', 'Golf', 'Skydiving', 'Sumo Wrestling'] },
  { cat: 'Job', words: ['Astronaut', 'Pirate', 'Chef', 'Firefighter', 'Wizard', 'Farmer', 'Detective', 'Clown', 'Mad Scientist', 'Ninja'] },
  { cat: 'Instrument', words: ['Guitar', 'Trumpet', 'Drums', 'Piano', 'Violin', 'Harp', 'Banjo', 'Flute', 'Bagpipes', 'Accordion'] },
  { cat: 'Nature', words: ['Volcano', 'Waterfall', 'Rainbow', 'Tornado', 'Cactus', 'Mountain', 'Island', 'Glacier', 'Quicksand', 'Northern Lights'] },
  { cat: 'Toy', words: ['Teddy Bear', 'Yo-yo', 'Kite', 'Robot', 'Puzzle', 'Doll', 'Train Set', 'Spinning Top', 'Rubik\'s Cube', 'Slinky'] },
];
const FA_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0abab5', '#c4a000', '#f032e6', '#8b5a2b', '#808080', '#000000', '#ff7aa2', '#2e8b57', '#5b3fd0', '#b22222', '#00a0e0', '#9acd32', '#ff4500', '#6a5acd', '#d2691e'];
const PANIC_PROMPTS = ['A flamingo stuck in a vending machine', 'A wizard doing his taxes', 'A pigeon starting a podcast', 'Grandma skydiving into a cake', 'A T-rex using a smartphone', 'A banana wearing a tuxedo at court', 'A robot crying at a wedding', 'A cow on a first date with a toaster', 'A knight fighting a Roomba', 'A llama on a roller coaster', 'A snowman in a sauna', 'A shark learning to cook', 'A raccoon DJing at a funeral', 'An octopus knitting sweaters', 'A potato running a marathon', 'A dragon at the dentist', 'Aliens at a bake sale', 'A pirate lost in IKEA', 'A cat piloting a tiny airplane', 'A mermaid in a bathtub', 'A ghost applying for a job', 'A hamster leading an army', 'A frog selling insurance', 'A penguin at a beach party', 'A giant duck in a traffic jam', 'A vampire at the dentist', 'A snail winning a race', 'A scarecrow on a date', 'A walrus in a tuxedo', 'A wizard stuck in an elevator', 'A hamster running a tiny taxi company', 'A dragon returning a library book 400 years late', 'A crab teaching a yoga class', 'A cat arguing with its own reflection in court', 'A sloth in a hurry', 'A robot buying its first pair of shoes', 'A bear stuck in a drive-through', 'A cow lifting weights at the gym', 'A turtle on a skateboard doing a trick', 'Santa stuck in a chimney at a barbecue', 'A giraffe getting a haircut in a salon', 'A ghost scared of a tiny puppy', 'A penguin selling ice to a polar bear', 'A wizard losing a duel to a pigeon', 'A mailman being chased by a giant snail', 'A shark in a bubble bath', 'A knight taking a selfie with a dragon', 'A pizza delivery guy on a unicorn', 'A goldfish walking a human on a leash', 'An astronaut finding a pizza on the moon'];

// ------------------------------------------------------------------ helpers shared by modes
const kindOf = (type) => (type === 'draw' || type === 'forge1' || type === 'forge2' || type === 'panic' ? 'draw' : 'text');
async function putSub(R, pid, c, m) { await R.ctx.storage.put(`sub:${pid}`, { c, m: m || null }); }

// ===================================================================== CHAIN MODES
// normal / story / pixel / zoom / evolution share one engine; typeFor(r) decides what each turn is.
function chainMode(id, typeFor) {
  const M = {
    min: 2,
    async start(R) {
      const s = R.s;
      s.players = s.players.filter((p) => p.connected);
      const order = shuffle(s.players.map((p) => p.id));
      const n = order.length;
      const turns = Math.min(n, Math.max(Math.round(TURNS[s.settings.turns] * n), 4));
      s.game = { gid: rid(6), mode: id, order, n, turns, round: -1, type: null, submitted: {}, deadline: null, duration: 0, finishing: false, mut: {} };
      s.phase = 'play'; s.view = null; s.final = null;
      await R.clearStored();
      M.begin(R, 0);
      R.save();
    },
    begin(R, r) {
      const g = R.s.game;
      R.cancelTasks();
      g.round = r; g.submitted = {}; g.finishing = false; g.type = typeFor(r);
      g.duration = R.ms(BASE_MS[g.type]);
      const lead = r === 0 ? 3000 : 0;
      g.deadline = g.duration ? Date.now() + g.duration + lead : null;
      if (g.duration) R.schedule('m', g.duration + lead, { k: 'timeup', r });
      g.mut = {};
      if (id === 'evolution' && r >= 2) for (const pid of g.order) g.mut[pid] = pick(MUTATIONS);
      R.broadcastState();
      for (const p of R.s.players) M.sendTurn(R, p);
      R.save();
    },
    bookIndexFor(R, pid, r) { const g = R.s.game, j = g.order.indexOf(pid); return j < 0 ? -1 : (((j - r) % g.n) + g.n) % g.n; },
    async sendTurn(R, p) {
      const s = R.s, g = s.game;
      if (!g || s.phase !== 'play') return;
      const b = M.bookIndexFor(R, p.id, g.round);
      if (b < 0) return;
      let prompt = null;
      if (g.round > 0) {
        const prev = await R.ctx.storage.get(`ent:${b}:${g.round - 1}`);
        prompt = !prev || !prev.content ? { kind: 'empty' } : { kind: prev.kind === 'draw' ? 'image' : 'text', content: prev.content };
      }
      R.sendTo(p, {
        t: 'turn', gid: g.gid, mode: id, round: g.round, total: g.turns, type: g.type, prompt,
        pix: id === 'pixel' && g.round >= 2 ? Math.max(8, 256 >> (g.round - 2)) : undefined, mut: g.mut[p.id],
        duration: g.duration, remaining: g.deadline ? Math.max(0, g.deadline - Date.now()) : null, submitted: !!g.submitted[p.id],
      });
    },
    sync(R, p) {
      if (R.s.phase === 'play') return M.sendTurn(R, p);
      if (R.s.phase === 'results') return M.sendBooks(R, p);
    },
    pub(R, g) { return { round: g.round, total: g.turns, books: g.n, type: g.type }; },
    async onSubmit(R, me, m) {
      const s = R.s, g = s.game;
      if (!g || s.phase !== 'play' || m.round !== g.round) return;
      if (!g.order.includes(me.id) || g.finishing) return;
      const content = g.type === 'draw' ? cleanImg(m.content) : cleanText(m.content);
      let meta = null;
      if (id === 'zoom' && g.type === 'draw' && g.round >= 2 && m.meta && m.meta.crop) {
        const c = m.meta.crop; meta = { crop: { x: num(c.x, 0, CANVAS_W), y: num(c.y, 0, CANVAS_H), s: num(c.s, 20, 400) } };
      }
      await putSub(R, me.id, content, meta);
      g.submitted[me.id] = true;
      R.broadcastState(); R.save();
      M.check(R);
    },
    check(R) {
      const s = R.s, g = s.game;
      if (!g || s.phase !== 'play' || g.finishing) return;
      if (!R.allDone(g.order, g.submitted)) return;
      g.finishing = true;
      R.schedule('m', 600, { k: 'finish', r: g.round });
      R.save();
    },
    async onMessage(R, me, m) {
      const s = R.s, g = s.game, host = me.id === s.hostId;
      switch (m.t) {
        case 'edit':
          if (s.phase !== 'play' || !g || g.finishing || g.type === 'draw') return true;
          delete g.submitted[me.id]; R.broadcastState(); R.save(); return true;
        case 'skip':
          if (host && s.phase === 'play') await M.finish(R, g.round);
          return true;
        case 'album':
          if (!host || s.phase !== 'results' || !s.view) return true;
          s.view = { started: true, book: num(m.book | 0, 0, g.n - 1), step: 1, auto: !!m.auto, flow: m.flow === 'end' ? 'end' : 'start', seq: (s.view.seq || 0) + 1 };
          R.broadcastState(); R.save(); return true;
        case 'step':
          if (!host || s.phase !== 'results' || !s.view || !s.view.started) return true;
          s.view.step = num(m.step | 0, 1, g.turns); R.broadcastState(); R.save(); return true;
      }
      return false;
    },
    async onTask(R, a) {
      const g = R.s.game;
      if (!g || R.s.phase !== 'play') return;
      if (a.k === 'timeup' && g.round === a.r) { R.broadcast({ t: 'timeup', round: a.r }); R.schedule('m', GRACE_MS, { k: 'grace', r: a.r }); }
      else if (a.k === 'grace' || a.k === 'finish') await M.finish(R, a.r);
    },
    onLeave(R) { M.check(R); },
    async finish(R, r) {
      const s = R.s, g = s.game;
      if (!g || s.phase !== 'play' || g.round !== r) return;
      R.cancelTasks();
      const kind = kindOf(g.type);
      const subs = await R.ctx.storage.get(g.order.map((pid) => `sub:${pid}`));
      const puts = {};
      g.order.forEach((pid, j) => {
        const b = (((j - r) % g.n) + g.n) % g.n;
        const sub = g.submitted[pid] ? subs.get(`sub:${pid}`) : null;
        const content = sub ? sub.c : '';
        const e = { by: pid, kind, content, skipped: !content };
        const meta = (sub && sub.m) || (g.mut[pid] ? { mut: g.mut[pid] } : null);
        if (meta) { e.meta = meta; if (sub && sub.m && g.mut[pid]) e.meta.mut = g.mut[pid]; }
        puts[`ent:${b}:${r}`] = e;
      });
      await R.ctx.storage.put(puts);
      await R.ctx.storage.delete(g.order.map((pid) => `sub:${pid}`));
      if (r + 1 >= g.turns) {
        s.phase = 'results'; s.view = { started: false, book: 0, step: 1, auto: false, flow: 'start', seq: 0 };
        for (const p of s.players) await M.sendBooks(R, p);
        R.broadcastState();
      } else M.begin(R, r + 1);
      R.save();
    },
    async sendBooks(R, p) {
      const g = R.s.game; if (!g) return;
      const all = await R.ctx.storage.list({ prefix: 'ent:' });
      for (let b = 0; b < g.n; b++) {
        const entries = [];
        for (let r = 0; r < g.turns; r++) entries.push(all.get(`ent:${b}:${r}`) || { by: null, kind: kindOf(typeFor(r)), content: '', skipped: true });
        R.sendTo(p, { t: 'book', index: b, total: g.n, owner: g.order[b], entries });
      }
    },
  };
  return M;
}

// ===================================================================== FORGERY
const forgery = {
  min: 3,
  async start(R) {
    const s = R.s;
    s.players = s.players.filter((p) => p.connected);
    const order = shuffle(s.players.map((p) => p.id)), n = order.length;
    const perm = shuffle(order), copies = {}; // copier -> owner (nobody copies themself)
    perm.forEach((pid, i) => { copies[pid] = perm[(i + 1) % n]; });
    s.game = { gid: rid(6), mode: 'forgery', order, n, round: -1, type: null, prompts: {}, copies, submitted: {}, deadline: null, duration: 0, peek: 0, finishing: false, cases: null, votes: {} };
    s.phase = 'play'; s.view = null; s.final = null;
    await R.clearStored();
    forgery.begin(R, 0); R.save();
  },
  begin(R, r) {            // 0 write secret prompt · 1 draw it · 2 copy someone's from a peek · 3 vote
    const g = R.s.game;
    R.cancelTasks();
    g.round = r; g.submitted = {}; g.finishing = false; g.type = ['forge0', 'forge1', 'forge2', 'vote'][r];
    g.duration = R.ms([30000, 60000, 45000, 50000][r]);
    g.peek = r === 2 ? 5000 : 0;
    g.deadline = g.duration ? Date.now() + g.duration + g.peek : null;
    if (g.duration) R.schedule('m', g.duration + g.peek, { k: 'timeup', r });
    R.broadcastState();
    for (const p of R.s.players) forgery.sendTurn(R, p);
    R.save();
  },
  async sendTurn(R, p) {
    const g = R.s.game;
    if (!g || R.s.phase !== 'play' || !g.order.includes(p.id)) return;
    if (g.round === 3) return forgery.sendCases(R, p);
    let prompt = null;
    if (g.round === 1) prompt = { kind: 'text', content: g.prompts[p.id] };
    else if (g.round === 2) { const img = await R.ctx.storage.get(`fg:o:${g.copies[p.id]}`); prompt = img ? { kind: 'image', content: img } : { kind: 'empty' }; }
    R.sendTo(p, { t: 'turn', gid: g.gid, mode: 'forgery', round: g.round, total: 4, type: g.type, prompt, peek: g.peek,
      duration: g.duration, remaining: g.deadline ? Math.max(0, g.deadline - Date.now()) : null, submitted: !!g.submitted[p.id] });
  },
  async sendCases(R, p) {
    const g = R.s.game;
    for (let i = 0; i < g.cases.length; i++) {
      const c = g.cases[i];
      const o = (await R.ctx.storage.get(`fg:o:${c.owner}`)) || '', f = (await R.ctx.storage.get(`fg:c:${c.copier}`)) || '';
      R.sendTo(p, { t: 'vcase', gid: g.gid, index: i, prompt: g.prompts[c.owner], items: c.order.map((k) => (k === 'o' ? o : f)),
        mine: p.id === c.owner || p.id === c.copier, total: g.cases.length });
    }
  },
  async sync(R, p) {
    const s = R.s, g = s.game;
    if (!g) return;
    if (s.phase === 'play') return forgery.sendTurn(R, p);
    if (s.phase === 'results') return forgery.sendCases(R, p);
  },
  pub(R, g) { return { round: g.round, total: 4, type: g.type, remaining: g.deadline ? Math.max(0, g.deadline - Date.now()) : null }; },
  async onSubmit(R, me, m) {
    const s = R.s, g = s.game;
    if (!g || s.phase !== 'play' || m.round !== g.round || g.finishing || !g.order.includes(me.id)) return;
    if (g.round === 3) return;
    await putSub(R, me.id, g.round === 0 ? cleanText(m.content) : cleanImg(m.content));
    g.submitted[me.id] = true; R.broadcastState(); R.save(); forgery.check(R);
  },
  async onMessage(R, me, m) {
    const s = R.s, g = s.game;
    if (m.t === 'edit') {
      if (!g || s.phase !== 'play' || g.round !== 0 || g.finishing) return true;
      delete g.submitted[me.id]; R.broadcastState(); R.save(); return true;
    }
    if (m.t === 'vote') {
      if (!g || s.phase !== 'play' || g.round !== 3 || g.finishing || !g.order.includes(me.id) || !m.votes || typeof m.votes !== 'object') return true;
      const v = {};
      g.cases.forEach((c, i) => { if (c.owner !== me.id && c.copier !== me.id && (m.votes[i] === 0 || m.votes[i] === 1)) v[i] = m.votes[i]; });
      g.votes[me.id] = v; g.submitted[me.id] = true; R.broadcastState(); R.save(); forgery.check(R); return true;
    }
    if (m.t === 'skip' && me.id === s.hostId && s.phase === 'play') { await forgery.finish(R, g.round); return true; }
    return false;
  },
  check(R) {
    const g = R.s.game;
    if (!g || R.s.phase !== 'play' || g.finishing || !R.allDone(g.order, g.submitted)) return;
    g.finishing = true; R.schedule('m', 600, { k: 'finish', r: g.round }); R.save();
  },
  async onTask(R, a) {
    const g = R.s.game;
    if (!g || R.s.phase !== 'play') return;
    if (a.k === 'timeup' && g.round === a.r) { R.broadcast({ t: 'timeup', round: a.r }); R.schedule('m', GRACE_MS, { k: 'grace', r: a.r }); }
    else if (a.k === 'grace' || a.k === 'finish') await forgery.finish(R, a.r);
  },
  onLeave(R) { forgery.check(R); },
  async finish(R, r) {
    const s = R.s, g = s.game;
    if (!g || s.phase !== 'play' || g.round !== r) return;
    R.cancelTasks();
    const st = R.ctx.storage;
    if (r < 3) {
      const subs = await st.get(g.order.map((pid) => `sub:${pid}`));
      const sub = (pid) => (g.submitted[pid] ? subs.get(`sub:${pid}`) : null);
      if (r === 0) {                       // custom prompts; anyone who typed nothing gets a random one from the fallback list
        const spare = shuffle(FORGERY_PROMPTS);
        for (const pid of g.order) { const t = sub(pid) && sub(pid).c; g.prompts[pid] = t || spare.pop() || 'A very confusing octopus'; }
      } else {
        const puts = {};
        for (const pid of g.order) puts[`fg:${r === 1 ? 'o' : 'c'}:${pid}`] = sub(pid) ? sub(pid).c : '';
        await st.put(puts);
        if (r === 2) {
          const copierOf = {}; for (const c of g.order) copierOf[g.copies[c]] = c;
          g.cases = shuffle(g.order).map((owner) => ({ owner, copier: copierOf[owner], order: shuffle(['o', 'c']) }));
        }
      }
      await st.delete(g.order.map((pid) => `sub:${pid}`));
      forgery.begin(R, r + 1); R.save(); return;
    }
    // scoring: 100 to a voter who finds the real one, 100 to its artist per finder, 50 to the copycat per player fooled
    const scores = Object.fromEntries(g.order.map((id) => [id, 0]));
    const cases = g.cases.map((c, i) => {
      const real = c.order.indexOf('o'), votes = [];
      for (const pid of g.order) {
        const v = g.votes[pid]; if (!v || v[i] === undefined) continue;
        votes.push({ by: pid, pos: v[i] });
        if (v[i] === real) { scores[pid] += 100; scores[c.owner] += 100; } else scores[c.copier] += 50;
      }
      return { owner: c.owner, copier: c.copier, prompt: g.prompts[c.owner], real, votes };
    });
    s.phase = 'results'; s.final = { mode: 'forgery', scores, cases };
    R.broadcastState(); R.save();
  },
};

// ===================================================================== FAKE ARTIST
const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
const fakeartist = {
  min: 3,
  async start(R) {
    const s = R.s;
    s.players = s.players.filter((p) => p.connected);
    const order = shuffle(s.players.map((p) => p.id)), n = order.length;
    const grp = pick(FA_WORDS);
    s.game = { gid: rid(6), mode: 'fakeartist', order, n, word: pick(grp.words), cat: grp.cat, imp: pick(order), colors: Object.fromEntries(order.map((id, i) => [id, FA_COLORS[i % FA_COLORS.length]])),
      vr: 0, step: 0, phase: 'draw', seq: 0, submitted: {}, votes: {}, deadline: null, cur: null, msg: null, caught: null, guess: null };
    s.phase = 'play'; s.view = null; s.final = null;
    await R.clearStored(); await R.ctx.storage.put('fa', []);
    for (const p of s.players) fakeartist.sendRole(R, p);
    fakeartist.nextTurn(R); R.save();
  },
  sendRole(R, p) { const g = R.s.game; if (g && g.order.includes(p.id)) R.sendTo(p, { t: 'role', gid: g.gid, cat: g.cat, word: p.id === g.imp ? null : g.word, color: g.colors[p.id] }); },
  async sync(R, p) {
    const g = R.s.game; if (!g) return;
    fakeartist.sendRole(R, p);
    R.sendTo(p, { t: 'strokes', gid: g.gid, list: (await R.ctx.storage.get('fa')) || [] });
  },
  pub(R, g) {
    return { phase: g.phase, vr: g.vr, step: g.step, total: 2 * g.n, cur: g.cur, colors: g.colors, msg: g.msg, caught: g.phase === 'guess' ? g.caught : null,
      remaining: g.deadline ? Math.max(0, g.deadline - Date.now()) : null };
  },
  nextTurn(R) {
    const g = R.s.game;
    R.cancelTasks();
    g.phase = 'draw'; g.cur = g.order[g.step % g.n]; g.submitted = {}; g.msg = null;
    const cp = R.s.players.find((p) => p.id === g.cur);
    const wait = cp && cp.connected ? 5000 : 300;
    g.deadline = Date.now() + wait; g.seq++;
    R.schedule('m', wait + 1500, { k: 'turnend', seq: g.seq });
    R.broadcastState(); R.save();
  },
  advance(R) {
    const g = R.s.game; g.step++;
    if (g.step >= 2 * g.n) fakeartist.toVote(R); else fakeartist.nextTurn(R);
  },
  toVote(R) {
    const g = R.s.game; R.cancelTasks();
    g.phase = 'vote'; g.cur = null; g.votes = {}; g.submitted = {}; g.msg = null; g.deadline = Date.now() + 30000; g.seq++;
    R.schedule('m', 30000, { k: 'voteend', seq: g.seq });
    R.broadcastState(); R.save();
  },
  async onSubmit() {},
  async onMessage(R, me, m) {
    const s = R.s, g = s.game;
    if (!g || s.phase !== 'play' || !g.order.includes(me.id)) return false;
    if (m.t === 'stroke') {
      if (g.phase !== 'draw' || g.cur !== me.id || !Array.isArray(m.pts) || m.pts.length < 1) return true;
      const pts = m.pts.slice(0, 900).map((p) => [Math.round(num(p[0], 0, CANVAS_W) * 10) / 10, Math.round(num(p[1], 0, CANVAS_H) * 10) / 10]);
      const list = (await R.ctx.storage.get('fa')) || [];
      const stroke = { by: me.id, pts, i: list.length };
      list.push(stroke); await R.ctx.storage.put('fa', list);
      R.broadcast({ t: 'stroke', gid: g.gid, ...stroke });
      fakeartist.advance(R); return true;
    }
    if (m.t === 'vote') {
      if (g.phase !== 'vote' || !g.order.includes(m.for) || m.for === me.id) return true;
      g.votes[me.id] = m.for; g.submitted[me.id] = true; R.broadcastState();
      if (R.allDone(g.order, g.submitted)) R.schedule('m', 700, { k: 'voteend', seq: g.seq });
      R.save(); return true;
    }
    if (m.t === 'guess') {
      if (g.phase !== 'guess' || me.id !== g.imp) return true;
      g.guess = cleanText(m.word, 40); R.schedule('m', 200, { k: 'guessend', seq: g.seq }); R.save(); return true;
    }
    return false;
  },
  async onTask(R, a) {
    const s = R.s, g = s.game;
    if (!g || s.phase !== 'play' || a.seq !== g.seq) return;
    const name = (id) => (s.players.find((p) => p.id === id) || {}).name || 'Someone';
    if (a.k === 'turnend') return fakeartist.advance(R);
    if (a.k === 'voteend') {
      const counts = {}; for (const v of Object.values(g.votes)) counts[v] = (counts[v] || 0) + 1;
      const max = Math.max(0, ...Object.values(counts)), tops = Object.keys(counts).filter((k) => counts[k] === max);
      g.seq++;
      if (tops.length === 1 && tops[0] === g.imp) { g.phase = 'guess'; g.caught = g.imp; g.guess = null; g.deadline = Date.now() + 15000; R.schedule('m', 15500, { k: 'guessend', seq: g.seq }); }
      else {
        g.msg = tops.length === 1 ? `${name(tops[0])} was NOT the Impostor` : 'The vote was tied — nobody was caught';
        g.phase = 'msg'; g.deadline = Date.now() + 4000; R.schedule('m', 4000, { k: 'aftermsg', seq: g.seq });
      }
      R.broadcastState(); R.save(); return;
    }
    if (a.k === 'aftermsg') {
      g.vr++;
      if (g.vr >= 3) return fakeartist.finish(R, 'artists-lose', 'The group failed to catch the Impostor in 3 votes');
      g.step = 0; return fakeartist.nextTurn(R);
    }
    if (a.k === 'guessend') {
      const ok = g.guess && norm(g.guess) === norm(g.word);
      return fakeartist.finish(R, ok ? 'impostor-guess' : 'artists-win', ok ? 'The Impostor guessed the secret word and steals the win!' : 'The Impostor was caught and did not guess the word');
    }
  },
  onLeave() {},
  finish(R, outcome, text) {
    const s = R.s, g = s.game; R.cancelTasks();
    s.phase = 'results';
    s.final = { mode: 'fakeartist', winner: outcome === 'artists-win' ? 'artists' : 'impostor', text, word: g.word, cat: g.cat, imp: g.imp, guess: g.guess, votes: g.vr + (outcome === 'artists-lose' ? 0 : 1) };
    R.broadcastState(); R.save();
  },
};

// ===================================================================== 30-SECOND PANIC
const panic = {
  min: 2,
  async start(R) {
    const s = R.s;
    s.players = s.players.filter((p) => p.connected);
    const order = shuffle(s.players.map((p) => p.id));
    s.game = { gid: rid(6), mode: 'panic', order, n: order.length, round: -1, phase: 'draw', prompts: [], prompter: null, submitted: {}, votes: {}, seq: 0,
      scores: Object.fromEntries(order.map((id) => [id, 0])), hist: [], deadline: null, last: null, show: [] };
    s.phase = 'play'; s.view = null; s.final = null;
    await R.clearStored();
    panic.begin(R, 0); R.save();
  },
  // each round one player (rotating) types the prompt while everyone else waits, then all draw it
  begin(R, r) {
    const g = R.s.game; R.cancelTasks();
    g.round = r; g.phase = 'pick'; g.submitted = {}; g.votes = {}; g.last = null; g.seq++;
    g.prompter = g.order[r % g.order.length];
    const pp = R.s.players.find((p) => p.id === g.prompter);
    const wait = pp && pp.connected ? 25000 : 1000;
    g.deadline = Date.now() + wait;
    R.schedule('m', wait, { k: 'pickend', seq: g.seq });
    R.broadcastState(); R.save();
  },
  startDraw(R) {
    const g = R.s.game; R.cancelTasks();
    g.phase = 'draw'; g.submitted = {}; g.seq++; g.deadline = Date.now() + 30000;
    R.schedule('m', 30000 + 2500, { k: 'drawend', seq: g.seq });
    R.broadcastState();
    for (const p of R.s.players) panic.sendTurn(R, p);
    R.save();
  },
  sendTurn(R, p) {
    const g = R.s.game; if (!g || !g.order.includes(p.id)) return;
    R.sendTo(p, { t: 'turn', gid: g.gid, mode: 'panic', round: g.round, total: 3, type: 'panic', prompt: { kind: 'text', content: g.prompts[g.round] }, duration: 30000,
      remaining: Math.max(0, g.deadline - Date.now()), submitted: !!g.submitted[p.id] });
  },
  async sendItems(R, p) {
    const g = R.s.game;
    for (const id of g.show) R.sendTo(p, { t: 'pitem', gid: g.gid, round: g.round, id, img: (await R.ctx.storage.get(`pn:d:${id}`)) || '' });
  },
  async sync(R, p) {
    const s = R.s, g = s.game; if (!g || s.phase !== 'play') return;
    if (g.phase === 'draw') panic.sendTurn(R, p); else if (g.phase !== 'pick') await panic.sendItems(R, p);
  },
  pub(R, g) { return { phase: g.phase, round: g.round, total: 3, prompter: g.prompter, prompt: g.prompts[g.round] || null, scores: g.scores, last: g.last, remaining: g.deadline ? Math.max(0, g.deadline - Date.now()) : null }; },
  async onSubmit(R, me, m) {
    const s = R.s, g = s.game;
    if (!g || s.phase !== 'play' || g.phase !== 'draw' || m.round !== g.round || !g.order.includes(me.id)) return;
    await putSub(R, me.id, cleanImg(m.content));
    g.submitted[me.id] = true; R.broadcastState();
    if (R.allDone(g.order, g.submitted)) R.schedule('m', 600, { k: 'drawend', seq: g.seq });
    R.save();
  },
  async onMessage(R, me, m) {
    const s = R.s, g = s.game;
    if (m.t === 'prompt') {
      if (!g || s.phase !== 'play' || g.phase !== 'pick' || me.id !== g.prompter) return true;
      const text = cleanText(m.text, MAX_TEXT); if (!text) return true;
      g.prompts[g.round] = text; panic.startDraw(R); return true;
    }
    if (m.t !== 'vote') return false;
    if (!g || s.phase !== 'play' || g.phase !== 'vote' || !g.order.includes(me.id) || !g.order.includes(m.for) || m.for === me.id) return true;
    g.votes[me.id] = m.for; g.submitted[me.id] = true; R.broadcastState();
    if (R.allDone(g.order, g.submitted)) R.schedule('m', 700, { k: 'voteend', seq: g.seq });
    R.save(); return true;
  },
  async onTask(R, a) {
    const s = R.s, g = s.game;
    if (!g || s.phase !== 'play' || a.seq !== g.seq) return;
    const st = R.ctx.storage;
    if (a.k === 'pickend' && g.phase === 'pick') {
      if (!g.prompts[g.round]) g.prompts[g.round] = pick(PANIC_PROMPTS.filter((x) => !g.prompts.includes(x)));
      panic.startDraw(R); return;
    }
    if (a.k === 'drawend' && g.phase === 'draw') {
      R.cancelTasks();
      const subs = await st.get(g.order.map((pid) => `sub:${pid}`));
      const puts = {}; for (const pid of g.order) { const sub = g.submitted[pid] ? subs.get(`sub:${pid}`) : null; puts[`pn:d:${pid}`] = sub ? sub.c : ''; }
      await st.put(puts); await st.delete(g.order.map((pid) => `sub:${pid}`));
      g.phase = 'vote'; g.show = shuffle(g.order); g.submitted = {}; g.votes = {}; g.seq++; g.deadline = Date.now() + 30000;
      R.schedule('m', 30000, { k: 'voteend', seq: g.seq });
      for (const p of s.players) await panic.sendItems(R, p);
      R.broadcastState(); R.save(); return;
    }
    if (a.k === 'voteend' && g.phase === 'vote') {
      R.cancelTasks();
      const counts = Object.fromEntries(g.order.map((id) => [id, 0]));
      for (const v of Object.values(g.votes)) counts[v]++;
      for (const id of g.order) g.scores[id] += counts[id] * 100;
      g.last = { counts, scores: { ...g.scores } }; g.hist.push({ prompt: g.prompts[g.round], by: g.prompter, counts });
      g.phase = 'result'; g.seq++; g.deadline = Date.now() + 8000;
      R.schedule('m', 8000, { k: 'next', seq: g.seq });
      R.broadcastState(); R.save(); return;
    }
    if (a.k === 'next' && g.phase === 'result') {
      if (g.round + 1 >= 3) { s.phase = 'results'; s.final = { mode: 'panic', scores: g.scores, rounds: g.hist }; R.broadcastState(); R.save(); }
      else panic.begin(R, g.round + 1);
    }
  },
  onLeave(R) { const g = R.s.game; if (g && g.phase === 'draw' && R.allDone(g.order, g.submitted)) R.schedule('m', 600, { k: 'drawend', seq: g.seq }); },
};

const MODES = {
  normal: chainMode('normal', (r) => (r === 0 ? 'start' : r % 2 ? 'draw' : 'write')),
  story: chainMode('story', (r) => (r === 0 ? 'start' : 'write')),
  forgery,
  pixel: chainMode('pixel', (r) => (r === 0 ? 'start' : 'draw')),
  zoom: chainMode('zoom', (r) => (r === 0 ? 'start' : 'draw')),
  evolution: chainMode('evolution', (r) => (r === 0 ? 'start' : 'draw')),
  fakeartist,
  panic,
};

const fresh = () => ({ players: [], hostId: null, phase: 'lobby', settings: { mode: 'normal', speed: 'normal', turns: 'all' }, game: null, view: null, final: null, tasks: [] });

// ===================================================================== ROOM
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.s = fresh();
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch { /* tests */ }
    this.ready = ctx.blockConcurrencyWhile(async () => { const saved = await ctx.storage.get('s'); if (saved) this.s = saved; });
  }
  get M() { return MODES[this.s.settings.mode] || MODES.normal; }
  save() { return this.ctx.storage.put('s', this.s); }
  ms(base) { const m = SPEED[this.s.settings.speed]; return m ? Math.round(base * m) : 0; }
  allDone(order, submitted) {
    const byId = new Map(this.s.players.map((p) => [p.id, p]));
    const live = order.filter((id) => byId.get(id) && byId.get(id).connected);
    return live.length > 0 && live.every((id) => submitted[id]);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- sockets
  socketOf(pid) { for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.pid === pid) return ws; } return null; }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* dead */ } }
  sendTo(p, obj) { const ws = p.connected && this.socketOf(p.id); if (ws) this.send(ws, obj); }
  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.pid) { try { ws.send(msg); } catch { /* ignore */ } } }
  }
  fail(ws, msg) { this.send(ws, { t: 'error', msg, fatal: true }); try { ws.close(1000, 'bye'); } catch { /* ignore */ } }

  async webSocketMessage(ws, data) {
    await this.ready;
    if (typeof data !== 'string' || data.length > MAX_MSG) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const att = ws.deserializeAttachment();
    if (!att || !att.pid) { if (m.t === 'join') await this.onJoin(ws, m); return; }
    const me = this.s.players.find((p) => p.id === att.pid);
    if (me) await this.onMessage(me, m);
  }
  async webSocketClose(ws) {
    await this.ready;
    const att = ws.deserializeAttachment();
    if (!att || !att.pid) return;
    if (this.ctx.getWebSockets().some((o) => o !== ws && (o.deserializeAttachment() || {}).pid === att.pid)) return;
    const p = this.s.players.find((x) => x.id === att.pid);
    if (p) this.onLeave(p);
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }

  // ---- tasks / alarms
  schedule(kind, ms, arg) { this.s.tasks.push({ at: Date.now() + ms, kind, arg }); this.arm(); }
  cancelTasks() { this.s.tasks = this.s.tasks.filter((t) => t.kind !== 'm'); this.arm(); }
  arm() { return this.s.tasks.length ? this.ctx.storage.setAlarm(Math.min(...this.s.tasks.map((t) => t.at))) : this.ctx.storage.deleteAlarm(); }
  async alarm() {
    await this.ready;
    const now = Date.now() + 20;
    const due = this.s.tasks.filter((t) => t.at <= now);
    this.s.tasks = this.s.tasks.filter((t) => t.at > now);
    for (const t of due) {
      if (t.kind === 'drop') this.dropLobbyPlayer(t.arg);
      else await this.M.onTask(this, t.arg);
    }
    this.save(); this.arm();
  }

  // ---- join / leave
  async onJoin(ws, m) {
    const s = this.s;
    let p = m.token ? s.players.find((x) => x.token === m.token) : null;
    if (p) {
      const old = this.socketOf(p.id);
      if (old && old !== ws) { try { old.serializeAttachment({ pid: null }); old.close(1000, 'replaced'); } catch { /* ignore */ } }
      p.connected = true;
      s.tasks = s.tasks.filter((t) => !(t.kind === 'drop' && t.arg === p.id));
      if (s.phase === 'lobby') { p.name = cleanName(m.name || p.name); p.avatar = cleanAvatar(m.avatar); }
    } else {
      if (m.create) { if (s.players.length) return this.fail(ws, 'That room code is taken — try again.'); }
      else if (!s.players.length) return this.fail(ws, 'The room you are trying to join no longer exists');
      if (s.phase !== 'lobby') return this.fail(ws, 'This room is no longer available. The game has already begun');
      if (s.players.length >= MAX_PLAYERS) return this.fail(ws, 'This room has reached its capacity');
      p = { id: rid(6), token: rid(24), name: cleanName(m.name), avatar: cleanAvatar(m.avatar), connected: true };
      s.players.push(p);
    }
    ws.serializeAttachment({ pid: p.id });
    this.ensureHost();
    this.send(ws, { t: 'welcome', you: p.id, token: p.token });
    this.broadcastState();
    if (s.phase !== 'lobby') await this.M.sync(this, p);
    this.arm(); this.save();
  }
  onLeave(p) {
    const s = this.s;
    p.connected = false;
    this.ensureHost();
    if (s.phase === 'lobby') this.schedule('drop', LOBBY_DROP_MS, p.id);
    this.broadcastState();
    if (s.phase === 'play') this.M.onLeave(this, p);
    this.save();
  }
  dropLobbyPlayer(pid) {
    const s = this.s, p = s.players.find((x) => x.id === pid);
    if (!p || p.connected || s.phase !== 'lobby') return;
    s.players = s.players.filter((x) => x !== p); this.ensureHost(); this.broadcastState();
  }
  ensureHost() {
    const s = this.s, cur = s.players.find((p) => p.id === s.hostId);
    if (cur && cur.connected) return;
    const next = s.players.find((p) => p.connected);
    s.hostId = next ? next.id : (s.players[0] ? s.players[0].id : null);
  }

  // ---- messages
  async onMessage(me, m) {
    const s = this.s, isHost = me.id === s.hostId;
    switch (m.t) {
      case 'profile':
        if (s.phase !== 'lobby') return;
        me.name = cleanName(m.name); me.avatar = cleanAvatar(m.avatar); break;
      case 'settings':
        if (!isHost || s.phase !== 'lobby') return;
        if (m.mode in MODES) s.settings.mode = m.mode;
        if (m.speed in SPEED) s.settings.speed = m.speed;
        if (m.turns in TURNS) s.settings.turns = m.turns;
        break;
      case 'kick': {
        if (!isHost || s.phase !== 'lobby' || m.id === me.id) return;
        const t = s.players.find((p) => p.id === m.id); if (!t) return;
        const ws = this.socketOf(t.id);
        if (ws) { this.send(ws, { t: 'error', msg: 'You have been kicked out from the room by the host', fatal: true }); try { ws.serializeAttachment({ pid: null }); ws.close(1000, 'kicked'); } catch { /* ignore */ } }
        s.players = s.players.filter((p) => p !== t); break;
      }
      case 'start':
        if (!isHost || s.phase !== 'lobby') return;
        if (s.players.filter((p) => p.connected).length < this.M.min) return;
        await this.M.start(this); return;
      case 'again':
        if (!isHost || s.phase !== 'results') return;
        s.phase = 'lobby'; s.game = null; s.view = null; s.final = null;
        s.players = s.players.filter((p) => p.connected);
        this.cancelTasks(); this.clearStored().catch(() => {}); this.ensureHost(); break;
      case 'submit': return this.M.onSubmit(this, me, m);
      default: await this.M.onMessage(this, me, m); return;
    }
    this.broadcastState(); this.save();
  }
  async clearStored() {
    const st = this.ctx.storage;
    for (const prefix of ['ent:', 'sub:', 'fg:', 'pn:', 'fa']) {
      const keys = [...(await st.list({ prefix })).keys()];
      for (let i = 0; i < keys.length; i += 128) await st.delete(keys.slice(i, i + 128));
    }
  }

  publicState() {
    const s = this.s, g = s.game;
    return {
      t: 'state', phase: s.phase, hostId: s.hostId, settings: s.settings, min: this.M.min, max: MAX_PLAYERS,
      players: s.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, connected: p.connected, done: !!(g && s.phase === 'play' && g.submitted && g.submitted[p.id]) })),
      game: g ? { gid: g.gid, mode: g.mode, order: g.order, ...this.M.pub(this, g) } : null,
      view: s.phase === 'results' ? s.view : null,
      final: s.phase === 'results' ? s.final : null,
    };
  }
  broadcastState() { this.broadcast(this.publicState()); }
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
    return new Response('Garlic Phone server is running.', { headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } });
  },
};
