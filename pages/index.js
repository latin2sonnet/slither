import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const stateRef = useRef(null);
  const myIdRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0, down: false });
  const cameraRef = useRef({ x: 0, y: 0, scale: 1 });
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

  // Load saved defaults
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedName = localStorage.getItem('slither-name');
    const savedUrl = localStorage.getItem('slither-server');
    if (savedName) setName(savedName);
    if (savedUrl) setServerUrl(savedUrl);

    const resize = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = window.innerWidth;
      c.height = window.innerHeight;
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
      });

      socket.on('disconnect', () => {
        connectedRef.current = false;
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
    const c = canvasRef.current;
    if (!c) return;
    const cx = c.width / 2;
    const cy = c.height / 2;
    const angle = Math.atan2(mouseRef.current.y - cy, mouseRef.current.x - cx);
    socket.emit('input', { angle, boost: mouseRef.current.down });
  }

  function updateUI() {
    const state = stateRef.current;
    if (!state) return;
    const me = state.players.find((p) => p.id === myIdRef.current);
    if (me) {
      if (overlayVisible) setOverlayVisible(false);
      setScore(Math.floor(me.score));
    } else {
      if (!overlayVisible && connectedRef.current) setOverlayVisible(true);
    }

    const board = state.players.slice().sort((a, b) => b.score - a.score).slice(0, 8);
    setLeaderboard(board);
  }

  function drawSnake(s) {
    if (!s.alive || !s.segments || s.segments.length < 2) return;
    const ctx = canvasRef.current.getContext('2d');
    const baseR = s.radius;

    ctx.beginPath();
    ctx.moveTo(s.segments[0].x, s.segments[0].y);
    for (let i = 1; i < s.segments.length; i++) ctx.lineTo(s.segments[i].x, s.segments[i].y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = baseR * 2;
    ctx.strokeStyle = s.color;
    ctx.stroke();

    ctx.lineWidth = baseR * 1.15;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.stroke();

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
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(eye1.x, eye1.y, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(eye2.x, eye2.y, eyeR, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#111';
    const pupilR = eyeR * 0.4;
    ctx.beginPath(); ctx.arc(eye1.x + Math.cos(a) * pupilR * 0.6, eye1.y + Math.sin(a) * pupilR * 0.6, pupilR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(eye2.x + Math.cos(a) * pupilR * 0.6, eye2.y + Math.sin(a) * pupilR * 0.6, pupilR, 0, Math.PI * 2); ctx.fill();

    ctx.font = `bold ${Math.max(12, baseR * 0.9)}px 'Segoe UI',sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillText(s.name, head.x, head.y - baseR - 5);
    ctx.fillStyle = '#fff';
    ctx.fillText(s.name, head.x, head.y - baseR - 6);
  }

  function draw() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, c.width, c.height);

    const state = stateRef.current;
    if (!state) return;

    const me = state.players.find((p) => p.id === myIdRef.current);
    if (me) {
      cameraRef.current.x += (me.x - cameraRef.current.x) * 0.12;
      cameraRef.current.y += (me.y - cameraRef.current.y) * 0.12;
      const targetScale = 1 / (1 + Math.log10(Math.max(10, me.score)) * 0.08);
      cameraRef.current.scale += (targetScale - cameraRef.current.scale) * 0.05;
    }

    ctx.save();
    const cx = c.width / 2;
    const cy = c.height / 2;
    ctx.translate(cx, cy);
    ctx.scale(cameraRef.current.scale, cameraRef.current.scale);
    ctx.translate(-cameraRef.current.x, -cameraRef.current.y);

    const gridSize = 80;
    const viewW = c.width / cameraRef.current.scale;
    const viewH = c.height / cameraRef.current.scale;
    const startX = Math.floor((cameraRef.current.x - viewW / 2) / gridSize) * gridSize;
    const startY = Math.floor((cameraRef.current.y - viewH / 2) / gridSize) * gridSize;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
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

    ctx.strokeStyle = 'rgba(100,180,255,0.25)';
    ctx.lineWidth = 8;
    ctx.strokeRect(-state.world / 2, -state.world / 2, state.world, state.world);

    if (state.foods) {
      for (const f of state.foods) {
        ctx.fillStyle = f.color;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    const snakes = state.players.slice().sort((a, b) => a.score - b.score);
    for (const s of snakes) drawSnake(s);

    ctx.restore();
  }

  // Input listeners
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onMove = (e) => {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
    };
    const onDown = () => (mouseRef.current.down = true);
    const onUp = () => (mouseRef.current.down = false);
    const onKeyDown = (e) => { if (e.code === 'Space') mouseRef.current.down = true; };
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
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
        <div className="score">Length: {score}</div>
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
        <div className="lengthBar"><div className="lengthBarFill" style={{ width: Math.min(100, (score / 200) * 100) + '%' }} /></div>
        <div className="controlsTip">Move mouse/finger to steer • Click / Space / hold to boost</div>
      </div>
    </>
  );
}
