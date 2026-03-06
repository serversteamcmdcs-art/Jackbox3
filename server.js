/*
 * ============================================================
 *  Jackbox ALL-IN-ONE Private Server
 * ============================================================
 *  Протоколы:
 *   - Ecast  / API v2  -> Party Pack 7, 8, Drawful 2 Intl
 *   - Blobcast / API v1 -> Party Pack 1-6, Fibbage, Quiplash
 *
 *  Роутинг на одном HTTP-сервере:
 *   /api/v2/*       -> Ecast (новый протокол)
 *   /room/*         -> Blobcast REST (старый протокол)
 *   /socket.io/*    -> Blobcast WebSocket (socket.io-v1)
 *   /               -> статус сервера
 * ============================================================
 */

var http = require("http");
var wslib = require("ws");
var URL = require("url");

// ==================== CONFIG ====================
const PORT = process.env.PORT || 8080;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || null;

const ACCESSIBLE_HOST = RENDER_URL
  ? RENDER_URL.replace(/^https?:\/\//, "").replace(/\/$/, "")
  : process.env.HOST || `localhost:${PORT}`;

const USE_SECURE = !!RENDER_URL;
const WS_PROTO = USE_SECURE ? "wss" : "ws";

console.log(`\n🎮 Jackbox All-in-One Server`);
console.log(`   Host    : ${ACCESSIBLE_HOST}`);
console.log(`   Secure  : ${USE_SECURE}`);
console.log(`   Port    : ${PORT}\n`);

// ==================== ROOM STORES ====================
var ecastRooms = {};   // Ecast rooms (PP7, PP8)
var blobRooms = {};    // Blobcast rooms (PP1-PP6)
var sidToRoom = {};    // blobcast: sid -> { code, isHost }

// ==================== SHARED HELPERS ====================
function genCode(store) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return store[code] ? genCode(store) : code;
}

function genSID() {
  return Math.random().toString(36).substr(2, 10) + Math.random().toString(36).substr(2, 10);
}

// ==================== ECAST HELPERS ====================
function ecastCreateRoom(appTag) {
  const code = genCode(ecastRooms);
  ecastRooms[code] = {
    code, appTag,
    hostSocket: null, hostPC: 0,
    players: {}, playerCount: 0,
    blobs: {}, acls: {},
    locked: false, created: Date.now(),
  };
  console.log(`[Ecast] Room created: ${code} (${appTag})`);
  return ecastRooms[code];
}

function ecastSendHostOk(room, ws, seq) {
  if (!ws || ws.readyState !== wslib.WebSocket.OPEN) return;
  ws.send(JSON.stringify({ pc: ++room.hostPC, re: seq, opcode: "ok", result: {} }));
}

function ecastBroadcastPlayers(room, message) {
  const msg = JSON.stringify(message);
  for (const pid in room.players) {
    const p = room.players[pid];
    if (p.socket.readyState === wslib.WebSocket.OPEN) p.socket.send(msg);
  }
}

// ==================== BLOBCAST / ENGINE.IO HELPERS ====================
function eioOpen(sid) {
  return "0" + JSON.stringify({
    sid, upgrades: ["websocket"],
    pingInterval: 25000, pingTimeout: 60000,
  });
}

function sioEvent(name, data) {
  return "42" + JSON.stringify([name, data]);
}

function sioAck(id, data) {
  return "43" + id + JSON.stringify([data]);
}

function sendSIO(ws, event, data) {
  if (!ws || ws.readyState !== wslib.WebSocket.OPEN) return;
  try { ws.send(sioEvent(event, data)); } catch(e) {}
}

function blobCreateRoom(appTag) {
  const code = genCode(blobRooms);
  blobRooms[code] = {
    code, appTag,
    hostSocket: null, hostSID: null,
    players: {}, blobs: {},
    seq: 0, locked: false, created: Date.now(),
  };
  console.log(`[Blobcast] Room created: ${code} (${appTag})`);
  return blobRooms[code];
}

