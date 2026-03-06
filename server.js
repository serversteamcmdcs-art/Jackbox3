/**
 * Jackbox Private Server
 * Supports:
 *   - Ecast / API v2  (Party Pack 7, 8, Drawful 2 International, etc.)
 *   - Blobcast / API v1 (Party Pack 1-6, Fibbage 1/2, Quiplash 1/2, etc.)
 *
 * Deploy to Render: set Start Command = "node server.js"
 */

const http = require("http");
const https = require("https");
const { WebSocketServer, WebSocket } = require("ws");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
// On Render this is auto-assigned; set to your onrender.com URL in env var
const HOST = process.env.ACCESSIBLE_HOST || process.env.RENDER_EXTERNAL_HOSTNAME || "localhost";
const USE_HTTPS = process.env.USE_HTTPS === "true"; // Render handles TLS for us

console.log(`Starting Jackbox server on ${HOST}:${PORT}`);

// ─── SHARED STATE ─────────────────────────────────────────────────────────────
// Blobcast rooms:  roomCode -> { host, clients, appTag, state, ... }
const blobcastRooms = new Map();
// Ecast rooms:     roomCode -> { host, audience, clients, appTag, state, ... }
const ecastRooms   = new Map();

function randomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function uniqueRoomCode(map) {
  let code;
  do { code = randomRoomCode(); } while (map.has(code));
  return code;
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  console.log(`HTTP: ${req.method} ${path}`);

  // ── Ecast / API v2 ──────────────────────────────────────────────────────────

  // App config
  if (path.match(/^\/api\/v2\/app-configs\//)) {
    const appTag = path.split("/").pop().split("?")[0];
    res.writeHead(200);
    res.end(JSON.stringify({
      appTag,
      blobcastHost: `${USE_HTTPS ? "https" : "http"}://${HOST}`,
      blobcastPort: PORT,
      serverUrl:    `${USE_HTTPS ? "wss" : "ws"}://${HOST}`,
      isTestServer: false,
    }));
    return;
  }

  // Create Ecast room
  if (path === "/api/v2/rooms" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body); } catch {}

      const code = uniqueRoomCode(ecastRooms);
      ecastRooms.set(code, {
        code,
        appTag:  data.appTag  || "unknown",
        userId:  data.userId  || null,
        host:    null,
        clients: new Map(),
        audience: new Map(),
        locked:  false,
        created: Date.now(),
        state:   {},
      });

      res.writeHead(200);
      res.end(JSON.stringify({
        roomId: code,
        host:   `${USE_HTTPS ? "wss" : "ws"}://${HOST}`,
        port:   PORT,
        code,
      }));
    });
    return;
  }

  // Get Ecast room info
  const roomMatch = path.match(/^\/api\/v2\/rooms\/([A-Z]{4})$/);
  if (roomMatch) {
    const room = ecastRooms.get(roomMatch[1]);
    if (!room) { res.writeHead(404); res.end(JSON.stringify({ error: "Room not found" })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({
      roomId: room.code,
      appTag: room.appTag,
      locked: room.locked,
      players: [...room.clients.values()].map(c => ({ id: c.id, name: c.name })),
    }));
    return;
  }

  // ── Blobcast / API v1 ───────────────────────────────────────────────────────

  // Create Blobcast room
  if (path === "/room" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body); } catch {}

      const code = uniqueRoomCode(blobcastRooms);
      blobcastRooms.set(code, {
        code,
        appTag:    data.appTag   || "unknown",
        server:    HOST,
        host:      null,
        clients:   new Map(),   // userId -> socket+info
        locked:    false,
        audienceEnabled: false,
        created:   Date.now(),
        state:     {},
        seq:       0,
      });

      res.writeHead(200);
      res.end(JSON.stringify({
        roomid: code,
        server: HOST,
        apptag: data.appTag || "unknown",
      }));
    });
    return;
  }

  // Get Blobcast room info
  const blobRoomMatch = path.match(/^\/room\/([A-Z]{4})\/?/);
  if (blobRoomMatch) {
    const room = blobcastRooms.get(blobRoomMatch[1]);
    if (!room) { res.writeHead(404); res.end(JSON.stringify({ roomid: null })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({
      roomid: room.code,
      server: HOST,
      apptag: room.appTag,
      locked: room.locked,
      audienceEnabled: room.audienceEnabled,
    }));
    return;
  }

  // Health check
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, blobcastRooms: blobcastRooms.size, ecastRooms: ecastRooms.size }));
});

