const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  perMessageDeflate: false,
  maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3000;
const WORLD = 4000;
const TICK_RATE = 1000 / 30;
const MAX_FOOD = 500;
const MAX_PLAYERS = 30;
const MAX_SEGMENTS = 250;
const VIEW_RADIUS = 1800;
const CELL = 60;
const COLORS = ['#5be','#6b6','#f75','#f5c','#a6f','#fd6','#6ff','#f66','#9f7','#79f'];
const POWERUP_TYPES = ['cocaine', 'glock'];
const POWERUP_SPAWN_INTERVAL = 8000;
const MAX_POWERUPS = 5;
const COCAINE_DURATION = 5000;
const BULLET_SPEED = 18;
const BULLET_RADIUS = 5;
const BULLET_LIFE = 1800;
const FIRE_COOLDOWN = 160;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'slitheradmin';

let players = {};
let foods = [];
let powerups = [];
let bullets = [];
let nextFoodId = 1;
let nextPowerupId = 1;
let nextBulletId = 1;
const bannedIds = new Set();
const bannedNames = new Set();

function rand(a, b) { return Math.random() * (b - a) + a; }
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function findPlayerIdByName(name) {
  const n = String(name).toLowerCase();
  for (const id in players) {
    if (players[id].name.toLowerCase() === n) return id;
  }
  return null;
}

function kickByName(name) {
  const id = findPlayerIdByName(name);
  if (!id) return;
  const s = io.sockets.sockets.get(id);
  if (s) s.disconnect(true);
  delete players[id];
  console.log('admin kick:', name);
}

function banByName(name) {
  const id = findPlayerIdByName(name);
  bannedNames.add(String(name).toLowerCase());
  if (id) {
    bannedIds.add(id);
    const s = io.sockets.sockets.get(id);
    if (s) s.disconnect(true);
    delete players[id];
  }
  console.log('admin ban:', name);
}

function killByName(name) {
  const id = findPlayerIdByName(name);
  if (id && players[id]) killPlayer(players[id]);
  console.log('admin kill:', name);
}

function announce(msg) {
  io.emit('announce', String(msg).slice(0, 200));
}

function spawnFood(count = 1) {
  for (let i = 0; i < count; i++) {
    if (foods.length >= MAX_FOOD) break;
    foods.push({
      id: nextFoodId++,
      x: rand(-WORLD / 2, WORLD / 2),
      y: rand(-WORLD / 2, WORLD / 2),
      color: COLORS[Math.floor(rand(0, COLORS.length))],
      size: rand(3, 6),
      value: 1
    });
  }
}

function spawnPowerup(x, y) {
  if (powerups.length >= MAX_POWERUPS) return null;
  const type = POWERUP_TYPES[Math.floor(rand(0, POWERUP_TYPES.length))];
  const pu = {
    id: nextPowerupId++,
    type,
    x: x != null ? x : rand(-WORLD * 0.45, WORLD * 0.45),
    y: y != null ? y : rand(-WORLD * 0.45, WORLD * 0.45),
    radius: 14
  };
  powerups.push(pu);
  return pu;
}

setInterval(() => spawnPowerup(), POWERUP_SPAWN_INTERVAL);

function createPlayer(id, name) {
  const color = COLORS[Math.floor(rand(0, COLORS.length))];
  const x = rand(-WORLD * 0.4, WORLD * 0.4);
  const y = rand(-WORLD * 0.4, WORLD * 0.4);
  const angle = rand(0, Math.PI * 2);
  const p = {
    id,
    name: String(name || 'Snake').slice(0, 18),
    color,
    x,
    y,
    angle,
    targetAngle: angle,
    segments: [],
    radius: 12,
    speed: 5,
    score: 10,
    boosting: false,
    alive: true,
    deadTimer: 0,
    respawnDelay: 0,
    maxLength: 10,
    cocaineTimer: 0,
    ammo: 0,
    fireCooldown: 0
  };
  for (let i = 0; i < p.maxLength; i++) {
    p.segments.push({ x: x - i * p.radius * 0.7, y });
  }
  return p;
}

function resampleSegments(segments, head, maxLength, spacing) {
  const out = [head];
  let i = 1;
  while (out.length < maxLength && i < segments.length) {
    const prev = out[out.length - 1];
    const cur = segments[i];
    const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    if (d >= spacing) {
      const t = spacing / d;
      out.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
    } else {
      i++;
    }
  }
  while (out.length < maxLength) {
    const last = segments[segments.length - 1] || out[out.length - 1] || head;
    out.push({ x: last.x, y: last.y });
  }
  return out;
}

