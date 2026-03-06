/**
 * Jackbox Private Server v4
 * Implements Engine.IO v3 / Socket.IO v2 (EIO=3) for Blobcast (PP1-PP6)
 * + plain WebSocket Ecast (PP7+)
 *
 * PP3 connection flow:
 *  1. GET /room  → create room, returns {roomid, server, ...}
 *  2. GET /socket.io/?EIO=3&transport=polling  → Engine.IO handshake
 *  3. POST /socket.io/?EIO=3&transport=polling&sid=  → Socket.IO connect
 *  4. WS /socket.io/?EIO=3&transport=websocket&sid=  → upgrade to WS
 */

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const HOST = process.env.ACCESSIBLE_HOST
          || process.env.RENDER_EXTERNAL_HOSTNAME
          || "localhost";

console.log(`Jackbox v4 starting → ${HOST}:${PORT}`);

// ─── STATE ────────────────────────────────────────────────────────────────────
const rooms   = new Map(); // roomCode → Room
const sioSess = new Map(); // sid → SioSession  (Engine.IO sessions)

function randStr(n = 20) { return crypto.randomBytes(n).toString("base64url").slice(0, n); }
function makeCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = ""; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function uniqueCode() { let c; do { c = makeCode(); } while (rooms.has(c)); return c; }

function makeRoom(code, appTag, hostId) {
  return { code, appTag: appTag||"unknown", hostId: hostId||null,
           hostWs: null, clients: new Map(), locked: false,
           state: null, created: Date.now() };
}

// ─── ENGINE.IO / SOCKET.IO PROTOCOL HELPERS ───────────────────────────────────
// Engine.IO v3 packet types (sent as text over HTTP polling or WS)
const EIO = { OPEN:0, CLOSE:1, PING:2, PONG:3, MESSAGE:4, UPGRADE:5, NOOP:6 };
// Socket.IO v2 packet types (wrapped inside EIO MESSAGE)
const SIO = { CONNECT:0, DISCONNECT:1, EVENT:2, ACK:3, ERROR:4, BINARY_EVENT:5 };

// Encode Engine.IO polling frame: "LENGTH:PACKET..."
function eioFrame(type, data) {
  const s = `${type}${data || ""}`;
  return `${s.length}:${s}`;
}
// Encode Socket.IO event inside Engine.IO message
function sioEvent(namespace, event, ...args) {
  return `${EIO.MESSAGE}${SIO.EVENT}${namespace ? namespace : ""}${JSON.stringify([event, ...args])}`;
}

// ─── SIO SESSION ──────────────────────────────────────────────────────────────
function makeSioSession(sid, roomCode, userId, name, role) {
  return {
    sid, roomCode, userId, name, role,
    ws: null,                // set when WS upgrade happens
    pollQueue: [],           // outbound queue for polling
    pollRes: null,           // pending GET response waiting for data
    lastPing: Date.now(),
    connected: false,
  };
}

function sioSend(sess, event, ...args) {
  const pkt = sioEvent("/", event, ...args);
  const frame = eioFrame(EIO.MESSAGE, pkt.slice(1)); // pkt already starts with "4"
  // Actually EIO MESSAGE is just the whole string: "4" + sio_packet
  const full = `${EIO.MESSAGE}${SIO.EVENT}${JSON.stringify([event, ...args])}`;
  if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
    sess.ws.send(full);
  } else {
    sess.pollQueue.push(full);
    flushPoll(sess);
  }
}