// ─── ECAST WEBSOCKET (API v2) ─────────────────────────────────────────────────
const ecastWss = new WebSocketServer({ noServer: true });

ecastWss.on("connection", (ws, req, roomCode, isHost) => {
  const room = ecastRooms.get(roomCode);
  if (!room) { ws.close(4004, "Room not found"); return; }

  const url  = new URL(req.url, `http://${req.headers.host}`);
  const userId = url.searchParams.get("userId") || crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  const name   = url.searchParams.get("name")   || "Player";
  const role   = isHost ? "host" : url.searchParams.get("role") || "player";

  const client = { ws, id: userId, name, role, seq: 0 };

  if (role === "host") {
    room.host = client;
  } else if (role === "audience") {
    room.audience.set(userId, client);
  } else {
    room.clients.set(userId, client);
  }

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(obj));
  }

  // Welcome
  send({ opcode: "client/connected", result: "ok" });

  // Notify host of new player
  if (role !== "host" && room.host && room.host.ws.readyState === WebSocket.OPEN) {
    room.host.ws.send(JSON.stringify({
      opcode: "client/join",
      userId, name, role,
    }));
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    console.log(`[Ecast][${roomCode}][${role}] ${JSON.stringify(msg)}`);

    const op = msg.opcode || msg.type || "";

    // Broadcast from host to all players
    if (op === "bc/server/send" || op === "server/send") {
      const payload = msg.params || msg.body || {};
      for (const [, c] of room.clients) {
        if (c.ws.readyState === WebSocket.OPEN)
          c.ws.send(JSON.stringify({ opcode: "client/recv", ...payload }));
      }
      return;
    }

    // Player sends to host
    if (op === "bc/client/send" || op === "client/send") {
      if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
        room.host.ws.send(JSON.stringify({
          opcode: "client/send",
          userId, name,
          body: msg.params || msg.body || {},
        }));
      }
      return;
    }

    // Room state update
    if (op === "bc/server/setState" || op === "server/setState") {
      const blob = msg.params?.blob || msg.blob;
      if (blob !== undefined) room.state = { ...room.state, blob };
      broadcastEcast(room, { opcode: "client/setState", blob: room.state.blob });
      return;
    }

    // Lock room
    if (op === "bc/server/lock") {
      room.locked = msg.params?.lock !== false;
      broadcastEcast(room, { opcode: "client/lock", locked: room.locked });
      return;
    }

    // Generic relay: route by opcode prefix
    if (op.startsWith("bc/server/") || role === "host") {
      broadcastEcast(room, { opcode: op.replace("bc/server/", "client/"), ...( msg.params || {}) });
    } else {
      if (room.host && room.host.ws.readyState === WebSocket.OPEN)
        room.host.ws.send(JSON.stringify({ opcode: op, userId, name, ...(msg.params || {}) }));
    }
  });

  ws.on("close", () => {
    room.clients.delete(userId);
    room.audience.delete(userId);
    if (room.host === client) room.host = null;
    if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
      room.host.ws.send(JSON.stringify({ opcode: "client/leave", userId, name }));
    }
  });
});

function broadcastEcast(room, msg) {
  const str = JSON.stringify(msg);
  for (const [, c] of room.clients) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(str);
  }
  for (const [, c] of room.audience) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(str);
  }
}

