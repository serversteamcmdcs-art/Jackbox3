/**
 * Jackbox Private Server v3
 * - Ecast / API v2  → plain WebSocket  (PP7, PP8, PP9, PP10+)
 * - Blobcast / API v1 → plain WebSocket with JSON frames  (PP1-PP6)
 *
 * Key fix: Blobcast creates rooms via  GET /room?appTag=...&userId=...
 * NOT via POST. The game sends GET requests to create and check rooms.
 */

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const HOST = process.env.ACCESSIBLE_HOST
          || process.env.RENDER_EXTERNAL_HOSTNAME
          || "localhost";

console.log(`Jackbox server starting → host=${HOST} port=${PORT}`);

// ─── STATE ────────────────────────────────────────────────────────────────────
const rooms = new Map(); // code → Room

function makeCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function uniqueCode() {
  let c; do { c = makeCode(); } while (rooms.has(c)); return c;
}

function makeRoom(code, appTag, hostUserId) {
  return {
    code,
    appTag: appTag || "unknown",
    appId: "jackbox-private-server",
    hostId: hostUserId || null,
    hostWs: null,
    locked: false,
    audienceEnabled: true,
    requiresPassword: false,
    clients: new Map(),
    created: Date.now(),
    state: null,
  };
}

function blobSend(ws, opcode, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ seq: 0, opcode, params }));
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u    = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname.replace(/\/+$/, "") || "/";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Log ALL headers and query params for debugging
  console.log(`HTTP ${req.method} ${req.url}`);
  console.log(`  Headers: ${JSON.stringify(req.headers)}`);
  if (u.search) console.log(`  Query: ${u.search}`);

  const readBody = () => new Promise(ok => {
    let b = ""; req.on("data", d => b += d); req.on("end", () => ok(b));
  });

  // ══════════════════════════════════════════════════════
  // BLOBCAST  (PP1–PP6, Fibbage, Quiplash, etc.)
  // ══════════════════════════════════════════════════════

  // GET /room  → create room (host game startup)
  // Params: appTag, userId, [numAudience], [roomId]
  if (path === "/room" && (req.method === "GET" || req.method === "POST")) {
    const handleRoom = (data) => {
      const appTag   = data.appTag || data.apptag || u.searchParams.get("appTag") || u.searchParams.get("apptag") || "unknown";
      const userId   = data.userId || data.user_id || u.searchParams.get("userId") || u.searchParams.get("user_id") || makeCode();
      const wantCode = data.roomId || data.roomid || u.searchParams.get("roomId");

      const code = (wantCode && wantCode.length === 4 && !rooms.has(wantCode.toUpperCase()))
        ? wantCode.toUpperCase()
        : uniqueCode();

      const room = makeRoom(code, appTag, userId);
      rooms.set(code, room);

      console.log(`[Blobcast] Room CREATED: ${code} appTag=${appTag} userId=${userId}`);

      const roomResp = {
        roomid: code, roomId: code,
        server: HOST,
        apptag: appTag, appTag: appTag,
        appid:  room.appId, appId: room.appId,
        numPlayers: 0, numAudience: 0,
        audienceEnabled: true,
        requiresPassword: false,
        locked: false,
        joinAs: "player",
        // WebSocket info (various PP versions use different fields)
        wsUrl:        `wss://${HOST}`,
        blobcastHost: HOST,
        blobcastPort: 443,
        host: HOST,
        port: 443,
        error: "", success: true,
      };
      console.log(`  /room response: ${JSON.stringify(roomResp)}`);
      res.writeHead(200);
      res.end(JSON.stringify(roomResp));
    };

    if (req.method === "POST") {
      readBody().then(raw => {
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        handleRoom(data);
      });
    } else {
      handleRoom({
        appTag: u.searchParams.get("appTag") || u.searchParams.get("apptag"),
        userId: u.searchParams.get("userId") || u.searchParams.get("user_id"),
        roomId: u.searchParams.get("roomId"),
      });
    }
    return;
  }

  // GET /room/<CODE>  → room info (jackbox.tv player lookup)
  const blobInfoM = path.match(/^\/room\/([A-Za-z]{4})$/);
  if (blobInfoM) {
    const code = blobInfoM[1].toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      res.writeHead(404);
      res.end(JSON.stringify({ roomid: null, error: "Room not found", success: false }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({
      roomid: room.code,
      server: HOST,
      apptag: room.appTag,
      appid:  room.appId,
      numPlayers: room.clients.size,
      numAudience: 0,
      audienceEnabled: room.audienceEnabled,
      requiresPassword: room.requiresPassword,
      locked: room.locked,
      joinAs: room.locked ? "full" : "player",
      error: "",
      success: true,
    }));
    return;
  }

  // ══════════════════════════════════════════════════════
  // ECAST  (PP7+, API v2)
  // ══════════════════════════════════════════════════════

  if (path.match(/^\/api\/v2\/app-configs\//)) {
    const appTag = path.split("/").pop().split("?")[0];
    res.writeHead(200);
    res.end(JSON.stringify({
      appTag,
      serverUrl:    `wss://${HOST}`,
      blobcastHost: `https://${HOST}`,
      isTestServer: false,
    }));
    return;
  }

  if (path === "/api/v2/rooms") {
    readBody().then(raw => {
      let data = {};
      try { data = JSON.parse(raw); } catch {}
      const code = uniqueCode();
      const room = makeRoom(code, data.appTag || "unknown", data.userId);
      rooms.set(code, room);
      res.writeHead(200);
      res.end(JSON.stringify({ roomId: code, code, host: `wss://${HOST}`, success: true }));
    });
    return;
  }

  const ecastInfoM = path.match(/^\/api\/v2\/rooms\/([A-Za-z]{4})$/);
  if (ecastInfoM) {
    const code = ecastInfoM[1].toUpperCase();
    const room = rooms.get(code);
    if (!room) { res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({
      roomId: room.code, appTag: room.appTag, locked: room.locked,
      players: [...room.clients.values()].map(c => ({ id: c.id, name: c.name })),
    }));
    return;
  }

  // Root health check
  res.writeHead(200);
  res.end(JSON.stringify({
    ok: true, host: HOST, rooms: rooms.size,
    blobcast: `https://${HOST}/room`,
    ecast:    `wss://${HOST}/api/v2/rooms/:code/play`,
  }));
});