function updatePlayer(p) {
  if (!p.alive) {
    p.deadTimer += TICK_RATE;
    if (p.deadTimer > 2500 + p.respawnDelay * 1000) respawnPlayer(p);
    return;
  }

  const boost = p.boosting && p.score > 15;
  const coked = p.cocaineTimer > 0;
  let mult = 1;
  if (coked) mult *= 2.0;
  if (boost) mult *= 1.5;
  const speed = p.speed * mult;

  if (boost && Math.random() < 0.016) p.score = Math.max(10, p.score - 0.06);
  if (coked) p.cocaineTimer = Math.max(0, p.cocaineTimer - TICK_RATE);
  if (p.fireCooldown > 0) p.fireCooldown = Math.max(0, p.fireCooldown - TICK_RATE);

  let diff = p.targetAngle - p.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  diff = clamp(diff, -0.10, 0.10);
  p.angle += diff;

  let nx = p.x + Math.cos(p.angle) * speed;
  let ny = p.y + Math.sin(p.angle) * speed;
  nx = clamp(nx, -WORLD / 2, WORLD / 2);
  ny = clamp(ny, -WORLD / 2, WORLD / 2);

  if (nx <= -WORLD / 2 || nx >= WORLD / 2) p.angle = Math.PI - p.angle;
  if (ny <= -WORLD / 2 || ny >= WORLD / 2) p.angle = -p.angle;

  p.x = nx;
  p.y = ny;
  p.segments.unshift({ x: p.x, y: p.y });

  p.score = Math.max(10, p.score);
  p.radius = 10 + Math.log10(p.score) * 3.2;
  const spacing = p.radius * 0.7;
  p.maxLength = Math.min(MAX_SEGMENTS, Math.max(10, Math.floor(p.score * 1.2)));
  p.segments = resampleSegments(p.segments, { x: p.x, y: p.y }, p.maxLength, spacing);
}

function killPlayer(p) {
  if (!p.alive) return;
  p.alive = false;
  p.deadTimer = 0;
  p.respawnDelay = rand(0, 4);
  p.boosting = false;

  // Always make room so death loot actually spawns
  const dropCount = p.segments.length;
  while (foods.length > MAX_FOOD - dropCount) foods.shift();

  // Drop a food pellet for every segment so the killer grows big
  for (const s of p.segments) {
    foods.push({
      id: nextFoodId++,
      x: s.x + rand(-10, 10),
      y: s.y + rand(-10, 10),
      color: p.color,
      size: rand(4, 7),
      value: 2
    });
  }

  // Small chance to drop a powerup from the corpse
  if (Math.random() < 0.3) spawnPowerup(p.x, p.y);

  console.log('killPlayer', p.id, 'dropped', dropCount, 'food. total:', foods.length);
}

function respawnPlayer(p) {
  p.alive = true;
  p.score = 10;
  p.radius = 12;
  p.deadTimer = 0;
  p.boosting = false;
  p.cocaineTimer = 0;
  p.fireCooldown = 0;
  const x = rand(-WORLD * 0.4, WORLD * 0.4);
  const y = rand(-WORLD * 0.4, WORLD * 0.4);
  p.x = x;
  p.y = y;
  p.angle = rand(0, Math.PI * 2);
  p.targetAngle = p.angle;
  p.segments = [];
  p.maxLength = 10;
  for (let i = 0; i < p.maxLength; i++) {
    p.segments.push({ x: x - i * p.radius * 0.7, y });
  }
}

