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
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const WORLD = 4000;
const TICK_RATE = 1000 / 30;        // 30 ticks per second
const MAX_FOOD = 600;
const MAX_PLAYERS = 40;
const VIEW_RADIUS = 1800;
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
    speed: 2.6,
    score: 10,
    boosting: false,
    alive: true,
    deadTimer: 0,
    respawnDelay: 0,
    maxLength: 10
  };
  for (let i = 0; i < p.maxLength; i++) {
    p.segments.push({ x: x - i * p.radius * 0.65, y });
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

  // bounce off walls
  if (nx <= -WORLD / 2 || nx >= WORLD / 2) p.angle = Math.PI - p.angle;
  if (ny <= -WORLD / 2 || ny >= WORLD / 2) p.angle = -p.angle;

  p.x = nx;
  p.y = ny;
  p.segments.unshift({ x: p.x, y: p.y });

  p.score = Math.max(10, p.score);
  p.radius = 10 + Math.log10(p.score) * 3.2;
  const spacing = p.radius * 0.65;
  p.maxLength = Math.max(10, Math.floor(p.score * 1.2));
  p.segments = resampleSegments(p.segments, { x: p.x, y: p.y }, p.maxLength, spacing);
}

function killPlayer(p) {
  if (!p.alive) return;
  p.alive = false;
  p.deadTimer = 0;
  p.respawnDelay = rand(0, 4);
  // drop food along body
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
    p.segments.push({ x: x - i * p.radius * 0.65, y });
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

  // snake-vs-snake collisions
  const ids = Object.keys(players);
  for (let i = 0; i < ids.length; i++) {
    const p = players[ids[i]];
    if (!p.alive) continue;
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const q = players[ids[j]];
      if (!q.alive) continue;
      const minR = p.radius + q.radius;
      const minR2 = minR * minR;
      for (const seg of q.segments) {
        if (dist2({ x: p.x, y: p.y }, seg) < minR2) {
          killPlayer(p);
          break;
        }
      }
      if (!p.alive) break;
    }
  }

  // build player list once
  const playerList = ids.map(id => {
    const p = players[id];
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      angle: p.angle,
      radius: p.radius,
      score: Math.floor(p.score),
      alive: p.alive,
      segments: p.segments
    };
  });

  // send state to each player with only nearby food
  for (const id of ids) {
    const p = players[id];
    const visibleFoods = [];
    for (const f of foods) {
      if (Math.abs(f.x - p.x) < VIEW_RADIUS && Math.abs(f.y - p.y) < VIEW_RADIUS) {
        visibleFoods.push(f);
      }
    }
    io.to(id).emit('state', {
      t: Date.now(),
      world: WORLD,
      foods: visibleFoods,
      players: playerList
    });
  }
}

// fill initial food
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
