import { useEffect, useRef, useState } from 'react';

const RENDER_DELAY = 100; // ms behind newest snapshot
const SNAPSHOT_BUFFER = 8;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function cloneSegments(segs) {
  if (!segs) return [];
  return segs.map((s) => ({ x: s.x, y: s.y }));
}

function interpolateStates(a, b, alpha) {
  // Interpolate players
  const players = [];
  const oldMap = new Map((a.players || []).map((p) => [p.id, p]));

  for (const np of b.players || []) {
    const op = oldMap.get(np.id);
    if (op && op.alive === np.alive) {
      const p = { ...np };
      p.x = lerp(op.x, np.x, alpha);
      p.y = lerp(op.y, np.y, alpha);
      p.angle = lerpAngle(op.angle, np.angle, alpha);
      p.radius = lerp(op.radius || 12, np.radius || 12, alpha);
      p.score = lerp(op.score || 0, np.score || 0, alpha);

      const len = Math.max(op.segments?.length || 0, np.segments?.length || 0);
      p.segments = [];
      for (let i = 0; i < len; i++) {
        const os = op.segments?.[i];
        const ns = np.segments?.[i];
        if (os && ns) {
          p.segments.push({ x: lerp(os.x, ns.x, alpha), y: lerp(os.y, ns.y, alpha) });
        } else if (ns) {
          p.segments.push({ x: ns.x, y: ns.y });
        } else if (os) {
          p.segments.push({ x: os.x, y: os.y });
        }
      }
      players.push(p);
    } else {
      players.push({ ...np, segments: cloneSegments(np.segments) });
    }
  }

  // Interpolate food
  const foods = [];
  const oldFoodMap = new Map((a.foods || []).map((f) => [f.id, f]));
  for (const nf of b.foods || []) {
    const of = oldFoodMap.get(nf.id);
    if (of) {
      foods.push({ ...nf, x: lerp(of.x, nf.x, alpha), y: lerp(of.y, nf.y, alpha) });
    } else {
      foods.push({ ...nf });
    }
  }

  return {
    world: b.world,
    players,
    foods,
    powerups: b.powerups || [],
    bullets: b.bullets || []
  };
}