// ─── BLOBCAST WEBSOCKET ───────────────────────────────────────────────────────
const blobWss = new WebSocketServer({ noServer: true });

blobWss.on("connection", (ws, req, code) => {
  const u      = new URL(req.url, `http://${req.headers.host}`);
  const userId = u.searchParams.get("userId") || u.searchParams.get("user_id") || makeCode();
  const name   = decodeURIComponent(u.searchParams.get("name") || "Player");
  const role   = u.searchParams.get("role") || "player";

  let room = rooms.get(code);
  if (!room) {
    const appTag = u.searchParams.get("appTag") || "unknown";
    room = makeRoom(code, appTag, userId);
    rooms.set(code, room);
    console.log(`[Blobcast] Auto-created room ${code} on WS connect`);
  }

  const isHost = role === "host" || userId === room.hostId || !room.hostWs;
  if (isHost && !room.hostWs) room.hostWs = ws;

  const client = { ws, id: userId, name, role: isHost ? "host" : role };
  room.clients.set(userId, client);

  console.log(`[Blobcast][${code}] ${isHost ? "HOST" : "PLAYER"} connected userId=${userId} name=${name}`);

  // Welcome
  blobSend(ws, "ok", { roomId: code, roomid: code, server: HOST, userId });

  // Send room state to joining player
  if (!isHost && room.state !== null) {
    blobSend(ws, "object", { key: "bc:room", val: room.state });
  }

  // Notify host
  if (!isHost && room.hostWs) {
    blobSend(room.hostWs, "client:joined", { userId, name, role: client.role, roomid: code });
  }

  ws.on("message", raw => {
    const str = raw.toString().trim();
    let seq = 0, opcode = "", params = {};

    if (str.startsWith("{")) {
      try {
        const obj = JSON.parse(str);
        seq    = obj.seq    || 0;
        opcode = obj.opcode || obj.type  || obj.key || "";
        params = obj.params || obj.body  || {};
        // handle { key, val } object style
        if (!opcode && obj.key) { opcode = "object"; params = obj; }
      } catch { return; }
    } else if (str.includes("\t")) {
      const parts = str.split("\t");
      seq    = parseInt(parts[0]) || 0;
      opcode = parts[1] || "";
      try { params = parts.length > 2 ? JSON.parse(parts.slice(2).join("\t")) : {}; } catch {}
    } else { return; }

    if (!opcode) return;
    console.log(`[Blobcast][${code}][${isHost?"H":"P"}] ${opcode}`);

    switch (opcode) {
      case "object":
        if (params.key === "bc:room") {
          room.state = params.val;
          broadcastBlob(room, ws, "object", { key: "bc:room", val: room.state });
        } else if (params.key && params.key.startsWith("bc:client")) {
          if (room.hostWs) blobSend(room.hostWs, "object", { ...params, userId });
        } else if (isHost) {
          broadcastBlob(room, ws, "object", params);
        } else {
          if (room.hostWs) blobSend(room.hostWs, "object", { ...params, userId, name });
        }
        break;

      case "send":
      case "bc:send":
        if (isHost) {
          const to = params.to;
          if (to) {
            const tc = room.clients.get(to);
            if (tc) blobSend(tc.ws, "msg", { from: "server", body: params.body || params });
          } else {
            broadcastBlob(room, ws, "msg", { from: "server", body: params.body || params });
          }
        } else {
          if (room.hostWs) blobSend(room.hostWs, "msg", { from: userId, userId, name, body: params });
        }
        break;

      case "msg":
      case "text":
        if (isHost) {
          broadcastBlob(room, ws, opcode, params);
        } else {
          if (room.hostWs) blobSend(room.hostWs, "msg", { from: userId, userId, name, body: params });
        }
        break;

      case "lock":
        room.locked = params.lock !== false;
        broadcastBlob(room, null, "lock", { locked: room.locked, roomid: code });
        break;

      case "kick":
        const kc = room.clients.get(params.userId || params.userid);
        if (kc) {
          blobSend(kc.ws, "kicked", { reason: params.reason || "Kicked by host" });
          kc.ws.close();
          room.clients.delete(params.userId || params.userid);
        }
        break;

      default:
        if (isHost) {
          broadcastBlob(room, ws, opcode, params);
        } else {
          if (room.hostWs) blobSend(room.hostWs, opcode, { userId, name, ...params });
        }
    }
  });

  ws.on("close", () => {
    room.clients.delete(userId);
    console.log(`[Blobcast][${code}] ${isHost?"HOST":"PLAYER"} left: ${userId}`);
    if (isHost) {
      room.hostWs = null;
      broadcastBlob(room, null, "server:disconnected", { reason: "Host left" });
    } else {
      if (room.hostWs) blobSend(room.hostWs, "client:left", { userId, name });
      broadcastBlob(room, ws, "client:left", { userId, name });
    }
    if (room.clients.size === 0) {
      setTimeout(() => { if (rooms.get(code)?.clients.size === 0) rooms.delete(code); }, 30000);
    }
  });

  ws.on("error", e => console.error(`[Blobcast][${code}] error:`, e.message));
});

