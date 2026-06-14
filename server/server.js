const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  // keep payloads lean
  perMessageDeflate: false,
  maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3000;
const WORLD = 4000;
const TICK_RATE = 1000 / 30;        // 30 ticks per second
const MAX_FOOD = 500;
const MAX_PLAYERS = 30;
const MAX_SEGMENTS = 250;           // hard cap on physics/render points per snake
const VIEW_RADIUS = 1800;
const CELL = 60;                    // spatial grid cell size
const COLORS = ['#5be','#6b6','#f75','#f5c','#a6f','#fd6','#6ff','#f66','#9f7','#79f'];

let players = {};
let foods = [];
let nextFoodId = 1;

function rand(a, b) { return Math.random() * (b - a) + a; }
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

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
    speed: 2.8,
    score: 10,
    boosting: false,
    alive: true,
    deadTimer: 0,
    respawnDelay: 0,
    maxLength: 10
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
    if (p.deadTimer > 2500 + p.respawnDelay * 1000) {
      respawnPlayer(p);
    }
    return;
  }

  const boost = p.boosting && p.score > 15;
  const speed = p.speed * (boost ? 1.9 : 1);
  if (boost && Math.random() < 0.016) {
    p.score = Math.max(10, p.score - 0.06);
  }

  let diff = p.targetAngle - p.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  diff = clamp(diff, -0.06, 0.06);
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
  for (let i = 0; i < p.segments.length; i += 2) {
    const s = p.segments[i];
    if (foods.length >= MAX_FOOD) break;
    for (let k = 0; k < 2; k++) {
      if (foods.length >= MAX_FOOD) break;
      foods.push({
        id: nextFoodId++,
        x: s.x + rand(-8, 8),
        y: s.y + rand(-8, 8),
        color: p.color,
        size: rand(3, 6),
        value: 1.2
      });
    }
  }
}

function respawnPlayer(p) {
  p.alive = true;
  p.score = 10;
  p.radius = 12;
  p.deadTimer = 0;
  p.boosting = false;
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

function checkCollisions() {
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

function gameTick() {
  // movement
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

  // snake-vs-snake collisions (spatial grid)
  checkCollisions();

  // emit state per-player with only nearby entities
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
          segments: q.segments
        });
      }
    }

    const visibleFoods = [];
    for (const f of foods) {
      if (Math.abs(f.x - px) < VIEW_RADIUS && Math.abs(f.y - py) < VIEW_RADIUS) {
        visibleFoods.push(f);
      }
    }

    io.to(id).emit('state', {
      t: Date.now(),
      world: WORLD,
      foods: visibleFoods,
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
    players[socket.id] = createPlayer(socket.id, name);
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p) return;
    if (typeof data.angle === 'number') p.targetAngle = data.angle;
    if (typeof data.boost === 'boolean') p.boosting = data.boost;
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    delete players[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`Slither server listening on port ${PORT}`);
});