function flushPoll(sess) {
  if (!sess.pollRes || sess.pollQueue.length === 0) return;
  const res = sess.pollRes;
  sess.pollRes = null;
  const frames = sess.pollQueue.splice(0).map(p => eioFrame(EIO.MESSAGE, p.slice(1)));
  // Actually for polling we just send raw EIO frames concatenated
  const body = sess.pollQueue.length === 0
    ? frames.join("")
    : frames.join("");
  res.setHeader("Content-Type", "text/plain; charset=UTF-8");
  res.writeHead(200);
  res.end(frames.join(""));
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u    = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname.replace(/\/+$/, "") || "/";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const readBody = () => new Promise(ok => {
    let b = ""; req.on("data", d => b += d); req.on("end", () => ok(b));
  });

  console.log(`HTTP ${req.method} ${req.url}`);

  // ══════════════════════════════════════════════════════
  // ENGINE.IO / SOCKET.IO  (PP1-PP6 Blobcast)
  // Path: /socket.io/  with EIO=3
  // ══════════════════════════════════════════════════════
  if (path === "/socket.io" || path === "/socket.io/") {
    const eio       = u.searchParams.get("EIO") || "3";
    const transport = u.searchParams.get("transport") || "polling";
    const sid       = u.searchParams.get("sid");
    const roomCode  = (u.searchParams.get("roomId") || u.searchParams.get("roomid") || "").toUpperCase();
    const userId    = u.searchParams.get("userId") || u.searchParams.get("user_id") || randStr(8);
    const name      = decodeURIComponent(u.searchParams.get("name") || "Player");
    const role      = u.searchParams.get("role") || "player";

    // ── GET without sid → Engine.IO handshake ──────────────────────────────
    if (req.method === "GET" && !sid) {
      const newSid = randStr(20);
      const sess = makeSioSession(newSid, roomCode, userId, name, role);
      sioSess.set(newSid, sess);

      // Associate with room
      let room = rooms.get(roomCode);
      if (!room && roomCode.length === 4) {
        room = makeRoom(roomCode, "unknown", userId);
        rooms.set(roomCode, room);
        console.log(`[SIO] Auto-created room ${roomCode}`);
      }
      if (room) {
        const isHost = role === "host" || !room.hostWs;
        sess.role = isHost ? "host" : role;
        room.clients.set(userId, sess);
        if (isHost) room.hostWs = { send: (d) => sioSend(sess, "message", d), readyState: 1 };
      }

      const handshake = JSON.stringify({
        sid: newSid,
        upgrades: ["websocket"],
        pingInterval: 25000,
        pingTimeout:  5000,
      });

      // EIO v3 polling response: "LENGTH:0{handshake}LENGTH:40"
      // 0 = OPEN packet, 40 = Socket.IO CONNECT to namespace "/"
      const openPkt  = `0${handshake}`;
      const connPkt  = `40`;
      const body     = `${openPkt.length}:${openPkt}${connPkt.length}:${connPkt}`;

      res.setHeader("Content-Type", "text/plain; charset=UTF-8");
      res.writeHead(200);
      res.end(body);
      console.log(`[SIO] Handshake → sid=${newSid} room=${roomCode} role=${sess.role}`);

      // Notify room host of new player
      if (room && sess.role !== "host" && room.hostWs) {
        setTimeout(() => {
          const hostSess = [...sioSess.values()].find(s => s.roomCode === roomCode && s.role === "host");
          if (hostSess) sioSend(hostSess, "client:joined", { userId, name, role: sess.role, roomid: roomCode });
        }, 200);
      }
      return;
    }

    // ── GET with sid → long-poll waiting for data ─────────────────────────
    if (req.method === "GET" && sid) {
      const sess = sioSess.get(sid);
      if (!sess) { res.writeHead(400); res.end("Unknown session"); return; }

      // Send PING to keep alive
      const pingFrame = `${EIO.PING.toString().length + 1}:${EIO.PING}`;

      if (sess.pollQueue.length > 0) {
        const frames = sess.pollQueue.splice(0).map(p => {
          return `${p.length}:${p}`;
        });
        res.setHeader("Content-Type", "text/plain; charset=UTF-8");
        res.writeHead(200);
        res.end(frames.join(""));
      } else {
        // Hold connection open, send noop after 20s
        sess.pollRes = res;
        const timer = setTimeout(() => {
          if (sess.pollRes === res) {
            sess.pollRes = null;
            const noop = `1:${EIO.NOOP}`;
            res.setHeader("Content-Type", "text/plain; charset=UTF-8");
            res.writeHead(200);
            res.end(noop);
          }
        }, 20000);
        req.on("close", () => { clearTimeout(timer); sess.pollRes = null; });
      }
      return;
    }

    // ── POST with sid → receive data from client ──────────────────────────
    if (req.method === "POST" && sid) {
      const sess = sioSess.get(sid);
      readBody().then(body => {
        if (!sess) { res.writeHead(400); res.end("ok"); return; }
        // Parse EIO polling frame: "LENGTH:PACKET..."
        handleSioData(sess, body);
        res.setHeader("Content-Type", "text/plain; charset=UTF-8");
        res.writeHead(200);
        res.end("ok");
      });
      return;
    }

    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  // ══════════════════════════════════════════════════════
  // BLOBCAST HTTP  (room create/info)
  // ══════════════════════════════════════════════════════
  if (path === "/room" && (req.method === "GET" || req.method === "POST")) {
    const handleRoom = (data) => {
      const appTag = data.appTag || data.apptag || "unknown";
      const userId = data.userId || data.user_id || randStr(8);
      const wantCode = data.roomId || data.roomid;
      const code = (wantCode && wantCode.length === 4 && !rooms.has(wantCode.toUpperCase()))
        ? wantCode.toUpperCase() : uniqueCode();

      const room = makeRoom(code, appTag, userId);
      rooms.set(code, room);
      console.log(`[Blobcast] Room CREATED: ${code} appTag=${appTag}`);

      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({
        roomid: code, roomId: code,
        server: HOST,
        apptag: appTag, appTag,
        appid: "jackbox-private-server",
        numPlayers: 0, numAudience: 0,
        audienceEnabled: true,
        requiresPassword: false,
        locked: false, joinAs: "player",
        // Tell game where to find Socket.IO
        blobcastHost: HOST,
        blobcastPort: 443,
        host: HOST, port: 443,
        error: "", success: true,
      }));
    };

    if (req.method === "POST") {
      readBody().then(raw => {
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        // Also check query params
        if (!data.appTag) data.appTag = u.searchParams.get("appTag") || u.searchParams.get("apptag");
        if (!data.userId) data.userId = u.searchParams.get("userId");
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

  const blobInfoM = path.match(/^\/room\/([A-Za-z]{4})$/);
  if (blobInfoM) {
    res.setHeader("Content-Type", "application/json");
    const code = blobInfoM[1].toUpperCase();
    const room = rooms.get(code);
    if (!room) { res.writeHead(404); res.end(JSON.stringify({ roomid: null, success: false })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({
      roomid: room.code, server: HOST,
      apptag: room.appTag, locked: room.locked,
      numPlayers: room.clients.size, numAudience: 0,
      audienceEnabled: true, requiresPassword: false,
      joinAs: room.locked ? "full" : "player",
      success: true, error: "",
    }));
    return;
  }

  // ══════════════════════════════════════════════════════
  // ECAST  (PP7+)
  // ══════════════════════════════════════════════════════
  if (path.match(/^\/api\/v2\/app-configs\//)) {
    const appTag = path.split("/").pop();
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ appTag, serverUrl: `wss://${HOST}`, blobcastHost: `https://${HOST}`, isTestServer: false }));
    return;
  }

  if (path === "/api/v2/rooms" && req.method === "POST") {
    readBody().then(raw => {
      let data = {}; try { data = JSON.parse(raw); } catch {}
      const code = uniqueCode();
      rooms.set(code, makeRoom(code, data.appTag || "unknown", data.userId));
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ roomId: code, code, host: `wss://${HOST}`, success: true }));
    });
    return;
  }

  const ecastInfoM = path.match(/^\/api\/v2\/rooms\/([A-Za-z]{4})$/);
  if (ecastInfoM) {
    const code = ecastInfoM[1].toUpperCase();
    const room = rooms.get(code);
    res.setHeader("Content-Type", "application/json");
    if (!room) { res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({ roomId: room.code, appTag: room.appTag, locked: room.locked }));
    return;
  }

  // Fallback
  console.log(`[UNKNOWN] ${req.method} ${path}`);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, host: HOST, rooms: rooms.size }));
});