function broadcastBlob(room, skipWs, opcode, params) {
  for (const [, c] of room.clients) {
    if (c.ws === skipWs) continue;
    blobSend(c.ws, opcode, params);
  }
}

// ─── ECAST WEBSOCKET ──────────────────────────────────────────────────────────
const ecastWss = new WebSocketServer({ noServer: true });

ecastWss.on("connection", (ws, req, code) => {
  const u      = new URL(req.url, `http://${req.headers.host}`);
  const userId = u.searchParams.get("userId") || makeCode();
  const name   = decodeURIComponent(u.searchParams.get("name") || "Player");
  const role   = u.searchParams.get("role") || "player";

  const room = rooms.get(code);
  if (!room) { ws.close(4004, "Room not found"); return; }

  const isHost = role === "host" || userId === room.hostId;
  if (isHost) room.hostWs = ws;

  room.clients.set(userId, { ws, id: userId, name, role });

  ws.send(JSON.stringify({ opcode: "connected", userId, roomId: code }));
  if (!isHost && room.hostWs?.readyState === WebSocket.OPEN) {
    room.hostWs.send(JSON.stringify({ opcode: "client/join", userId, name, role }));
  }

  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const op = msg.opcode || "";
    if (isHost) {
      const fwd = op.replace(/^bc\/server\//, "bc/client/");
      for (const [, c] of room.clients) {
        if (c.ws !== ws && c.ws.readyState === WebSocket.OPEN)
          c.ws.send(JSON.stringify({ opcode: fwd, ...(msg.params || {}) }));
      }
    } else if (room.hostWs?.readyState === WebSocket.OPEN) {
      room.hostWs.send(JSON.stringify({ opcode: op, userId, name, ...(msg.params || {}) }));
    }
  });

  ws.on("close", () => {
    room.clients.delete(userId);
    if (isHost) room.hostWs = null;
    else if (room.hostWs?.readyState === WebSocket.OPEN)
      room.hostWs.send(JSON.stringify({ opcode: "client/leave", userId, name }));
  });
});