// ─── BLOBCAST WEBSOCKET (API v1) ──────────────────────────────────────────────
// Blobcast uses a custom framing over WebSocket (NOT socket.io, despite old docs).
// Modern Jackbox games that use "blobcast" actually connect via plain WebSocket
// with JSON messages similar to Ecast but with different opcodes.
// Frame format: sequence|opcode|body_json
const blobcastWss = new WebSocketServer({ noServer: true });

blobcastWss.on("connection", (ws, req, roomCode) => {
  let room = blobcastRooms.get(roomCode);
  if (!room) {
    // Auto-create room if game creates it via WS directly
    room = {
      code: roomCode,
      appTag: "unknown",
      server: HOST,
      host: null,
      clients: new Map(),
      locked: false,
      audienceEnabled: false,
      created: Date.now(),
      state: {},
      seq: 0,
    };
    blobcastRooms.set(roomCode, room);
  }

  const url    = new URL(req.url, `http://${req.headers.host}`);
  const userId = url.searchParams.get("userId") || Math.random().toString(36).slice(2);
  const name   = url.searchParams.get("name")   || "Player";
  const role   = url.searchParams.get("role")   || "player"; // "host" or "player" or "audience"

  let seq = 0;

  function sendBlob(opcode, body) {
    if (ws.readyState !== WebSocket.OPEN) return;
    seq++;
    // Blobcast wire format: "SEQ\topcode\tbody_json"  (tab-separated)
    ws.send(`${seq}\t${opcode}\t${JSON.stringify(body)}`);
  }

  function sendJson(obj) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  const client = { ws, id: userId, name, role, sendBlob, sendJson };

  if (role === "host") {
    room.host = client;
    console.log(`[Blobcast][${roomCode}] Host connected`);
    sendBlob("ok", { roomid: roomCode, server: HOST });
  } else {
    room.clients.set(userId, client);
    console.log(`[Blobcast][${roomCode}] Player ${name} (${userId}) connected`);
    sendBlob("ok", { userid: userId });

    // Notify host
    if (room.host) {
      room.host.sendBlob("client:joined", { userId, name, role });
    }

    // Send current room state to new player
    if (room.state && Object.keys(room.state).length > 0) {
      sendBlob("object", { key: "bc:room", val: room.state });
    }
  }

  ws.on("message", (raw) => {
    const str = raw.toString();
    console.log(`[Blobcast][${roomCode}][${role}] RAW: ${str.substring(0, 200)}`);

    // Try tab-separated blobcast frame first
    const parts = str.split("\t");
    if (parts.length >= 3) {
      const msgSeq = parts[0];
      const opcode = parts[1];
      let body = {};
      try { body = JSON.parse(parts.slice(2).join("\t")); } catch {}
      handleBlobcastMessage(room, client, opcode, body, msgSeq);
      return;
    }

    // Fallback: plain JSON
    let msg;
    try { msg = JSON.parse(str); } catch { return; }
    const opcode = msg.type || msg.opcode || msg.key || "";
    handleBlobcastMessage(room, client, opcode, msg, "");
  });

  ws.on("close", () => {
    room.clients.delete(userId);
    if (room.host === client) {
      room.host = null;
      broadcastBlob(room, "server:disconnect", { reason: "Host disconnected" });
    } else {
      if (room.host) room.host.sendBlob("client:left", { userId, name });
      broadcastBlob(room, "client:left", { userId, name });
    }
    console.log(`[Blobcast][${roomCode}] ${role} ${name} disconnected`);
  });
});