// ─── SOCKET.IO MESSAGE HANDLER ────────────────────────────────────────────────
function handleSioData(sess, raw) {
  // Parse EIO polling frames: "LEN:PACKET LEN:PACKET ..."
  let i = 0;
  while (i < raw.length) {
    const colon = raw.indexOf(":", i);
    if (colon === -1) break;
    const len = parseInt(raw.slice(i, colon));
    if (isNaN(len)) break;
    const pkt = raw.slice(colon + 1, colon + 1 + len);
    i = colon + 1 + len;
    processEioPkt(sess, pkt);
  }
  // If no framing (raw socket.io packet directly)
  if (i === 0) processEioPkt(sess, raw);
}

function processEioPkt(sess, pkt) {
  if (!pkt || pkt.length === 0) return;
  const eioType = parseInt(pkt[0]);
  const data    = pkt.slice(1);
  console.log(`[SIO][${sess.sid.slice(0,6)}] EIO type=${eioType} data=${data.slice(0,100)}`);

  if (eioType === EIO.PONG) { sess.lastPing = Date.now(); return; }
  if (eioType === EIO.PING) {
    // Send pong back
    sioSend(sess, "pong", {});
    return;
  }
  if (eioType !== EIO.MESSAGE) return;

  // Socket.IO packet inside EIO message
  const sioType = parseInt(data[0]);
  const payload = data.slice(1);

  if (sioType === SIO.CONNECT) { sess.connected = true; return; }
  if (sioType === SIO.DISCONNECT) { cleanupSess(sess); return; }
  if (sioType !== SIO.EVENT) return;

  // Parse Socket.IO event: [eventName, ...args]
  let args = [];
  try {
    // Remove namespace prefix if present (e.g. "/," → skip to "[")
    const jsonStart = payload.indexOf("[");
    args = JSON.parse(payload.slice(jsonStart));
  } catch { return; }

  const [event, ...rest] = args;
  console.log(`[SIO][${sess.sid.slice(0,6)}][${sess.role}] event=${event}`);
  handleSioEvent(sess, event, rest[0]);
}

