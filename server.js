/**
 * Jackbox Private Server v4
 * - Ecast / API v2  → plain WebSocket  (PP7+)
 * - Blobcast / API v1 → plain WebSocket with JSON frames (PP1-PP6)
 *
 * PP3 protocol (Joke Boat, Quiplash 2, TMP, Guesspionage, Tee K.O., Fakin' It):
 *   1. Game calls GET /room → gets { roomid, server, ... }
 *   2. Game connects WS to wss://<server>/socket/<roomid>?userId=...&appTag=...
 *   3. Players join via jackbox.tv → GET /room/<CODE> → WS to same server
 */

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const HOST = process.env.ACCESSIBLE_HOST
          || process.env.RENDER_EXTERNAL_HOSTNAME
          || "localhost";

console.log(`Jackbox server v4 → host=${HOST} port=${PORT}`);

// ─── STATE ────────────────────────────────────────────────────────────────────
const rooms = new Map();

function makeCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = ""; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; return s;
}
function uniqueCode() { let c; do { c = makeCode(); } while (rooms.has(c)); return c; }

function makeRoom(code, appTag, hostId) {
  return {
    code, appTag: appTag || "unknown", appId: "jackbox-private-server",
    hostId: hostId || null, hostWs: null,
    locked: false, audienceEnabled: true, requiresPassword: false,
    clients: new Map(), created: Date.now(), state: null,
  };
}

function blobSend(ws, opcode, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = JSON.stringify({ seq: 0, opcode, params });
  console.log(`  → SEND opcode=${opcode}`);
  ws.send(msg);
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u    = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname.replace(/\/+$/, "") || "/";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Full request logging
  const ua = req.headers["user-agent"] || "";
  console.log(`\nHTTP ${req.method} ${req.url}`);
  console.log(`  UA: ${ua}`);
  console.log(`  Query params: ${[...u.searchParams.entries()].map(([k,v])=>`${k}=${v}`).join(", ") || "(none)"}`);

  const readBody = () => new Promise(ok => {
    let b = ""; req.on("data", d => b += d); req.on("end", () => ok(b));
  });

  // ══════════════════════════════════════════════════════
  // BLOBCAST  (PP1–PP6)
  // ══════════════════════════════════════════════════════

  // GET /room  OR  POST /room  → create room
  if (path === "/room") {
    const handle = (data) => {
      // Collect params from all possible sources
      const appTag = data.appTag || data.apptag
                  || u.searchParams.get("appTag") || u.searchParams.get("apptag")
                  || "unknown";
      const userId = data.userId || data.user_id
                  || u.searchParams.get("userId") || u.searchParams.get("user_id")
                  || makeCode();
      const wantCode = data.roomId || data.roomid
                    || u.searchParams.get("roomId") || u.searchParams.get("roomid");

      const code = (wantCode && /^[A-Z]{4}$/i.test(wantCode) && !rooms.has(wantCode.toUpperCase()))
        ? wantCode.toUpperCase() : uniqueCode();

      const room = makeRoom(code, appTag, userId);
      rooms.set(code, room);

      // Response includes EVERY field any PP version might look for
      const resp = {
        // Room identifiers
        roomid: code, roomId: code,
        // Server address — game will connect WS to this host
        server: HOST,
        // App info
        apptag: appTag, appTag: appTag,
        appid: room.appId, appId: room.appId,
        // Room state
        numPlayers: 0, numAudience: 0,
        audienceEnabled: true, requiresPassword: false,
        locked: false, joinAs: "player",
        // WebSocket info (different versions use different field names)
        blobcastHost: HOST,
        blobcastPort: 443,
        wsHost: HOST,
        wsPort: 443,
        host: HOST,
        port: 443,
        // Full URLs
        wsUrl: `wss://${HOST}`,
        socketUrl: `wss://${HOST}/socket/${code}`,
        // Status
        error: "", success: true,
      };

      console.log(`[Blobcast] CREATED room=${code} appTag=${appTag} userId=${userId}`);
      console.log(`  Response: ${JSON.stringify(resp)}`);
      res.writeHead(200);
      res.end(JSON.stringify(resp));
    };

    if (req.method === "POST") {
      readBody().then(raw => {
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        console.log(`  Body: ${raw}`);
        handle(data);
      });
    } else {
      handle({});
    }
    return;
  }

  // GET /room/<CODE>  → room info for joining players
  const blobRoomM = path.match(/^\/room\/([A-Za-z]{4})$/);
  if (blobRoomM) {
    const code = blobRoomM[1].toUpperCase();
    const room = rooms.get(code);
    console.log(`[Blobcast] Room lookup: ${code} → ${room ? "found" : "NOT FOUND"}`);
    if (!room) {
      res.writeHead(404);
      res.end(JSON.stringify({ roomid: null, error: "Room not found", success: false }));
      return;
    }
    const resp = {
      roomid: room.code, roomId: room.code,
      server: HOST,
      apptag: room.appTag, appTag: room.appTag,
      appid: room.appId, appId: room.appId,
      numPlayers: room.clients.size, numAudience: 0,
      audienceEnabled: room.audienceEnabled,
      requiresPassword: room.requiresPassword,
      locked: room.locked, joinAs: room.locked ? "full" : "player",
      blobcastHost: HOST, blobcastPort: 443,
      host: HOST, port: 443,
      wsUrl: `wss://${HOST}`,
      socketUrl: `wss://${HOST}/socket/${code}`,
      error: "", success: true,
    };
    res.writeHead(200);
    res.end(JSON.stringify(resp));
    return;
  }

  // ══════════════════════════════════════════════════════
  // ECAST  (PP7+, API v2)
  // ══════════════════════════════════════════════════════

  if (path.match(/^\/api\/v2\/app-configs\//)) {
    const appTag = path.split("/").pop().split("?")[0];
    res.writeHead(200);
    res.end(JSON.stringify({
      appTag, serverUrl: `wss://${HOST}`,
      blobcastHost: `https://${HOST}`, isTestServer: false,
    }));
    return;
  }

  if (path === "/api/v2/rooms" && req.method === "POST") {
    readBody().then(raw => {
      let data = {}; try { data = JSON.parse(raw); } catch {}
      const code = uniqueCode();
      rooms.set(code, makeRoom(code, data.appTag || "unknown", data.userId));
      res.writeHead(200);
      res.end(JSON.stringify({ roomId: code, code, host: `wss://${HOST}`, success: true }));
    });
    return;
  }

  const ecastRoomM = path.match(/^\/api\/v2\/rooms\/([A-Za-z]{4})$/);
  if (ecastRoomM) {
    const code = ecastRoomM[1].toUpperCase();
    const room = rooms.get(code);
    if (!room) { res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({
      roomId: room.code, appTag: room.appTag, locked: room.locked,
      players: [...room.clients.values()].map(c => ({ id: c.id, name: c.name })),
    }));
    return;
  }

  // Health
  res.writeHead(200);
  res.end(JSON.stringify({
    ok: true, host: HOST, rooms: rooms.size,
    roomList: [...rooms.keys()],
  }));
});