// ==================== HTTP SERVER ====================
var server = http.createServer((req, res) => {
  const parsed = URL.parse(req.url, true);
  const path = parsed.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ---- ECAST: POST /api/v2/rooms ----
  if (path === "/api/v2/rooms" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let appTag = "unknown";
      try { appTag = JSON.parse(body).appTag || appTag; } catch(e) {}
      const room = ecastCreateRoom(appTag);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        body: {
          host: `${WS_PROTO}://${ACCESSIBLE_HOST}/api/v2/rooms/${room.code}/play`,
          code: room.code,
          joinAs: "host",
          token: `host_${room.code}`,
          successUrl: `${WS_PROTO}://${ACCESSIBLE_HOST}/api/v2/rooms/${room.code}/play`,
        },
      }));
    });
    return;
  }

  // ---- ECAST: GET /api/v2/rooms/:code ----
  const ecastRoomM = path.match(/^\/api\/v2\/rooms\/([A-Za-z]{4})$/i);
  if (ecastRoomM) {
    const code = ecastRoomM[1].toUpperCase();
    const room = ecastRooms[code];
    if (!room) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: "not found" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      body: {
        code: room.code, appTag: room.appTag, joinAs: "player",
        token: `player_${Date.now()}`,
        successUrl: `${WS_PROTO}://${ACCESSIBLE_HOST}/api/v2/rooms/${room.code}/play`,
      },
    }));
    return;
  }

  // ---- ECAST: POST /api/v2/rooms/:code/join ----
  const ecastJoinM = path.match(/^\/api\/v2\/rooms\/([A-Za-z]{4})\/join$/i);
  if (ecastJoinM) {
    const code = ecastJoinM[1].toUpperCase();
    const room = ecastRooms[code];
    if (!room) { res.writeHead(404); res.end(JSON.stringify({ ok: false })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      body: {
        joinAs: "player", token: `player_${Date.now()}`,
        successUrl: `${WS_PROTO}://${ACCESSIBLE_HOST}/api/v2/rooms/${code}/play`,
      },
    }));
    return;
  }

  // ---- BLOBCAST: GET /room/:code/ ----
  const blobRoomM = path.match(/^\/room\/([A-Za-z]{4})\/?$/i);
  if (blobRoomM) {
    const code = blobRoomM[1].toUpperCase();
    const room = blobRooms[code];
    if (!room) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "room not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      server: ACCESSIBLE_HOST,
      apptag: room.appTag,
      numAudience: 0,
      joinAs: "player",
      requiresPassword: false,
    }));
    return;
  }

  // ---- BLOBCAST: POST /room ----
  if ((path === "/room" || path === "/room/") && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let appTag = "unknown";
      try { appTag = JSON.parse(body).apptag || JSON.parse(body).appTag || appTag; } catch(e) {}
      const room = blobCreateRoom(appTag);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, code: room.code, server: ACCESSIBLE_HOST }));
    });
    return;
  }

  // ---- Engine.IO HTTP polling (fallback для старых клиентов) ----
  if (path === "/socket.io/" || path === "/socket.io") {
    const sid = parsed.query.sid || genSID();
    if (!parsed.query.sid) {
      const packet = "0" + JSON.stringify({ sid, upgrades: ["websocket"], pingInterval: 25000, pingTimeout: 60000 });
      res.writeHead(200, { "Content-Type": "text/plain; charset=UTF-8", "Access-Control-Allow-Origin": "*" });
      res.end(packet.length + ":" + packet);
    } else {
      res.writeHead(200, { "Content-Type": "text/plain; charset=UTF-8", "Access-Control-Allow-Origin": "*" });
      res.end("1:6");
    }
    return;
  }

  // ---- Статус сервера ----
  if (path === "/" || path === "/health" || path === "/status") {
    const eRooms = Object.keys(ecastRooms).map(c => ({
      code: c, proto: "ecast (PP7/PP8)", appTag: ecastRooms[c].appTag,
      players: Object.keys(ecastRooms[c].players).length,
    }));
    const bRooms = Object.keys(blobRooms).map(c => ({
      code: c, proto: "blobcast (PP1-PP6)", appTag: blobRooms[c].appTag,
      players: Object.keys(blobRooms[c].players).length,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      server: "Jackbox All-in-One Private Server v2.0",
      host: ACCESSIBLE_HOST,
      protocols: ["ecast/v2 (PP7, PP8, Drawful2)", "blobcast/v1 (PP1, PP2, PP3, PP4, PP5, PP6)"],
      activeRooms: eRooms.length + bRooms.length,
      rooms: [...eRooms, ...bRooms],
    }));
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));
});

// ==================== WEBSOCKET ROUTING ====================
var wss = new wslib.WebSocketServer({ server, clientTracking: true });