function handleSioEvent(sess, event, data) {
  const room = rooms.get(sess.roomCode);
  if (!room) return;
  const isHost = sess.role === "host";

  switch (event) {
    case "bc:room":
    case "object":
      if (data && data.key === "bc:room") {
        room.state = data.val;
        broadcastSio(room, sess, "object", { key: "bc:room", val: room.state });
      } else if (isHost) {
        broadcastSio(room, sess, event, data);
      } else {
        const host = getHostSess(room);
        if (host) sioSend(host, event, { ...data, userId: sess.userId, name: sess.name });
      }
      break;

    case "send":
    case "msg":
      if (isHost) {
        const to = data && data.to;
        if (to) {
          const target = [...sioSess.values()].find(s => s.userId === to && s.roomCode === sess.roomCode);
          if (target) sioSend(target, "msg", { from: "server", body: data.body || data });
        } else {
          broadcastSio(room, sess, "msg", { from: "server", body: data && (data.body || data) });
        }
      } else {
        const host = getHostSess(room);
        if (host) sioSend(host, "msg", { from: sess.userId, userId: sess.userId, name: sess.name, body: data });
      }
      break;

    case "lock":
      room.locked = data && data.lock !== false;
      broadcastSio(room, null, "lock", { locked: room.locked, roomid: room.code });
      break;

    default:
      if (isHost) {
        broadcastSio(room, sess, event, data);
      } else {
        const host = getHostSess(room);
        if (host) sioSend(host, event, { userId: sess.userId, name: sess.name, ...data });
      }
  }
}

function getHostSess(room) {
  return [...sioSess.values()].find(s => s.roomCode === room.code && s.role === "host");
}

function broadcastSio(room, skipSess, event, data) {
  for (const [, s] of sioSess) {
    if (s.roomCode !== room.code) continue;
    if (s === skipSess) continue;
    sioSend(s, event, data);
  }
}

function cleanupSess(sess) {
  const room = rooms.get(sess.roomCode);
  if (room) {
    room.clients.delete(sess.userId);
    if (sess.role === "host") {
      room.hostWs = null;
      broadcastSio(room, null, "server:disconnected", { reason: "Host left" });
    } else {
      const host = getHostSess(room);
      if (host) sioSend(host, "client:left", { userId: sess.userId, name: sess.name });
    }
  }
  sioSess.delete(sess.sid);
}