// ─── BLOBCAST WEBSOCKET ───────────────────────────────────────────────────────
const blobWss = new WebSocketServer({ noServer: true });

blobWss.on("connection", (ws, req, code) => {
  const u      = new URL(req.url, `http://${req.headers.host}`);
  const userId = u.searchParams.get("userId") || u.searchParams.get("user_id") || makeCode();
  const name   = decodeURIComponent(u.searchParams.get("name") || "");
  const role   = u.searchParams.get("role") || "";
  const appTag = u.searchParams.get("appTag") || u.searchParams.get("apptag") || "";

  let room = rooms.get(code);
  if (!room) {
    room = makeRoom(code, appTag || "unknown", userId);
    rooms.set(code, room);
    console.log(`[Blobcast][${code}] Auto-created room on WS connect`);
  }

  // First connected client with no existing hostWs is the host
  const isHost = role === "host" || (!room.hostWs && room.clients.size === 0)
              || userId === room.hostId;
  if (isHost && !room.hostWs) {
    room.hostWs = ws;
    room.hostId = userId;
  }

  const client = { ws, id: userId, name, role: isHost ? "host" : (role || "player") };
  room.clients.set(userId, client);

  console.log(`\n[Blobcast][${code}] ${isHost?"HOST":"PLAYER"} CONNECTED`);
  console.log(`  userId=${userId} name="${name}" role=${role} appTag=${appTag}`);
  console.log(`  Room now has ${room.clients.size} clients`);

  // Welcome message
  blobSend(ws, "ok", {
    roomId: code, roomid: code,
    server: HOST, userId,
    // Some PP versions need "connected" confirmation
    connected: true,
  });

  // Send existing room state to new player
  if (!isHost && room.state !== null) {
    blobSend(ws, "object", { key: "bc:room", val: room.state });
  }

  // Notify host of new player
  if (!isHost && room.hostWs) {
    blobSend(room.hostWs, "client:joined", {
      userId, name, role: client.role, roomid: code,
    });
  }

  ws.on("message", raw => {
    const str = raw.toString().trim();
    console.log(`\n[Blobcast][${code}][${isHost?"H":"P"}] RAW IN: ${str.substring(0, 300)}`);

    let seq = 0, opcode = "", params = {};

    if (str.startsWith("{")) {
      try {
        const obj = JSON.parse(str);
        seq    = obj.seq    || 0;
        opcode = obj.opcode || obj.type || obj.key || "";
        params = obj.params !== undefined ? obj.params : (obj.body || obj);
        if (!opcode && obj.key) { opcode = "object"; params = obj; }
      } catch (e) {
        console.log(`  JSON parse error: ${e.message}`);
        return;
      }
    } else if (str.includes("\t")) {
      const parts = str.split("\t");
      seq    = parseInt(parts[0]) || 0;
      opcode = parts[1] || "";
      try { params = parts.length > 2 ? JSON.parse(parts.slice(2).join("\t")) : {}; } catch {}
    } else {
      console.log(`  Unknown frame format, skipping`);
      return;
    }

    if (!opcode) return;
    console.log(`  opcode=${opcode} seq=${seq} params=${JSON.stringify(params).substring(0,200)}`);

    switch (opcode) {

      case "object":
        if (params && params.key === "bc:room") {
          room.state = params.val;
          console.log(`  [state] bc:room updated`);
          broadcastBlob(room, ws, "object", { key: "bc:room", val: room.state });
        } else if (params && params.key && params.key.startsWith("bc:client")) {
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
          const to = params && (params.to || params.userId);
          if (to) {
            const tc = room.clients.get(to);
            if (tc) blobSend(tc.ws, "msg", { from: "server", body: params.body || params });
          } else {
            broadcastBlob(room, ws, "msg", { from: "server", body: params && (params.body || params) });
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
        room.locked = params && params.lock !== false;
        broadcastBlob(room, null, "lock", { locked: room.locked, roomid: code });
        break;

      case "kick": {
        const kId = params && (params.userId || params.userid);
        const kc = kId && room.clients.get(kId);
        if (kc) {
          blobSend(kc.ws, "kicked", { reason: (params && params.reason) || "Kicked by host" });
          kc.ws.close();
          room.clients.delete(kId);
        }
        break;
      }

      default:
        if (isHost) {
          broadcastBlob(room, ws, opcode, params);
        } else {
          if (room.hostWs) blobSend(room.hostWs, opcode, { userId, name, ...(params||{}) });
        }
    }
  });

  ws.on("close", (code_, reason) => {
    room.clients.delete(userId);
    console.log(`\n[Blobcast][${code}] ${isHost?"HOST":"PLAYER"} DISCONNECTED userId=${userId} code=${code_}`);
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

  ws.on("error", e => console.error(`[Blobcast][${code}] WS error: ${e.message}`));
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

  console.log(`[Ecast][${code}] ${isHost?"HOST":"PLAYER"} connected: ${name}`);
  ws.send(JSON.stringify({ opcode: "connected", userId, roomId: code }));

  if (!isHost && room.hostWs?.readyState === WebSocket.OPEN)
    room.hostWs.send(JSON.stringify({ opcode: "client/join", userId, name, role }));

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
  const ua   = req.headers["user-agent"] || "";

  console.log(`\nWS UPGRADE: ${path}${u.search}`);
  console.log(`  UA: ${ua}`);
  console.log(`  Origin: ${req.headers.origin || "(none)"}`);
  console.log(`  Query: ${[...u.searchParams.entries()].map(([k,v])=>`${k}=${v}`).join(", ") || "(none)"}`);

  // Ecast: /api/v2/rooms/CODE  or  /api/v2/rooms/CODE/play
  const ecastM = path.match(/\/api\/v2\/rooms\/([A-Za-z]{4})(\/play)?$/i);
  if (ecastM) {
    const code = ecastM[1].toUpperCase();
    console.log(`  → ECAST room=${code}`);
    ecastWss.handleUpgrade(req, socket, head, ws => ecastWss.emit("connection", ws, req, code));
    return;
  }

  // Blobcast path: /socket/CODE  /room/CODE  /play/CODE  /csp/CODE  /live/CODE  /blobcast/CODE
  const blobPathM = path.match(/^\/(socket|room|play|blobcast|bc|csp|live|game)\/?([A-Za-z]{4})/i);
  if (blobPathM) {
    const code = blobPathM[2].toUpperCase();
    console.log(`  → BLOBCAST room=${code} (path match on /${blobPathM[1]}/)`);
    blobWss.handleUpgrade(req, socket, head, ws => blobWss.emit("connection", ws, req, code));
    return;
  }

  // Blobcast: roomId in query
  const rid = u.searchParams.get("roomId") || u.searchParams.get("roomid")
           || u.searchParams.get("room_id") || u.searchParams.get("code");
  if (rid?.match(/^[A-Za-z]{4}$/)) {
    const code = rid.toUpperCase();
    console.log(`  → BLOBCAST room=${code} (query param)`);
    blobWss.handleUpgrade(req, socket, head, ws => blobWss.emit("connection", ws, req, code));
    return;
  }

  // Blobcast: 4-letter CODE anywhere in path
  const codeM = path.match(/\/([A-Z]{4})(\/|$)/);
  if (codeM) {
    const code = codeM[1];
    console.log(`  → BLOBCAST room=${code} (code in path)`);
    blobWss.handleUpgrade(req, socket, head, ws => blobWss.emit("connection", ws, req, code));
    return;
  }

  console.warn(`  ✗ No route matched — destroying socket`);
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
║     Jackbox Private Server v4 Running            ║
╠══════════════════════════════════════════════════╣
║  Blobcast PP1-PP6:  GET https://${HOST}/room ║
║  Ecast PP7+:        wss://${HOST}/api/v2/... ║
╚══════════════════════════════════════════════════╝
  `);
});