export default function Home() {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const stateRef = useRef(null);
  const snapshotsRef = useRef([]);
  const myIdRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0, down: false });
  const shootRef = useRef(false);
  const cameraRef = useRef({ x: 0, y: 0, scale: 1 });
  const dprRef = useRef(1);
  const rafRef = useRef(null);
  const uiTimerRef = useRef(null);
  const connectedRef = useRef(false);

  const [name, setName] = useState('Snake');
  const [serverUrl, setServerUrl] = useState('http://localhost:3000');
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [status, setStatus] = useState('');
  const [playDisabled, setPlayDisabled] = useState(false);
  const [score, setScore] = useState(10);
  const [leaderboard, setLeaderboard] = useState([]);
  const [hud, setHud] = useState({ ammo: 0, cocaine: 0 });
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminPwd, setAdminPwd] = useState('');
  const [adminAction, setAdminAction] = useState('kick');
  const [adminTarget, setAdminTarget] = useState('');
  const [announce, setAnnounce] = useState('');

  // Load saved defaults and set up HiDPI canvas
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedName = localStorage.getItem('slither-name');
    const savedUrl = localStorage.getItem('slither-server');
    if (savedName) setName(savedName);
    if (savedUrl) setServerUrl(savedUrl);

    const resize = () => {
      const c = canvasRef.current;
      if (!c) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      dprRef.current = dpr;
      c.width = Math.floor(window.innerWidth * dpr);
      c.height = Math.floor(window.innerHeight * dpr);
      c.style.width = window.innerWidth + 'px';
      c.style.height = window.innerHeight + 'px';
    };
    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (uiTimerRef.current) clearInterval(uiTimerRef.current);
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  // Start render + UI refresh loops once
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const loop = () => {
      sendInput();
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    uiTimerRef.current = setInterval(() => {
      updateUI();
    }, 150);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (uiTimerRef.current) clearInterval(uiTimerRef.current);
    };
  }, []);

  function setStatusMsg(msg) {
    setStatus(msg);
  }

  async function connect() {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    const url = serverUrl.trim() || 'http://localhost:3000';
    setPlayDisabled(true);
    setStatusMsg('Connecting to ' + url + '...');

    try {
      const { io } = await import('socket.io-client');
      const socket = io(url, { transports: ['websocket', 'polling'], reconnection: true });
      socketRef.current = socket;

      socket.on('connect', () => {
        myIdRef.current = socket.id;
        connectedRef.current = true;
        setStatusMsg('Connected. Joining game...');
        socket.emit('join', name.trim() || 'Snake');
      });

      socket.on('state', (s) => {
        stateRef.current = s;
        const now = performance.now();
        const snaps = snapshotsRef.current;
        snaps.push({ t: now, state: s });
        while (snaps.length > SNAPSHOT_BUFFER) snaps.shift();
      });

      socket.on('disconnect', () => {
        connectedRef.current = false;
        snapshotsRef.current = [];
        setOverlayVisible(true);
        setStatusMsg('Disconnected from server.');
        setPlayDisabled(false);
      });

      socket.on('connect_error', (err) => {
        setStatusMsg('Connection error: ' + err.message);
        setPlayDisabled(false);
      });

      socket.on('error', (msg) => {
        setStatusMsg('Server error: ' + msg);
        setPlayDisabled(false);
      });

      socket.on('announce', (msg) => {
        setAnnounce(msg);
        setTimeout(() => setAnnounce(''), 4000);
      });
    } catch (err) {
      setStatusMsg('Failed to load socket client: ' + err.message);
      setPlayDisabled(false);
    }
  }

  function handlePlay() {
    if (typeof window !== 'undefined') {
      localStorage.setItem('slither-name', name);
      localStorage.setItem('slither-server', serverUrl);
    }
    if (!connectedRef.current) {
      connect();
    } else if (socketRef.current) {
      socketRef.current.emit('join', name.trim() || 'Snake');
    }
  }

  function sendInput() {
    const socket = socketRef.current;
    if (!socket || !connectedRef.current) return;
    if (typeof window === 'undefined') return;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const angle = Math.atan2(mouseRef.current.y - cy, mouseRef.current.x - cx);
    const shoot = shootRef.current;
    shootRef.current = false;
    socket.emit('input', { angle, boost: mouseRef.current.down, shoot });
  }

  function updateUI() {
    const state = stateRef.current;
    if (!state) return;
    const me = state.players.find((p) => p.id === myIdRef.current);
    if (me) {
      if (overlayVisible) setOverlayVisible(false);
      setScore(Math.floor(me.score));
      setHud({ ammo: me.ammo || 0, cocaine: me.cocaineTimer || 0 });
    } else {
      if (!overlayVisible && connectedRef.current) setOverlayVisible(true);
      setHud({ ammo: 0, cocaine: 0 });
    }

    const board = state.players.slice().sort((a, b) => b.score - a.score).slice(0, 8);
    setLeaderboard(board);
  }

  function getInterpolatedState() {
    const snaps = snapshotsRef.current;
    if (snaps.length === 0) return null;
    const now = performance.now();
    const renderTime = now - RENDER_DELAY;

    if (renderTime <= snaps[0].t) return snaps[0].state;
    if (renderTime >= snaps[snaps.length - 1].t) return snaps[snaps.length - 1].state;

    for (let i = 0; i < snaps.length - 1; i++) {
      const a = snaps[i];
      const b = snaps[i + 1];
      if (renderTime >= a.t && renderTime < b.t) {
        const alpha = (renderTime - a.t) / (b.t - a.t);
        return interpolateStates(a.state, b.state, alpha);
      }
    }
    return snaps[snaps.length - 1].state;
  }

  function buildPath(ctx, segments) {
    ctx.beginPath();
    ctx.moveTo(segments[0].x, segments[0].y);
    for (let i = 1; i < segments.length; i++) {
      ctx.lineTo(segments[i].x, segments[i].y);
    }
  }

  function drawSnake(s) {
    if (!s.alive || !s.segments || s.segments.length < 2) return;
    const ctx = canvasRef.current.getContext('2d');
    const baseR = s.radius;

    buildPath(ctx, s.segments);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Neon glow shadow
    const coked = (s.cocaineTimer || 0) > 0;
    ctx.save();
    ctx.shadowBlur = baseR * ((s.boosting || coked) ? 3.0 : 1.6);
    ctx.shadowColor = coked ? '#ffffff' : s.color;

    // Dark outline
    ctx.lineWidth = baseR * 2.6;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();

    // Main colored body
    buildPath(ctx, s.segments);
    ctx.lineWidth = baseR * 2;
    ctx.strokeStyle = s.color;
    ctx.stroke();
    ctx.restore();

    // Glossy highlight
    buildPath(ctx, s.segments);
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.lineWidth = baseR * 0.75;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
    ctx.restore();

    // Boost trail particles near tail
    if (s.boosting && s.segments.length > 4) {
      ctx.save();
      ctx.shadowBlur = 10;
      ctx.shadowColor = s.color;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      for (let i = 1; i <= 4; i++) {
        const seg = s.segments[s.segments.length - i * 3];
        if (!seg) continue;
        ctx.beginPath();
        ctx.arc(seg.x, seg.y, baseR * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Eyes
    const head = s.segments[0];
    const a = s.angle;
    const perp = a + Math.PI / 2;
    const eyeR = baseR * 0.55;
    const eyeDist = baseR * 0.55;
    const eye1 = {
      x: head.x + Math.cos(a) * eyeDist + Math.cos(perp) * eyeR * 0.9,
      y: head.y + Math.sin(a) * eyeDist + Math.sin(perp) * eyeR * 0.9
    };
    const eye2 = {
      x: head.x + Math.cos(a) * eyeDist - Math.cos(perp) * eyeR * 0.9,
      y: head.y + Math.sin(a) * eyeDist - Math.sin(perp) * eyeR * 0.9
    };

    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.arc(eye1.x, eye1.y, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(eye2.x, eye2.y, eyeR, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#111';
    ctx.shadowBlur = 0;
    const pupilR = eyeR * 0.4;
    ctx.beginPath(); ctx.arc(eye1.x + Math.cos(a) * pupilR * 0.6, eye1.y + Math.sin(a) * pupilR * 0.6, pupilR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(eye2.x + Math.cos(a) * pupilR * 0.6, eye2.y + Math.sin(a) * pupilR * 0.6, pupilR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Name
    ctx.save();
    ctx.font = `bold ${Math.max(12, baseR * 0.9)}px 'Segoe UI',sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillText(s.name, head.x, head.y - baseR - 5);
    ctx.fillStyle = '#fff';
    ctx.fillText(s.name, head.x, head.y - baseR - 6);
    ctx.restore();
  }

  function sendAdmin() {
    const socket = socketRef.current;
    if (!socket) return;
    socket.emit('admin', { password: adminPwd, action: adminAction, target: adminTarget });
    setAdminTarget('');
  }

  function drawPowerup(ctx, pu) {
    ctx.save();
    ctx.translate(pu.x, pu.y);
    if (pu.type === 'cocaine') {
      ctx.shadowBlur = 20;
      ctx.shadowColor = '#ffffff';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-7, -9, 14, 18);
      ctx.fillStyle = '#999';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('C', 0, 0);
    } else {
      // Glock 17
      ctx.shadowBlur = 20;
      ctx.shadowColor = '#39ff14';
      ctx.fillStyle = '#2a2a2a';
      ctx.fillRect(-10, -4, 18, 6); // barrel/slide
      ctx.fillRect(2, 2, 5, 9);     // grip
      ctx.fillStyle = '#39ff14';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('G', 0, -7);
    }
    ctx.restore();
  }

  function drawBullet(ctx, b) {
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = '#ffea00';
    ctx.fillStyle = '#ffea00';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.arc(b.x - Math.cos(b.angle) * 8, b.y - Math.sin(b.angle) * 8, b.radius * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFood(ctx, f, now) {
    const pulse = 1 + Math.sin(now / 180 + f.id) * 0.12;
    const r = f.size * pulse;
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = f.color;
    const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r * 1.6);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.45, f.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r * 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function draw() {
    const c = canvasRef.current;
    if (!c || typeof window === 'undefined') return;
    const ctx = c.getContext('2d');
    const dpr = dprRef.current;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;

    // Vignette background
    const bg = ctx.createRadialGradient(cssW / 2, cssH / 2, 0, cssW / 2, cssH / 2, Math.max(cssW, cssH));
    bg.addColorStop(0, '#162030');
    bg.addColorStop(1, '#05070a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, c.width, c.height);

    const state = getInterpolatedState();
    if (!state) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    const me = state.players.find((p) => p.id === myIdRef.current);
    if (me) {
      cameraRef.current.x += (me.x - cameraRef.current.x) * 0.12;
      cameraRef.current.y += (me.y - cameraRef.current.y) * 0.12;
      const targetScale = 1 / (1 + Math.log10(Math.max(10, me.score)) * 0.08);
      cameraRef.current.scale += (targetScale - cameraRef.current.scale) * 0.05;
    }

    const cx = cssW / 2;
    const cy = cssH / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(cameraRef.current.scale, cameraRef.current.scale);
    ctx.translate(-cameraRef.current.x, -cameraRef.current.y);

    const gridSize = 80;
    const viewW = cssW / cameraRef.current.scale;
    const viewH = cssH / cameraRef.current.scale;
    const startX = Math.floor((cameraRef.current.x - viewW / 2) / gridSize) * gridSize;
    const startY = Math.floor((cameraRef.current.y - viewH / 2) / gridSize) * gridSize;

    ctx.save();
    ctx.strokeStyle = 'rgba(100,180,255,0.04)';
    ctx.lineWidth = 1;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    for (let x = startX; x < cameraRef.current.x + viewW / 2; x += gridSize) {
      ctx.moveTo(x, cameraRef.current.y - viewH / 2);
      ctx.lineTo(x, cameraRef.current.y + viewH / 2);
    }
    for (let y = startY; y < cameraRef.current.y + viewH / 2; y += gridSize) {
      ctx.moveTo(cameraRef.current.x - viewW / 2, y);
      ctx.lineTo(cameraRef.current.x + viewW / 2, y);
    }
    ctx.stroke();
    ctx.restore();

    // Glowing world border
    ctx.save();
    ctx.shadowBlur = 24;
    ctx.shadowColor = 'rgba(100,180,255,0.7)';
    ctx.strokeStyle = 'rgba(120,200,255,0.9)';
    ctx.lineWidth = 6;
    ctx.strokeRect(-state.world / 2, -state.world / 2, state.world, state.world);
    ctx.restore();

    const now = performance.now();

    if (state.foods) {
      for (const f of state.foods) {
        drawFood(ctx, f, now);
      }
    }

    if (state.powerups) {
      for (const pu of state.powerups) {
        drawPowerup(ctx, pu);
      }
    }

    if (state.bullets) {
      for (const b of state.bullets) {
        drawBullet(ctx, b);
      }
    }

    const snakes = state.players.slice().sort((a, b) => a.score - b.score);
    for (const s of snakes) drawSnake(s);

    ctx.restore(); // world transform
    ctx.restore(); // dpr scale
  }

  // Input listeners
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onMove = (e) => {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
    };
    const onDown = (e) => {
      if (e.button === 2) shootRef.current = true;
      else mouseRef.current.down = true;
    };
    const onUp = (e) => {
      if (e.button !== 2) mouseRef.current.down = false;
    };
    const onContextMenu = (e) => e.preventDefault();
    const onKeyDown = (e) => {
      if (e.code === 'Space') mouseRef.current.down = true;
      if (e.code === 'KeyE') shootRef.current = true;
      if (e.key === '`' || e.key === '~') {
        e.preventDefault();
        setAdminOpen((v) => !v);
      }
      if (e.code === 'Escape') setAdminOpen(false);
    };
    const onKeyUp = (e) => { if (e.code === 'Space') mouseRef.current.down = false; };
    const onTouchStart = (e) => {
      mouseRef.current.down = true;
      mouseRef.current.x = e.touches[0].clientX;
      mouseRef.current.y = e.touches[0].clientY;
    };
    const onTouchMove = (e) => {
      mouseRef.current.x = e.touches[0].clientX;
      mouseRef.current.y = e.touches[0].clientY;
      e.preventDefault();
    };
    const onTouchEnd = () => (mouseRef.current.down = false);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} />
      <div className="ui">
        <div className="hud">
          <div className="score">Length: {score}</div>
          {hud.ammo > 0 && <div className="ammo">Glock 17: {hud.ammo}</div>}
          {hud.cocaine > 0 && (
            <div className="cokeBar"><div className="cokeFill" style={{ width: Math.min(100, (hud.cocaine / 5000) * 100) + '%' }} /></div>
          )}
        </div>
        <div className="leaderboard">
          <h3>Leaderboard</h3>
          <ol>
            {leaderboard.map((p, i) => (
              <li key={p.id} style={{ color: p.id === myIdRef.current ? '#6be' : '#fff' }}>
                {i + 1}. {p.name} — {Math.floor(p.score)}
              </li>
            ))}
          </ol>
        </div>
        {overlayVisible && (
          <div className="overlay">
            <h1>Slither Clone</h1>
            <p>Next.js multiplayer prototype. Enter your name and server URL.</p>
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={18}
            />
            <input
              type="text"
              placeholder="Server URL"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
            <button onClick={handlePlay} disabled={playDisabled}>Play</button>
            <div className="status">{status}</div>
          </div>
        )}
        {adminOpen && (
          <div className="adminPanel">
            <h4>Admin</h4>
            <input
              type="password"
              placeholder="Password"
              value={adminPwd}
              onChange={(e) => setAdminPwd(e.target.value)}
            />
            <select value={adminAction} onChange={(e) => setAdminAction(e.target.value)}>
              <option value="kick">Kick</option>
              <option value="ban">Ban</option>
              <option value="kill">Kill</option>
              <option value="announce">Announce</option>
            </select>
            <input
              type="text"
              placeholder="Target name / message"
              value={adminTarget}
              onChange={(e) => setAdminTarget(e.target.value)}
            />
            <button onClick={sendAdmin}>Execute</button>
          </div>
        )}
        {announce && <div className="announcement">{announce}</div>}
        <div className="lengthBar"><div className="lengthBarFill" style={{ width: Math.min(100, (score / 200) * 100) + '%' }} /></div>
        <div className="controlsTip">Move to steer • Click/Space to boost • Right-click or E to shoot • Pick up C/G powerups</div>
      </div>
    </>
  );
}