// ─── UPGRADE ROUTING ──────────────────────────────────────────────────────────
server.on("upgrade", (req, socket, head) => {
  const u    = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname;

  console.log(`WS Upgrade: ${path}${u.search}`);
  console.log(`  WS Headers: host=${req.headers.host} origin=${req.headers.origin}`);

  // Ecast: /api/v2/rooms/CODE  or  /api/v2/rooms/CODE/play
  const ecastM = path.match(/\/api\/v2\/rooms\/([A-Za-z]{4})(\/play)?$/i);
  if (ecastM) {
    const code = ecastM[1].toUpperCase();
    console.log(`  → Ecast room ${code}`);
    ecastWss.handleUpgrade(req, socket, head, ws => ecastWss.emit("connection", ws, req, code));
    return;
  }

  // Blobcast path patterns: /socket/CODE  /room/CODE  /play/CODE  /csp/CODE  /blobcast/CODE
  const blobPathM = path.match(/^\/(socket|room|play|blobcast|bc|csp|live)\/([A-Za-z]{4})/i);
  if (blobPathM) {
    const code = blobPathM[2].toUpperCase();
    console.log(`  → Blobcast room ${code} (path match)`);
    blobWss.handleUpgrade(req, socket, head, ws => blobWss.emit("connection", ws, req, code));
    return;
  }

  // Blobcast: roomId or roomid in query string
  const rid = u.searchParams.get("roomId") || u.searchParams.get("roomid")
           || u.searchParams.get("room_id") || u.searchParams.get("code");
  if (rid?.match(/^[A-Za-z]{4}$/)) {
    const code = rid.toUpperCase();
    console.log(`  → Blobcast room ${code} (query param)`);
    blobWss.handleUpgrade(req, socket, head, ws => blobWss.emit("connection", ws, req, code));
    return;
  }

  // Blobcast: CODE appears directly in path (e.g. /ABCD or /live/ABCD)
  const codeInPath = path.match(/\/([A-Z]{4})(\/|$)/);
  if (codeInPath) {
    const code = codeInPath[1];
    console.log(`  → Blobcast room ${code} (code in path)`);
    blobWss.handleUpgrade(req, socket, head, ws => blobWss.emit("connection", ws, req, code));
    return;
  }

  console.warn(`WS: no route for path=${path} query=${u.search} — destroying`);
  socket.destroy();
});

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms)
    if (now - room.created > 4 * 3600_000) rooms.delete(code);
}, 300_000);

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║       Jackbox Private Server v3 Running          ║
╠══════════════════════════════════════════════════╣
║  Blobcast (PP1-PP6, Fibbage, Quiplash 1/2):      ║
║    Room: GET https://${HOST}/room           ║
║    WS:   wss://${HOST}/socket/:CODE         ║
║                                                  ║
║  Ecast (PP7, PP8, PP9, PP10+):                   ║
║    WS: wss://${HOST}/api/v2/rooms/:CODE/play║
╚══════════════════════════════════════════════════╝
  `);
});