function gridKey(x, y) {
  return `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
}

function buildSegmentGrid() {
  const grid = new Map();
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    for (const seg of p.segments) {
      const k = gridKey(seg.x, seg.y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ id, x: seg.x, y: seg.y });
    }
  }
  return grid;
}

function checkSnakeCollisions(grid) {
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    const cx = Math.floor(p.x / CELL);
    const cy = Math.floor(p.y / CELL);
    let killed = false;
    for (let gx = cx - 1; gx <= cx + 1 && !killed; gx++) {
      for (let gy = cy - 1; gy <= cy + 1 && !killed; gy++) {
        const list = grid.get(`${gx},${gy}`);
        if (!list) continue;
        for (const seg of list) {
          if (seg.id === p.id) continue;
          const q = players[seg.id];
          const minR = p.radius + q.radius;
          if (dist2({ x: p.x, y: p.y }, seg) < minR * minR) {
            killPlayer(p);
            killed = true;
            break;
          }
        }
      }
    }
  }
}

function checkBulletCollisions(grid) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const cx = Math.floor(b.x / CELL);
    const cy = Math.floor(b.y / CELL);
    let hit = false;
    for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++) {
      for (let gy = cy - 1; gy <= cy + 1 && !hit; gy++) {
        const list = grid.get(`${gx},${gy}`);
        if (!list) continue;
        for (const seg of list) {
          if (seg.id === b.ownerId) continue;
          const q = players[seg.id];
          const minR = BULLET_RADIUS + q.radius;
          if (dist2({ x: b.x, y: b.y }, seg) < minR * minR) {
            killPlayer(q);
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) bullets.splice(i, 1);
  }
}

function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += Math.cos(b.angle) * BULLET_SPEED;
    b.y += Math.sin(b.angle) * BULLET_SPEED;
    b.life -= TICK_RATE;
    if (
      b.life <= 0 ||
      b.x < -WORLD / 2 || b.x > WORLD / 2 ||
      b.y < -WORLD / 2 || b.y > WORLD / 2
    ) {
      bullets.splice(i, 1);
    }
  }
}

function checkPowerups() {
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    for (let i = powerups.length - 1; i >= 0; i--) {
      const pu = powerups[i];
      const r = p.radius + pu.radius;
      if (dist2({ x: p.x, y: p.y }, pu) < r * r) {
        if (pu.type === 'cocaine') {
          p.cocaineTimer = COCAINE_DURATION;
        } else if (pu.type === 'glock') {
          p.ammo = (p.ammo || 0) + 12;
        }
        powerups.splice(i, 1);
      }
    }
  }
}

function shootBullet(p) {
  if (!p || !p.alive) return;
  if ((p.ammo || 0) <= 0) return;
  if (p.fireCooldown > 0) return;
  p.ammo--;
  p.fireCooldown = FIRE_COOLDOWN;
  bullets.push({
    id: nextBulletId++,
    ownerId: p.id,
    x: p.x,
    y: p.y,
    angle: p.angle,
    life: BULLET_LIFE,
    radius: BULLET_RADIUS
  });
}

function gameTick() {
  for (const id in players) updatePlayer(players[id]);

  // food collisions
  let eaten = 0;
  for (let i = foods.length - 1; i >= 0; i--) {
    const f = foods[i];
    for (const id in players) {
      const p = players[id];
      if (!p.alive) continue;
      const d2 = dist2({ x: p.x, y: p.y }, f);
      const eatR = p.radius + f.size + 4;
      if (d2 < eatR * eatR) {
        p.score += f.value;
        foods.splice(i, 1);
        eaten++;
        break;
      }
    }
  }
  spawnFood(eaten);

  const grid = buildSegmentGrid();
  checkSnakeCollisions(grid);
  updateBullets();
  checkBulletCollisions(grid);
  checkPowerups();

  // emit visible state per player
  const ids = Object.keys(players);
  for (const id of ids) {
    const viewer = players[id];
    const px = viewer.x;
    const py = viewer.y;

    const visiblePlayers = [];
    for (const otherId of ids) {
      const q = players[otherId];
      if (Math.abs(q.x - px) < VIEW_RADIUS && Math.abs(q.y - py) < VIEW_RADIUS) {
        visiblePlayers.push({
          id: q.id,
          name: q.name,
          color: q.color,
          x: q.x,
          y: q.y,
          angle: q.angle,
          radius: q.radius,
          score: Math.floor(q.score),
          alive: q.alive,
          boosting: q.boosting,
          cocaineTimer: q.cocaineTimer,
          ammo: q.ammo,
          segments: q.segments
        });
      }
    }

    const inView = (o) => Math.abs(o.x - px) < VIEW_RADIUS && Math.abs(o.y - py) < VIEW_RADIUS;

    io.to(id).emit('state', {
      t: Date.now(),
      world: WORLD,
      foods: foods.filter(inView),
      powerups: powerups.filter(inView),
      bullets: bullets.filter(inView),
      players: visiblePlayers
    });
  }
}

spawnFood(MAX_FOOD);
setInterval(gameTick, TICK_RATE);

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('join', (name) => {
    if (Object.keys(players).length >= MAX_PLAYERS) {
      socket.emit('error', 'Server is full');
      return;
    }
    const cleanName = String(name || 'Snake');
    if (bannedIds.has(socket.id) || bannedNames.has(cleanName.toLowerCase())) {
      socket.emit('error', 'You are banned');
      socket.disconnect(true);
      return;
    }
    players[socket.id] = createPlayer(socket.id, name);
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p) return;
    if (typeof data.angle === 'number') p.targetAngle = data.angle;
    if (typeof data.boost === 'boolean') p.boosting = data.boost;
    if (data.shoot) shootBullet(p);
  });

  socket.on('admin', ({ password, action, target }) => {
    if (password !== ADMIN_PASSWORD) return;
    if (action === 'kick') kickByName(target);
    else if (action === 'ban') banByName(target);
    else if (action === 'kill') killByName(target);
    else if (action === 'announce') announce(target);
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    delete players[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`Slither server listening on port ${PORT}`);
});