wss.on("connection", (ws, req) => {
  const parsed = URL.parse(req.url, true);
  const path = parsed.pathname;
  const query = parsed.query;

  // Ecast WebSocket
  const ecastM = path.match(/^\/api\/v2\/rooms\/([A-Za-z]{4})\/play$/i);
  if (ecastM) {
    const code = ecastM[1].toUpperCase();
    const isHost = query.role === "host" || query.joinAs === "host";
    handleEcastWS(ws, code, isHost, query);
    return;
  }

  // Blobcast WebSocket (socket.io path)
  if (path === "/socket.io/" || path === "/socket.io") {
    handleBlobcastWS(ws, query);
    return;
  }

  ws.close(1008, "unknown path");
});

// ==================== ECAST WS HANDLER ====================
function handleEcastWS(ws, code, isHost, query) {
  if (isHost) {
    if (!ecastRooms[code]) {
      ecastRooms[code] = {
        code, appTag: query.appTag || "unknown",
        hostSocket: null, hostPC: 0,
        players: {}, playerCount: 0,
        blobs: {}, acls: {},
        locked: false, created: Date.now(),
      };
    }
    const room = ecastRooms[code];
    room.hostSocket = ws;
    console.log(`[Ecast] Host connected to ${code}`);

    ws.send(JSON.stringify({ opcode: "connected", result: { host: ACCESSIBLE_HOST, code } }));

    ws.on("message", raw => {
      let m; try { m = JSON.parse(raw); } catch(e) { return; }
      handleEcastHostMsg(room, ws, m);
    });
    ws.on("close", () => {
      console.log(`[Ecast] Host left ${code}`);
      if (ecastRooms[code]) ecastRooms[code].hostSocket = null;
    });
    ws.on("error", e => console.log(`[Ecast:host:${code}] ${e.message}`));
    return;
  }

  // Player connection
  const room = ecastRooms[code];
  if (!room) {
    ws.send(JSON.stringify({ opcode: "error", error: "room not found" }));
    ws.close(); return;
  }

  room.playerCount++;
  const pid = String(room.playerCount + 1);
  const name = query.name || `Player ${pid}`;
  room.players[pid] = { socket: ws, id: pid, roles: { player: { name } }, name };
  console.log(`[Ecast] Player "${name}"(${pid}) joined ${code}`);

  ws.send(JSON.stringify({ opcode: "connected", result: { id: pid, secret: `s_${pid}_${Date.now()}` } }));

  // Send existing blobs
  for (const key in room.blobs) {
    const acl = room.acls[key];
    if (!acl || acl === "*" || acl === `id:${pid}`) {
      ws.send(JSON.stringify({ opcode: "object", params: { key }, result: { val: room.blobs[key] } }));
    }
  }

  // Notify host
  if (room.hostSocket && room.hostSocket.readyState === wslib.WebSocket.OPEN) {
    room.hostSocket.send(JSON.stringify({
      pc: ++room.hostPC, opcode: "client/connected",
      result: { id: pid, roles: room.players[pid].roles },
    }));
  }

  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch(e) { return; }
    if (room.hostSocket && room.hostSocket.readyState === wslib.WebSocket.OPEN) {
      room.hostSocket.send(JSON.stringify({
        pc: ++room.hostPC, opcode: m.opcode || "msg",
        result: m.params || m.result || {}, from: pid,
      }));
    }
  });

  ws.on("close", () => {
    console.log(`[Ecast] Player ${pid} left ${code}`);
    delete room.players[pid];
    if (room.hostSocket && room.hostSocket.readyState === wslib.WebSocket.OPEN) {
      room.hostSocket.send(JSON.stringify({
        pc: ++room.hostPC, opcode: "client/disconnected", result: { id: pid },
      }));
    }
  });
  ws.on("error", e => console.log(`[Ecast:player:${code}:${pid}] ${e.message}`));
}

