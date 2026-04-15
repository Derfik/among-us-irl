/**
 * Among Us IRL — single-file Node.js web app
 *
 * Run:
 *   node among-us-irl-server.js
 *
 * Open:
 *   http://localhost:3000
 *
 * What it does:
 * - Players join by link in browser
 * - Admin creates a room and starts the game
 * - Admin chooses impostor/crewmate counts
 * - Roles are assigned randomly on start
 * - Everyone gets a MEETING button
 * - Meeting triggers an alarm + message on all devices
 * - Admin can end the meeting and continue
 *
 * Notes:
 * - Uses in-memory state only (restart clears games)
 * - Uses Server-Sent Events for live updates
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
    role: p.id === viewerId || isAdmin ? p.role : undefined,
    isAdmin: !!p.isAdmin,
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
    } catch (e) {
      // ignore broken stream; cleanup happens on close
    }
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
    const err = new Error(`Role counts must equal total connected players (${total}).`);
    err.statusCode = 400;
    throw err;
  }
  if (impostorsCount < 1) {
    const err = new Error('There must be at least 1 impostor.');
    err.statusCode = 400;
    throw err;
  }
  if (crewmatesCount < 1) {
    const err = new Error('There must be at least 1 crewmate.');
    err.statusCode = 400;
    throw err;
  }

  const shuffled = [...activePlayers].sort(() => Math.random() - 0.5);
  const impostors = new Set(shuffled.slice(0, impostorsCount).map(p => p.id));

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
const page = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Among Us IRL</title>
</head>

<body>

<h1>Among Us IRL</h1>

<input id="nameInput" placeholder="Your name">
<input id="roomInput" placeholder="Room code">

<br><br>

<button id="createBtn">Create Room</button>
<button id="joinBtn">Join Room</button>

<h2>Room:</h2>
<div id="roomCodeText"></div>

<h3>Share link:</h3>
<div id="shareLinkText"></div>

<h2>Players:</h2>
<div id="playersList"></div>

<script>

const state = {};

const el = id => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function connectSSE(roomId, playerId) {
  if (state.sse) state.sse.close();

  const sse = new EventSource('/events?roomId=' + roomId + '&playerId=' + playerId);
  state.sse = sse;

  sse.addEventListener('state', e => {
    const data = JSON.parse(e.data);

    el('playersList').innerHTML = '';
    data.players.forEach(p => {
      const div = document.createElement('div');
      div.textContent = p.name;
      el('playersList').appendChild(div);
    });

    el('roomCodeText').textContent = data.roomId;
    el('shareLinkText').textContent = location.origin + '/?room=' + data.roomId;
  });
}

async function createRoom() {
  try {
    const name = el('nameInput').value || 'Admin';
    const res = await api('/api/create-room', { name });

    connectSSE(res.roomId, res.playerId);

  } catch (e) {
    alert(e.message);
  }
}

async function joinRoom() {
  try {
    const name = el('nameInput').value;
    const roomId = el('roomInput').value;

    const res = await api('/api/join', { name, roomId });

    connectSSE(res.roomId, res.playerId);

  } catch (e) {
    alert(e.message);
  }
}

document.getElementById('createBtn').onclick = createRoom;
document.getElementById('joinBtn').onclick = joinRoom;

</script>

</body>
</html>
`;

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