// ─── WEBSOCKET UPGRADE ────────────────────────────────────────────────────────
const sioWss   = new WebSocketServer({ noServer: true }); // Socket.IO upgrade
const ecastWss = new WebSocketServer({ noServer: true }); // Ecast plain WS
const blobWss  = new WebSocketServer({ noServer: true }); // plain Blobcast WS

// Socket.IO WebSocket upgrade handler
sioWss.on("connection", (ws, req) => {
  const u   = new URL(req.url, `http://${req.headers.host}`);
  const sid = u.searchParams.get("sid");
  const sess = sid ? sioSess.get(sid) : null;

  if (!sess) {
    // New connection without prior polling handshake
    const roomCode = (u.searchParams.get("roomId") || u.searchParams.get("roomid") || "").toUpperCase();
    const userId   = u.searchParams.get("userId") || randStr(8);
    const name     = decodeURIComponent(u.searchParams.get("name") || "Player");
    const role     = u.searchParams.get("role") || "player";
    const newSid   = randStr(20);
    const newSess  = makeSioSession(newSid, roomCode, userId, name, role);
    newSess.ws = ws;
    newSess.connected = true;
    sioSess.set(newSid, newSess);

    let room = rooms.get(roomCode);
    if (!room && roomCode.length === 4) { room = makeRoom(roomCode,"unknown",userId); rooms.set(roomCode,room); }
    if (room) {
      const isHost = role === "host" || !room.hostWs;
      newSess.role = isHost ? "host" : role;
      room.clients.set(userId, newSess);
    }

    // Send EIO OPEN + SIO CONNECT
    const handshake = JSON.stringify({ sid: newSid, upgrades: [], pingInterval: 25000, pingTimeout: 5000 });
    ws.send(`0${handshake}`);
    ws.send(`40`);
    console.log(`[SIO-WS] New direct WS sess=${newSid} room=${roomCode} role=${newSess.role}`);
    handleWsMessages(ws, newSess);
    return;
  }

  // Existing session upgrading from polling to WS
  sess.ws = ws;
  console.log(`[SIO-WS] Upgraded sess=${sid.slice(0,6)} room=${sess.roomCode}`);
  // Send EIO UPGRADE ack
  ws.send(`5`); // UPGRADE packet
  handleWsMessages(ws, sess);
});

function handleWsMessages(ws, sess) {
  ws.on("message", raw => {
    const str = raw.toString();
    processEioPkt(sess, str);
  });
  // Ping/pong keepalive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(`2`); // PING
  }, 25000);
  ws.on("close", () => {
    clearInterval(pingInterval);
    cleanupSess(sess);
  });
  ws.on("error", e => console.error(`[SIO-WS] error:`, e.message));
}