function handleEcastHostMsg(room, ws, m) {
  const op = m.opcode;
  switch (op) {
    case "room/set": {
      const { key, val, acl } = m.params || {};
      if (key === undefined) break;
      room.blobs[key] = val;
      if (acl !== undefined) room.acls[key] = acl;
      for (const pid in room.players) {
        const p = room.players[pid];
        if (p.socket.readyState !== wslib.WebSocket.OPEN) continue;
        const a = room.acls[key];
        if (!a || a === "*" || a === `id:${pid}`) {
          p.socket.send(JSON.stringify({ opcode: "object", params: { key }, result: { val } }));
        }
      }
      ecastSendHostOk(room, ws, m.seq);
      break;
    }
    case "room/send": {
      const { to, body, opcode: msgOp } = m.params || {};
      const ev = msgOp || "msg";
      if (to === "*" || !to) {
        ecastBroadcastPlayers(room, { opcode: ev, result: body, from: "1" });
      } else {
        const t = room.players[to];
        if (t && t.socket.readyState === wslib.WebSocket.OPEN) {
          t.socket.send(JSON.stringify({ opcode: ev, result: body, from: "1" }));
        }
      }
      ecastSendHostOk(room, ws, m.seq);
      break;
    }
    case "room/lock":   room.locked = true;  ecastSendHostOk(room, ws, m.seq); break;
    case "room/unlock": room.locked = false; ecastSendHostOk(room, ws, m.seq); break;
    case "room/kick": {
      const kid = m.params && m.params.id;
      const p = room.players[kid];
      if (p) { p.socket.send(JSON.stringify({ opcode: "client/kicked" })); p.socket.close(); delete room.players[kid]; }
      ecastSendHostOk(room, ws, m.seq);
      break;
    }
    default: ecastSendHostOk(room, ws, m.seq);
  }
}

// ==================== BLOBCAST WS HANDLER ====================
function handleBlobcastWS(ws, query) {
  const sid = query.sid || genSID();
  ws._bcSID = sid;

  ws.send(eioOpen(sid));
  ws.send("40"); // Socket.IO connect

  ws._bcPing = setInterval(() => {
    if (ws.readyState === wslib.WebSocket.OPEN) ws.send("2");
  }, 25000);

  ws.on("message", raw => handleBlobcastMsg(ws, sid, raw.toString()));
  ws.on("close", () => { clearInterval(ws._bcPing); handleBlobcastDisconnect(sid); });
  ws.on("error", e => console.log(`[Blobcast:${sid}] ${e.message}`));
}

