/**
 * Among Us IRL — single-file Node.js web app
 *
 * Run:
 *   node among-us-irl-server.js
 *
 * Open:
 *   http://localhost:3000
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const sseClients = new Map();

function id(len = 6) {
  return crypto.randomBytes(len).toString('hex').slice(0, len).toUpperCase();
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function getRoom(roomId) {
  return rooms.get(String(roomId || '').toUpperCase()) || null;
}

function publicPlayer(p, viewerId, isAdmin) {
  return {
    id: p.id,
    name: p.name,
    connected: p.connected,
    role: p.id === viewerId ? p.role : undefined,    isAdmin: !!p.isAdmin,
  };
}

function roomState(room, viewerId = null) {
  const viewer = viewerId ? room.players.find(p => p.id === viewerId) : null;
  const isAdmin = !!viewer?.isAdmin;

  return {
    roomId: room.roomId,
    started: room.started,
    meeting: room.meeting,
    createdAt: room.createdAt,
    adminConnected: room.players.some(p => p.isAdmin && p.connected),
    me: viewer
      ? {
          id: viewer.id,
          name: viewer.name,
          isAdmin: !!viewer.isAdmin,
          role: viewer.role || null,
        }
      : null,
    players: room.players.map(p => publicPlayer(p, viewerId, isAdmin)),
    counts: {
      total: room.players.length,
      connected: room.players.filter(p => p.connected).length,
      impostors: room.players.filter(p => p.role === 'impostor').length,
      crewmates: room.players.filter(p => p.role === 'crewmate').length,
    },
    settings: {
      impostors: room.settings.impostors,
      crewmates: room.settings.crewmates,
    },
    shareUrl: room.shareUrl,
  };
}

function broadcast(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const clients = sseClients.get(roomId) || new Set();
  const payloadCache = new Map();

  for (const res of clients) {
    const viewerId = res._viewerId || null;
    if (!payloadCache.has(viewerId)) payloadCache.set(viewerId, roomState(room, viewerId));
    const payload = payloadCache.get(viewerId);
    try {
      res.write(`event: state\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  }
}

function cleanupSSE(roomId, res) {
  const set = sseClients.get(roomId);
  if (set) set.delete(res);
}

function ensureRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) {
    const err = new Error('Room not found');
    err.statusCode = 404;
    throw err;
  }
  return room;
}

function requireAdmin(room, adminToken) {
  if (!adminToken || adminToken !== room.adminToken) {
    const err = new Error('Admin only');
    err.statusCode = 403;
    throw err;
  }
}

function assignRoles(room, impostorsCount, crewmatesCount) {
  const activePlayers = room.players.filter(p => p.connected);

  const total = activePlayers.length;

  if (impostorsCount + crewmatesCount !== total) {
    throw new Error(`Role counts must equal total connected players (${total}).`);
  }

  if (impostorsCount < 1) {
    throw new Error('There must be at least 1 impostor.');
  }

  if (crewmatesCount < 1) {
    throw new Error('There must be at least 1 crewmate.');
  }

  // 🔥 admin je normální hráč → JE V TOM
  const shuffled = [...activePlayers].sort(() => Math.random() - 0.5);

  const impostors = new Set(
    shuffled.slice(0, impostorsCount).map(p => p.id)
  );

  for (const p of room.players) {
    if (!p.connected) {
      p.role = null;
      continue;
    }

    p.role = impostors.has(p.id) ? 'impostor' : 'crewmate';
  }
}

function createRoomWithAdmin(name) {
  const roomId = id(6);
  const adminToken = crypto.randomBytes(16).toString('hex');
  const adminPlayerId = id(6);

  const room = {
    roomId,
    adminToken,
    createdAt: new Date().toISOString(),
    started: false,
    meeting: false,
    settings: { impostors: 1, crewmates: 1 },
    players: [
      {
        id: adminPlayerId,
        name: String(name || 'Admin').trim().slice(0, 24) || 'Admin',
        connected: true,
        isAdmin: true,
        role: null,
      },
    ],
    shareUrl: null,
  };

  room.shareUrl = `/?room=${encodeURIComponent(roomId)}`;
  rooms.set(roomId, room);
  return { room, adminPlayerId };
}

function joinRoom(room, name, isAdmin = false) {
  const playerId = id(6);
  const player = {
    id: playerId,
    name: String(name || 'Player').trim().slice(0, 24) || 'Player',
    connected: true,
    isAdmin: !!isAdmin,
    role: null,
  };
  room.players.push(player);
  return player;
}

const page = String.raw`<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Among Us IRL</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: rgba(18, 25, 48, 0.92);
      --panel2: rgba(26, 33, 64, 0.92);
      --text: #f4f7ff;
      --muted: #aab6df;
      --accent: #7c5cff;
      --accent2: #25d3ff;
      --danger: #ff5b7a;
      --success: #4ee59b;
      --line: rgba(255,255,255,.12);
      --shadow: 0 18px 50px rgba(0,0,0,.35);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(124,92,255,.28), transparent 28%),
        radial-gradient(circle at top right, rgba(37,211,255,.18), transparent 24%),
        radial-gradient(circle at bottom, rgba(255,91,122,.15), transparent 35%),
        var(--bg);
      color: var(--text);
    }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 20px; min-height: 100%; }
    .topbar {
      display:flex; gap:12px; align-items:center; justify-content:space-between;
      padding: 16px 18px; background: rgba(10,14,28,.65); border: 1px solid var(--line);
      border-radius: 22px; box-shadow: var(--shadow); backdrop-filter: blur(12px);
    }
    .brand { display:flex; gap:12px; align-items:center; }
    .logo {
      width: 46px; height: 46px; border-radius: 16px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      display:grid; place-items:center; font-weight: 900; color:#fff; letter-spacing:.5px;
      box-shadow: 0 10px 30px rgba(124,92,255,.35);
    }
    h1 { margin: 0; font-size: 20px; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 3px; }
    .grid { display:grid; grid-template-columns: 1.2fr .8fr; gap: 16px; margin-top: 16px; }
    .card {
      background: var(--panel); border: 1px solid var(--line); border-radius: 22px;
      box-shadow: var(--shadow); padding: 18px; backdrop-filter: blur(12px);
    }
    .card h2 { margin: 0 0 12px; font-size: 18px; }
    .muted { color: var(--muted); }
    .row { display:flex; gap: 12px; flex-wrap: wrap; }
    label { display:block; font-size: 13px; color: var(--muted); margin-bottom: 7px; }
    input {
      width: 100%; border: 1px solid var(--line); background: rgba(255,255,255,.05); color: var(--text);
      border-radius: 14px; padding: 12px 14px; font-size: 15px; outline: none;
    }
    input:focus { border-color: rgba(124,92,255,.7); box-shadow: 0 0 0 3px rgba(124,92,255,.12); }
    button {
      border: 0; border-radius: 14px; padding: 12px 16px; font-weight: 700; cursor: pointer;
      color: #08101d; background: linear-gradient(135deg, #fff, #dff3ff);
    }
    button.primary { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; }
    button.danger { background: linear-gradient(135deg, #ff6b86, #ff4d4d); color:#fff; }
    button.ghost { background: rgba(255,255,255,.08); color: var(--text); border: 1px solid var(--line); }
    button:disabled { opacity: .5; cursor:not-allowed; }
    .kpis { display:grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .kpi {
      background: var(--panel2); border: 1px solid var(--line); border-radius: 18px; padding: 12px;
    }
    .kpi .v { font-size: 24px; font-weight: 900; margin-top: 4px; }
    .kpi .l { color: var(--muted); font-size: 12px; }
    .list { display:grid; gap: 8px; margin-top: 12px; }
    .player {
      display:flex; justify-content:space-between; gap:12px; align-items:center;
      border: 1px solid var(--line); background: rgba(255,255,255,.04);
      padding: 12px 14px; border-radius: 16px;
    }
    .badge {
      display:inline-flex; align-items:center; gap:6px; padding: 6px 10px; border-radius: 999px; font-size: 12px; font-weight: 800;
      background: rgba(255,255,255,.08); border: 1px solid var(--line);
    }
    .badge.admin { background: rgba(124,92,255,.18); }
    .badge.me { background: rgba(37,211,255,.18); }
    .badge.impostor { background: rgba(255,91,122,.18); }
    .badge.crewmate { background: rgba(78,229,155,.16); }
    .split { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .status {
      margin-top: 12px; padding: 14px; border-radius: 18px; border: 1px solid var(--line);
      background: rgba(255,255,255,.05);
    }
    .status.big {
      padding: 18px; background: linear-gradient(135deg, rgba(124,92,255,.18), rgba(37,211,255,.12));
    }
    .role {
      font-size: 44px; font-weight: 1000; letter-spacing: .8px; text-transform: uppercase; margin: 8px 0 4px;
    }
    .role.crewmate { color: var(--success); }
    .role.impostor { color: var(--danger); }
    .overlay {
      position: fixed; inset: 0; display:none; align-items:center; justify-content:center; padding: 18px;
      background: rgba(4,8,18,.80); backdrop-filter: blur(8px); z-index: 50;
    }
    .overlay.show { display:flex; }
    .modal {
      max-width: 720px; width: 100%; border-radius: 28px; padding: 24px;
      background: linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,.06));
      border: 1px solid rgba(255,255,255,.15); box-shadow: var(--shadow); text-align:center;
    }
    .alarm {
      font-size: 48px; margin: 6px 0 12px;
      animation: pulse .75s infinite alternate;
    }
    @keyframes pulse { from { transform: scale(1); filter: drop-shadow(0 0 0 transparent); } to { transform: scale(1.05); filter: drop-shadow(0 0 12px rgba(255,91,122,.35)); } }
    .footerAction {
      position: fixed; left: 50%; transform: translateX(-50%);
      bottom: max(16px, env(safe-area-inset-bottom)); z-index: 40;
      width: min(94vw, 520px); display:none;
    }
    .footerAction.show { display:block; }
    .footerAction button {
      width: 100%; padding: 18px; border-radius: 22px; font-size: 18px; letter-spacing: 1px;
      box-shadow: 0 20px 40px rgba(255,91,122,.18);
    }
    .msg { margin-top: 12px; padding: 12px 14px; border-radius: 16px; background: rgba(255,255,255,.05); border: 1px solid var(--line); }
    .error { background: rgba(255,91,122,.14); border-color: rgba(255,91,122,.3); }
    .ok { background: rgba(78,229,155,.12); border-color: rgba(78,229,155,.25); }
    .small { font-size: 12px; color: var(--muted); }
    .hide { display:none !important; }
    .codebox {
      display:flex; gap: 8px; align-items:center; justify-content:space-between; flex-wrap: wrap;
      padding: 12px 14px; border: 1px dashed rgba(255,255,255,.18); border-radius: 16px; background: rgba(255,255,255,.04);
    }
    .link { word-break: break-all; color: #d5ebff; }
    .spacer { height: 88px; }
    @media (max-width: 840px) {
      .grid, .split, .kpis { grid-template-columns: 1fr; }
      .topbar { flex-direction: column; align-items:flex-start; }
      .role { font-size: 34px; }
    }
  </style>
</head>
<body>
  <div class="overlay" id="meetingOverlay">
    <div class="modal">
      <div class="alarm">🚨</div>
      <h2>MEETING!</h2>
      <p style="font-size:22px; font-weight:800; margin: 8px 0 12px;">Get yoo ass in the meeting room</p>
      <p class="muted" id="meetingInfo">The game is paused until the admin ends the meeting.</p>
      <div id="adminMeetingControls" class="hide" style="margin-top:16px;">
        <button class="danger" id="endMeetingBtn">End meeting</button>
      </div>
    </div>
  </div>

  <div class="footerAction" id="meetingBar">
    <button class="danger" id="meetingBtn">MEETING</button>
  </div>

  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="logo">AI</div>
        <div>
          <h1>Among Us IRL</h1>
          <div class="sub">Role assignment, live meeting alarm, and admin controls</div>
        </div>
      </div>
      <div class="row" style="align-items:center; justify-content:flex-end;">
        <span class="badge" id="roomBadge">No room</span>
        <button class="ghost" id="copyLinkBtn">Copy room link</button>
        <button class="ghost" id="leaveBtn">Leave</button>
      </div>
    </div>

    <div class="grid">
      <div class="card" id="mainCard">
        <h2 id="mainTitle">Join or create a room</h2>
        <div id="joinView">
          <div class="split">
            <div>
              <label>Your name</label>
              <input id="nameInput" placeholder="e.g. Jiří" maxlength="24" />
            </div>
            <div>
              <label>Room code</label>
              <input id="roomInput" placeholder="e.g. A1B2C3" maxlength="12" />
            </div>
          </div>
          <div class="row" style="margin-top:12px;">
            <button class="primary" id="joinBtn">Join room</button>
            <button id="createBtn">Create room as admin</button>
          </div>
          <div class="msg small" style="margin-top:14px;">
            Admin creates the room, shares the link, sets impostor/crewmate counts, and starts the game.
          </div>
        </div>

        <div id="gameView" class="hide">
          <div class="status big">
            <div class="small">Your identity</div>
            <div id="roleText" class="role">—</div>
            <div id="roleDesc" class="muted">Waiting for the game to start.</div>
          </div>

          <div id="meetingNotice" class="status hide" style="margin-top: 12px; border-color: rgba(255,91,122,.4);">
            <strong>Meeting is active.</strong> Go to the meeting room now.
          </div>

          <div class="kpis" style="margin-top:12px;">
            <div class="kpi"><div class="l">Players</div><div class="v" id="kPlayers">0</div></div>
            <div class="kpi"><div class="l">Connected</div><div class="v" id="kConnected">0</div></div>
            <div class="kpi"><div class="l">Impostors</div><div class="v" id="kImpostors">0</div></div>
            <div class="kpi"><div class="l">Crewmates</div><div class="v" id="kCrewmates">0</div></div>
          </div>

          <div class="msg" id="messageBox" style="margin-top:12px;">Create or join a room to begin.</div>
        </div>
      </div>

      <div class="card" id="sideCard">
        <h2>Admin panel</h2>
        <div id="adminView" class="hide">
          <div class="msg ok" id="adminHint">You are the admin.</div>
          <div class="split" style="margin-top: 12px;">
            <div>
              <label>Impostors</label>
              <input id="impostorCount" type="number" min="1" value="1" />
            </div>
            <div>
              <label>Crewmates</label>
              <input id="crewmateCount" type="number" min="1" value="1" />
            </div>
          </div>
          <div class="row" style="margin-top:12px;">
            <button class="primary" id="startBtn">Start game</button>
            <button class="danger" id="endMeetingBtnSide">End meeting</button>
          </div>
          <div class="small" style="margin-top:10px;">Role counts must match the number of connected players.</div>
        </div>
        <div id="nonAdminView" class="msg">Only the room creator can start the game or end a meeting.</div>

        <div style="margin-top:16px;">
          <h2 style="margin-top:0;">Room</h2>
          <div class="codebox">
            <div>
              <div class="small">Room code</div>
              <div style="font-size: 22px; font-weight: 900; letter-spacing: 2px;" id="roomCodeText">—</div>
            </div>
            <button class="ghost" id="copyRoomBtn">Copy</button>
          </div>
          <div class="codebox" style="margin-top:10px;">
          <div style="margin-top:12px; text-align:center;">
  <div class="small">Scan to join</div>
  <img id="qrCode" style="margin-top:8px; width:140px; height:140px; border-radius:12px;" />
</div>
            <div style="min-width: 0;">
              <div class="small">Share link</div>
              <div class="link" id="shareLinkText">—</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <h2>Players</h2>
      <div class="list" id="playersList"></div>
      <div class="spacer"></div>
    </div>
  </div>

  <script>
    const state = {
      roomId: null,
      playerId: null,
      adminToken: null,
      name: localStorage.getItem('amongus_name') || '',
      roomLink: null,
      sse: null,
      current: null,
      meetingWasActive: false,
    };

    const el = function(id) { return document.getElementById(id); };
    const joinView = el('joinView');
    const gameView = el('gameView');
    const adminView = el('adminView');
    const nonAdminView = el('nonAdminView');
    const roomBadge = el('roomBadge');
    const meetingOverlay = el('meetingOverlay');
    const meetingBar = el('meetingBar');
    const meetingNotice = el('meetingNotice');
    const adminMeetingControls = el('adminMeetingControls');

    el('nameInput').value = state.name;

    function setMessage(text, type) {
      const box = el('messageBox');
      box.className = 'msg' + (type ? ' ' + type : '');
      box.textContent = text;
    }

    function showRoomShell(isAdmin) {
      joinView.classList.add('hide');
      gameView.classList.remove('hide');
      adminView.classList.toggle('hide', !isAdmin);
      nonAdminView.classList.toggle('hide', isAdmin);
      el('mainTitle').textContent = 'Game lobby';
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function renderPlayers(players, meId) {
      const list = el('playersList');
      list.innerHTML = '';

      if (!players || !players.length) {
        list.innerHTML = '<div class="muted">No players yet.</div>';
        return;
      }

      for (const p of players) {
        const row = document.createElement('div');
        row.className = 'player';

        let html = '';
        html += '<div>';
        html += '<div style="font-weight:800; font-size:16px;">';
        html += escapeHtml(p.name);
        if (p.id === meId) html += ' <span class="badge me">you</span>';
        html += '</div>';
        html += '<div class="small">' + (p.connected ? 'Connected' : 'Offline') + ' • ' + (p.isAdmin ? 'Admin' : 'Player') + '</div>';
        html += '</div>';
        html += '<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">';
        html += '<span class="badge ' + (p.isAdmin ? 'admin' : '') + '">' + (p.isAdmin ? 'Admin 👑' : 'Player') + '</span>';
        html += '<span class="badge ' + (p.role || '') + '">' + (p.role ? p.role : 'role hidden') + '</span>';
        html += '</div>';

        row.innerHTML = html;
        list.appendChild(row);
      }
    }

    function playAlarm() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        const gain = ctx.createGain();
        gain.gain.value = 0.03;
        gain.connect(ctx.destination);

        let t = ctx.currentTime;
        for (let i = 0; i < 6; i++) {
          const osc = ctx.createOscillator();
          osc.type = 'square';
          osc.frequency.setValueAtTime(i % 2 === 0 ? 880 : 660, t);
          osc.connect(gain);
          osc.start(t);
          osc.stop(t + 0.15);
          t += 0.18;
        }
        setTimeout(function() { ctx.close().catch(function() {}); }, 2000);
      } catch (e) {
        console.warn('Audio failed', e);
      }
    }

    async function api(path, body) {
      const res = await fetch(window.location.origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch {}

      if (!res.ok) {
        throw new Error((data && data.error) ? data.error : text || 'Request failed');
      }

      return data;
    }

    function updateUI(data) {
      state.current = data;
      state.roomId = data.roomId;
      state.roomLink = data.shareUrl || (location.origin + '/?room=' + encodeURIComponent(data.roomId));

      roomBadge.textContent = data.roomId ? 'Room ' + data.roomId : 'No room';
      el('roomCodeText').textContent = data.roomId || '—';
      el('shareLinkText').textContent = state.roomLink;
      const qr = el('qrCode');
if (qr && state.roomLink) {
  qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(state.roomLink);
}
      el('copyLinkBtn').disabled = !state.roomLink;
      el('copyRoomBtn').disabled = !data.roomId;

      const me = data.me;
      const isAdmin = !!(me && me.isAdmin);
      const started = !!data.started;
      const meeting = !!data.meeting;

      if (me) {
        showRoomShell(isAdmin);
      }

      el('mainTitle').textContent = me ? 'Game lobby' : 'Join or create a room';

      el('kPlayers').textContent = data.counts.total;
      el('kConnected').textContent = data.counts.connected;
      el('kImpostors').textContent = data.counts.impostors;
      el('kCrewmates').textContent = data.counts.crewmates;

      if (!me) {
        el('roleText').textContent = '—';
        el('roleText').className = 'role';
        el('roleDesc').textContent = 'Join the room to get your role.';
      } else if (!started) {
        el('roleText').textContent = 'Waiting';
        el('roleText').className = 'role';
        el('roleDesc').textContent = 'You are in the lobby. The admin will start the game.';
      } else {
        el('roleText').textContent = me.role ? me.role : 'Unknown';
        el('roleText').className = 'role ' + (me.role || '');
        el('roleDesc').textContent = me.role === 'impostor'
          ? 'You are an impostor. Blend in.'
          : 'You are a crewmate. Complete the mission.';
      }

      meetingOverlay.classList.toggle('show', meeting);
      meetingNotice.classList.toggle('hide', !meeting);
      meetingBar.classList.toggle('show', !!me && started);
      adminMeetingControls.classList.toggle('hide', !isAdmin);

      renderPlayers(data.players, me ? me.id : null);

      if (meeting && !state.meetingWasActive) {
        playAlarm();
      }
      state.meetingWasActive = meeting;

      if (!started && me) {
        setMessage('The lobby is ready. Wait for the admin to start the game.', '');
      } else if (meeting) {
        setMessage('Meeting is active. The game is paused until the admin ends it.', 'error');
      } else if (me && me.role) {
        setMessage('Role assigned successfully. Use the MEETING button only when needed.', 'ok');
      }
    }

    function connectSSE(roomId, playerId) {
      if (state.sse) state.sse.close();

      const params = new URLSearchParams();
      params.set('roomId', roomId);
      params.set('playerId', playerId || '');
      if (state.adminToken) params.set('adminToken', state.adminToken);

      const sse = new EventSource('/events?' + params.toString());
      state.sse = sse;

      sse.addEventListener('state', function(ev) {
        const data = JSON.parse(ev.data);
        updateUI(data);
      });

      sse.onerror = function() {
        roomBadge.textContent = 'Reconnecting…';
      };
    }

    async function createRoom() {
      try {
        const name = el('nameInput').value.trim() || 'Admin';
        localStorage.setItem('amongus_name', name);

        const res = await api('/api/create-room', { name: name });

        state.roomId = res.roomId;
        state.playerId = res.playerId;
        state.adminToken = res.adminToken;

        showRoomShell(true);

        el('roomCodeText').textContent = res.roomId;
        el('shareLinkText').textContent = location.origin + res.roomLink;

        history.replaceState({}, '', res.adminLink);

        connectSSE(res.roomId, res.playerId);
        setMessage('Room created. Share the link with your friends.', 'ok');
      } catch (e) {
        alert(e.message);
      }
    }

    async function joinRoomAction() {
      try {
        const name = el('nameInput').value.trim();
        const roomId = el('roomInput').value.trim().toUpperCase();

        if (!name) return setMessage('Write your name first.', 'error');
        if (!roomId) return setMessage('Write the room code first.', 'error');

        localStorage.setItem('amongus_name', name);

        const res = await api('/api/join', { name: name, roomId: roomId });

        state.roomId = res.roomId;
        state.playerId = res.playerId;

        showRoomShell(false);

        el('roomCodeText').textContent = res.roomId;
        el('shareLinkText').textContent = location.origin + '/?room=' + encodeURIComponent(res.roomId);

        history.replaceState({}, '', '/?room=' + encodeURIComponent(res.roomId) + '&player=' + encodeURIComponent(res.playerId));

        connectSSE(res.roomId, res.playerId);
        setMessage('Joined the room.', 'ok');
      } catch (e) {
        alert(e.message);
      }
    }

    async function startGame() {
      try {
        const impostors = Number(el('impostorCount').value || 0);
        const crewmates = Number(el('crewmateCount').value || 0);

        await api('/api/start', {
          roomId: state.roomId,
          playerId: state.playerId,
          adminToken: state.adminToken,
          impostors: impostors,
          crewmates: crewmates,
        });

        setMessage('Game started.', 'ok');
      } catch (e) {
        setMessage(e.message, 'error');
      }
    }

    async function endMeeting() {
      try {
        await api('/api/end-meeting', {
          roomId: state.roomId,
          playerId: state.playerId,
          adminToken: state.adminToken,
        });
        setMessage('Meeting ended.', 'ok');
      } catch (e) {
        setMessage(e.message, 'error');
      }
    }

    async function triggerMeeting() {
      try {
        await api('/api/meeting', {
          roomId: state.roomId,
          playerId: state.playerId,
        });
        setMessage('Meeting called.', 'error');
      } catch (e) {
        setMessage(e.message, 'error');
      }
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        setMessage('Copied to clipboard.', 'ok');
      } catch {
        setMessage('Copy failed. Select and copy the text manually.', 'error');
      }
    }

    function leaveRoom() {
      if (state.sse) state.sse.close();
      state.sse = null;
      state.roomId = null;
      state.playerId = null;
      state.adminToken = null;
      state.current = null;
      state.meetingWasActive = false;
      history.replaceState({}, '', '/');
      location.reload();
    }

    el('joinBtn').addEventListener('click', joinRoomAction);
    el('createBtn').addEventListener('click', createRoom);
    el('startBtn').addEventListener('click', startGame);
    el('endMeetingBtn').addEventListener('click', endMeeting);
    el('endMeetingBtnSide').addEventListener('click', endMeeting);
    el('meetingBtn').addEventListener('click', triggerMeeting);

    el('copyRoomBtn').addEventListener('click', function() {
      if (state.current && state.current.roomId) copyText(state.current.roomId);
    });
    el('copyLinkBtn').addEventListener('click', function() {
      if (state.roomLink) copyText(state.roomLink);
    });
    el('leaveBtn').addEventListener('click', leaveRoom);

    (function init() {
      const params = new URLSearchParams(location.search);
      const room = (params.get('room') || '').trim().toUpperCase();
      const player = (params.get('player') || '').trim();
      const admin = (params.get('admin') || '').trim();

      if (admin) state.adminToken = admin;

      if (room && player) {
        state.roomId = room;
        state.playerId = player;
        showRoomShell(!!admin);
        el('roomCodeText').textContent = room;
        el('shareLinkText').textContent = location.origin + '/?room=' + encodeURIComponent(room);
        connectSSE(room, player);
        return;
      }

      if (room) el('roomInput').value = room;
      if (state.name) el('nameInput').value = state.name;
    })();
  </script>
</body>
</html>`;

function handleApiCreateRoom(req, res, body) {
  const name = String(body.name || 'Admin');
  const { room, adminPlayerId } = createRoomWithAdmin(name);

  const adminLink = `/?room=${encodeURIComponent(room.roomId)}&player=${encodeURIComponent(adminPlayerId)}&admin=${encodeURIComponent(room.adminToken)}`;
  room.shareUrl = `/?room=${encodeURIComponent(room.roomId)}`;

  broadcast(room.roomId);

  json(res, 200, {
    roomId: room.roomId,
    playerId: adminPlayerId,
    adminToken: room.adminToken,
    adminLink,
    roomLink: room.shareUrl,
  });
}

function handleApiJoin(req, res, body) {
  const roomId = String(body.roomId || '').toUpperCase();
  const name = String(body.name || 'Player');
  const room = ensureRoom(roomId);

  if (room.started) {
    const err = new Error('Game already started. Create a new room for additional players.');
    err.statusCode = 400;
    throw err;
  }

  let isAdmin = false;
  if (body.adminToken && String(body.adminToken) === room.adminToken) isAdmin = true;

  const player = joinRoom(room, name, isAdmin);
  if (isAdmin) room.adminToken = String(body.adminToken);

  broadcast(room.roomId);

  json(res, 200, {
    roomId: room.roomId,
    playerId: player.id,
    adminToken: isAdmin ? room.adminToken : undefined,
  });
}

function handleApiStart(req, res, body) {
  const room = ensureRoom(String(body.roomId || '').toUpperCase());
  requireAdmin(room, String(body.adminToken || ''));

  const connectedPlayers = room.players.filter(p => p.connected);
  const impostors = Number(body.impostors);
  const crewmates = Number(body.crewmates);

  if (!Number.isInteger(impostors) || !Number.isInteger(crewmates)) {
    const err = new Error('Impostor and crewmate counts must be whole numbers.');
    err.statusCode = 400;
    throw err;
  }
  if (connectedPlayers.length !== impostors + crewmates) {
    const err = new Error(`You have ${connectedPlayers.length} connected players. The role counts must total the same number.`);
    err.statusCode = 400;
    throw err;
  }

  room.settings.impostors = impostors;
  room.settings.crewmates = crewmates;
  assignRoles(room, impostors, crewmates);
  room.started = true;
  room.meeting = false;

  broadcast(room.roomId);
  json(res, 200, { ok: true });
}

function handleApiMeeting(req, res, body) {
  const room = ensureRoom(String(body.roomId || '').toUpperCase());
  if (!room.started) {
    const err = new Error('Start the game first.');
    err.statusCode = 400;
    throw err;
  }
  room.meeting = true;
  broadcast(room.roomId);
  json(res, 200, { ok: true });
}

function handleApiEndMeeting(req, res, body) {
  const room = ensureRoom(String(body.roomId || '').toUpperCase());
  requireAdmin(room, String(body.adminToken || ''));
  room.meeting = false;
  broadcast(room.roomId);
  json(res, 200, { ok: true });
}

function handleEvents(req, res, url) {
  const roomId = String(url.searchParams.get('roomId') || '').toUpperCase();
  const playerId = String(url.searchParams.get('playerId') || '');
  const adminToken = String(url.searchParams.get('adminToken') || '');
  const room = getRoom(roomId);

  if (!room) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Room not found');
    return;
  }

  const player = room.players.find(p => p.id === playerId);
  if (!player) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Player not found');
    return;
  }

  if (adminToken && adminToken === room.adminToken) player.isAdmin = true;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');
  res.flushHeaders?.();

  if (!sseClients.has(roomId)) sseClients.set(roomId, new Set());
  const set = sseClients.get(roomId);
  res._viewerId = playerId;
  set.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    cleanupSSE(roomId, res);
  });

  const payload = roomState(room, playerId);
  res.write(`event: state\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendHtml(res, page);
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    return handleEvents(req, res, url);
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });

    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}

      try {
        if (url.pathname === '/api/create-room') return handleApiCreateRoom(req, res, body);
        if (url.pathname === '/api/join') return handleApiJoin(req, res, body);
        if (url.pathname === '/api/start') return handleApiStart(req, res, body);
        if (url.pathname === '/api/meeting') return handleApiMeeting(req, res, body);
        if (url.pathname === '/api/end-meeting') return handleApiEndMeeting(req, res, body);
        return json(res, 404, { error: 'Not found' });
      } catch (err) {
        json(res, err.statusCode || 500, { error: err.message || 'Server error' });
      }
    });

    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