// Ecast (PP7+) plain WebSocket
ecastWss.on("connection", (ws, req, code) => {
  const u      = new URL(req.url, `http://${req.headers.host}`);
  const userId = u.searchParams.get("userId") || randStr(8);
  const name   = decodeURIComponent(u.searchParams.get("name") || "Player");
  const role   = u.searchParams.get("role") || "player";

  let room = rooms.get(code);
  if (!room) { ws.close(4004, "Room not found"); return; }

  const isHost = role === "host" || userId === room.hostId;
  if (isHost) room.hostWs = ws;
  room.clients.set(userId, { ws, id: userId, name, role });

  ws.send(JSON.stringify({ opcode: "connected", userId, roomId: code }));
  if (!isHost && room.hostWs?.readyState === WebSocket.OPEN)
    room.hostWs.send(JSON.stringify({ opcode: "client/join", userId, name, role }));

  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const op = msg.opcode || "";
    if (isHost) {
      const fwd = op.replace(/^bc\/server\//, "bc/client/");
      for (const [, c] of room.clients) {
        if (c.ws !== ws && c.ws?.readyState === WebSocket.OPEN)
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

// Plain Blobcast WS (fallback for any WS that isn't Socket.IO or Ecast)
blobWss.on("connection", (ws, req, code) => {
  const u      = new URL(req.url, `http://${req.headers.host}`);
  const userId = u.searchParams.get("userId") || randStr(8);
  const name   = decodeURIComponent(u.searchParams.get("name") || "Player");
  const role   = u.searchParams.get("role") || "player";

  let room = rooms.get(code);
  if (!room) { room = makeRoom(code, "unknown", userId); rooms.set(code, room); }

  const isHost = role === "host" || !room.hostWs;
  if (isHost) room.hostWs = ws;
  room.clients.set(userId, { ws, id: userId, name, role: isHost?"host":role });

  const send = (op, params) => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ seq:0, opcode: op, params }));
  };

  send("ok", { roomid: code, server: HOST, userId });
  if (!isHost && room.state) send("object", { key: "bc:room", val: room.state });

  ws.on("message", raw => {
    let op = "", params = {};
    try {
      const obj = JSON.parse(raw.toString());
      op = obj.opcode || obj.type || ""; params = obj.params || obj.body || {};
    } catch { return; }
    if (isHost) {
      for (const [, c] of room.clients) {
        if (c.ws !== ws && c.ws?.readyState === WebSocket.OPEN)
          c.ws.send(JSON.stringify({ seq:0, opcode: op, params }));
      }
    } else if (room.hostWs?.readyState === WebSocket.OPEN) {
      room.hostWs.send(JSON.stringify({ seq:0, opcode: op, params: { ...params, userId, name } }));
    }
  });
  ws.on("close", () => {
    room.clients.delete(userId);
    if (isHost) room.hostWs = null;
  });
});

// ─── UPGRADE ROUTING ──────────────────────────────────────────────────────────
server.on("upgrade", (req, socket, head) => {
  const u    = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname;
  console.log(`WS Upgrade: ${path}${u.search}`);

  // Socket.IO (EIO=3 or EIO=4 with transport=websocket)
  if (path === "/socket.io" || path === "/socket.io/") {
    sioWss.handleUpgrade(req, socket, head, ws => sioWss.emit("connection", ws, req));
    return;
  }

  // Ecast: /api/v2/rooms/CODE or /api/v2/rooms/CODE/play
  const ecastM = path.match(/\/api\/v2\/rooms\/([A-Za-z]{4})(\/play)?$/i);
  if (ecastM) {
    const code = ecastM[1].toUpperCase();
    ecastWss.handleUpgrade(req, socket, head, ws => ecastWss.emit("connection", ws, req, code));
    return;
  }

  // Plain Blobcast WS: /socket/CODE  /room/CODE  /play/CODE
  const blobM = path.match(/^\/(socket|room|play|blobcast|bc|csp)\/([A-Za-z]{4})/i);
  if (blobM) {
    const code = blobM[2].toUpperCase();
    blobWss.handleUpgrade(req, socket, head, ws => blobWss.emit("connection", ws, req, code));
    return;
  }

  // Query param roomId
  const rid = u.searchParams.get("roomId") || u.searchParams.get("roomid");
  if (rid?.match(/^[A-Za-z]{4}$/)) {
    const code = rid.toUpperCase();
    blobWss.handleUpgrade(req, socket, head, ws => blobWss.emit("connection", ws, req, code));
    return;
  }

  console.warn(`WS: no route for ${path} — destroying`);
  socket.destroy();
});

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sioSess) if (now - s.lastPing > 120000) sioSess.delete(k);
  for (const [k, r] of rooms)   if (now - r.created > 4*3600000) rooms.delete(k);
}, 60000);

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║      Jackbox Private Server v4 — LIVE!           ║
╠══════════════════════════════════════════════════╣
║  Blobcast/Socket.IO (PP1-PP6):                   ║
║    GET  https://${HOST}/room              ║
║    WS   wss://${HOST}/socket.io/          ║
║                                                  ║
║  Ecast plain WS (PP7-PP10+):                     ║
║    WS   wss://${HOST}/api/v2/rooms/X/play ║
╚══════════════════════════════════════════════════╝
  `);
});