function handleBlobcastMsg(ws, sid, raw) {
  if (raw[0] === "3") return; // pong
  if (raw[0] !== "4" || raw[1] !== "2") return; // only EVENT

  let payload = raw.slice(2);
  let ackId = null;
  const ackM = payload.match(/^(\d+)(\[.*)/s);
  if (ackM) { ackId = ackM[1]; payload = ackM[2]; }

  let arr; try { arr = JSON.parse(payload); } catch(e) { return; }
  handleBlobcastEvent(ws, sid, arr[0], arr[1], ackId);
}

function handleBlobcastEvent(ws, sid, event, data, ackId) {
  console.log(`[Blobcast:${sid}] ${event}`);
  const reply = (ev, d) => sendSIO(ws, ev, d);
  const ack = (d) => { if (ackId) try { ws.send(sioAck(ackId, d)); } catch(e) {} };

  switch (event) {

    case "room/create":
    case "create": {
      const appTag = (data && (data.apptag || data.appTag)) || "unknown";
      const room = blobCreateRoom(appTag);
      room.hostSocket = ws;
      room.hostSID = sid;
      sidToRoom[sid] = { code: room.code, isHost: true };
      reply("room/created", { code: room.code, server: ACCESSIBLE_HOST, apptag: appTag });
      ack({ code: room.code });
      break;
    }

    case "room/join":
    case "join": {
      const code = ((data && (data.roomid || data.code || data.roomId)) || "").toUpperCase();
      const userId = (data && (data.userid || data.userId)) || sid;
      const name = (data && data.name) || "Player";
      const room = blobRooms[code];

      if (!room) { reply("room/error", { code: 404, message: "Room not found" }); return; }
      if (room.locked) { reply("room/error", { code: 403, message: "Room locked" }); return; }

      room.players[sid] = { socket: ws, sid, userId, name };
      sidToRoom[sid] = { code, isHost: false };

      // Send current state to player
      for (const key in room.blobs) sendSIO(ws, "text", { key, val: room.blobs[key], seq: 0 });

      reply("room/joined", { code, apptag: room.appTag, joinType: "player" });
      ack({ success: true });

      if (room.hostSocket && room.hostSocket.readyState === wslib.WebSocket.OPEN) {
        sendSIO(room.hostSocket, "client/connected", { id: sid, userId, name, roles: { player: { name } } });
      }
      break;
    }

    case "text":
    case "room/set":
    case "set": {
      const info = sidToRoom[sid];
      if (!info) return;
      const room = blobRooms[info.code];
      if (!room) return;

      const { key, val, acl } = data || {};
      const seq = (data && data.seq) || ++room.seq;
      if (key === undefined) return;
      room.blobs[key] = val;

      if (info.isHost) {
        for (const pid in room.players) {
          const p = room.players[pid];
          if (!p.socket || p.socket.readyState !== wslib.WebSocket.OPEN) continue;
          if (acl && acl !== "*" && acl !== `id:${pid}`) continue;
          sendSIO(p.socket, "text", { key, val, seq });
        }
      } else {
        if (room.hostSocket && room.hostSocket.readyState === wslib.WebSocket.OPEN) {
          sendSIO(room.hostSocket, "text", {
            key, val, seq, from: sid,
            userId: room.players[sid] && room.players[sid].userId,
          });
        }
      }
      reply("result", { seq, success: true });
      ack({ seq });
      break;
    }

    case "msg":
    case "room/send":
    case "send": {
      const info = sidToRoom[sid];
      if (!info) return;
      const room = blobRooms[info.code];
      if (!room) return;

      const to = data && data.to;
      const body = data && (data.body || data.val);
      const msgOp = (data && data.opcode) || event;
      const seq = ++room.seq;

      if (info.isHost) {
        if (!to || to === "*") {
          for (const pid in room.players) {
            const p = room.players[pid];
            if (p.socket && p.socket.readyState === wslib.WebSocket.OPEN) sendSIO(p.socket, msgOp, { body, seq, from: "host" });
          }
        } else {
          const t = room.players[to];
          if (t && t.socket && t.socket.readyState === wslib.WebSocket.OPEN) sendSIO(t.socket, msgOp, { body, seq, from: "host" });
        }
      } else {
        if (room.hostSocket && room.hostSocket.readyState === wslib.WebSocket.OPEN) {
          sendSIO(room.hostSocket, msgOp, {
            body, seq, from: sid,
            userId: room.players[sid] && room.players[sid].userId,
          });
        }
      }
      reply("result", { seq, success: true });
      ack({ seq });
      break;
    }

    case "room/lock":
    case "lock": {
      const info = sidToRoom[sid];
      if (info && blobRooms[info.code]) blobRooms[info.code].locked = true;
      reply("result", { success: true }); ack({ success: true });
      break;
    }
    case "room/unlock":
    case "unlock": {
      const info = sidToRoom[sid];
      if (info && blobRooms[info.code]) blobRooms[info.code].locked = false;
      reply("result", { success: true }); ack({ success: true });
      break;
    }
    case "kick": {
      const info = sidToRoom[sid];
      if (!info || !info.isHost) return;
      const room = blobRooms[info.code];
      if (!room) return;
      const p = room.players[data && data.id];
      if (p && p.socket) {
        sendSIO(p.socket, "kicked", {});
        p.socket.close();
        delete room.players[data.id];
      }
      reply("result", { success: true }); ack({ success: true });
      break;
    }

    default: ack({ success: true });
  }
}

function handleBlobcastDisconnect(sid) {
  const info = sidToRoom[sid];
  if (!info) return;
  const room = blobRooms[info.code];
  delete sidToRoom[sid];
  if (!room) return;

  if (info.isHost) {
    console.log(`[Blobcast] Host disconnected from ${info.code}`);
    room.hostSocket = null;
    for (const pid in room.players) {
      const p = room.players[pid];
      if (p.socket && p.socket.readyState === wslib.WebSocket.OPEN)
        sendSIO(p.socket, "room/closed", { reason: "host disconnected" });
    }
    setTimeout(() => { delete blobRooms[info.code]; }, 5000);
  } else {
    const player = room.players[sid];
    if (player && room.hostSocket && room.hostSocket.readyState === wslib.WebSocket.OPEN) {
      sendSIO(room.hostSocket, "client/disconnected", { id: sid, userId: player.userId, name: player.name });
    }
    delete room.players[sid];
  }
}

// ==================== CLEANUP ====================
setInterval(() => {
  const now = Date.now();
  const limit = 4 * 60 * 60 * 1000;
  for (const c in ecastRooms) if (now - ecastRooms[c].created > limit) delete ecastRooms[c];
  for (const c in blobRooms) if (now - blobRooms[c].created > limit) delete blobRooms[c];
}, 30 * 60 * 1000);

// ==================== START ====================
server.listen(PORT, () => {
  console.log(`\n✅ Server ready on port ${PORT}`);
  console.log(`\n📋 Конфиг для игры (jbg.config.jet):`);
  console.log(`   "serverUrl": "https://${ACCESSIBLE_HOST}"`);
  console.log(`\n   Steam Launch Options:`);
  console.log(`   -jbg.config serverUrl=https://${ACCESSIBLE_HOST}\n`);
});