function handleBlobcastMessage(room, client, opcode, body, msgSeq) {
  const { role, id: userId, name } = client;

  switch (opcode) {
    // ── Host → Server ────────────────────────────────────────────────────────

    case "bc:room":
    case "object":
      if (role === "host" && body.key === "bc:room") {
        room.state = body.val || body;
        broadcastBlob(room, "object", { key: "bc:room", val: room.state });
      } else if (role === "host") {
        broadcastBlob(room, "object", body);
      }
      break;

    case "setState":
    case "bc:setState":
      room.state = { ...room.state, ...(body.state || body) };
      broadcastBlob(room, "object", { key: "bc:room", val: room.state });
      break;

    case "send":
    case "bc:send":
      // Host broadcasting to all players
      broadcastBlob(room, "msg", { from: "server", body });
      break;

    case "lock":
      room.locked = body.lock !== false;
      broadcastBlob(room, "lock", { locked: room.locked });
      break;

    case "kick":
      const target = room.clients.get(body.userId);
      if (target) {
        target.sendBlob("kicked", { reason: body.reason || "Kicked by host" });
        target.ws.close();
        room.clients.delete(body.userId);
      }
      break;

    // ── Player → Server ──────────────────────────────────────────────────────

    case "msg":
    case "bc:msg":
      // Player message → forward to host
      if (room.host) {
        room.host.sendBlob("msg", { userId, name, body });
      }
      break;

    case "bc:client":
    case "client":
      // Player state update → forward to host
      if (room.host) {
        room.host.sendBlob("object", { key: `bc:client:${userId}`, val: body.val || body });
      }
      break;

    // ── Generic relay ────────────────────────────────────────────────────────
    default:
      if (role === "host") {
        // Host → broadcast to all players
        broadcastBlob(room, opcode, body);
      } else {
        // Player → forward to host
        if (room.host) room.host.sendBlob(opcode, { userId, name, ...body });
      }
      break;
  }
}

function broadcastBlob(room, opcode, body) {
  for (const [, c] of room.clients) {
    try { c.sendBlob(opcode, body); } catch {}
  }
}

// ─── WEBSOCKET UPGRADE ROUTING ────────────────────────────────────────────────
httpServer.on("upgrade", (req, socket, head) => {
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  console.log(`WS Upgrade: ${path}`);

  // Ecast: /api/v2/rooms/:code/play  or  /api/v2/rooms/:code
  const ecastMatch = path.match(/^\/api\/v2\/rooms\/([A-Z]{4})(\/play)?/);
  if (ecastMatch) {
    const roomCode = ecastMatch[1];
    const isHost   = url.searchParams.get("role") === "host";
    ecastWss.handleUpgrade(req, socket, head, (ws) => {
      ecastWss.emit("connection", ws, req, roomCode, isHost);
    });
    return;
  }

  // Blobcast: /api/v2/rooms/:code  (some games use this path for blobcast too)
  // Blobcast: /socket/:code  or  /room/:code  or  /blobcast/:code
  const blobMatch = path.match(/^\/(socket|room|blobcast|play)\/([A-Z]{4})/);
  if (blobMatch) {
    const roomCode = blobMatch[2];
    blobcastWss.handleUpgrade(req, socket, head, (ws) => {
      blobcastWss.emit("connection", ws, req, roomCode);
    });
    return;
  }

  // Blobcast: /api/v2/rooms/:code/player  (PP6 style)
  const blobPlayerMatch = path.match(/^\/api\/v2\/rooms\/([A-Z]{4})\/(player|audience|host)/);
  if (blobPlayerMatch) {
    const roomCode = blobPlayerMatch[1];
    blobcastWss.handleUpgrade(req, socket, head, (ws) => {
      blobcastWss.emit("connection", ws, req, roomCode);
    });
    return;
  }

  socket.destroy();
});

// ─── CLEANUP OLD ROOMS ────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of blobcastRooms) {
    if (now - room.created > 3600_000) blobcastRooms.delete(code);
  }
  for (const [code, room] of ecastRooms) {
    if (now - room.created > 3600_000) ecastRooms.delete(code);
  }
}, 300_000);

// ─── START ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║       Jackbox Private Server Running         ║
╠══════════════════════════════════════════════╣
║  Ecast  (PP7, PP8, Drawful 2 Int):           ║
║    serverUrl = https://${HOST.padEnd(20)} ║
║                                              ║
║  Blobcast (PP1-PP6, Fibbage, Quiplash):      ║
║    blobcastHost = https://${HOST.padEnd(16)} ║
╚══════════════════════════════════════════════╝
  `);
});
