/**
 * Jackbox Private Server v5
 * 
 * Blobcast (PP1-PP6) uses Socket.IO v1 on port 38202:
 *   GET http://HOST:38202/socket.io/1/?t=TIMESTAMP  → handshake
 *   WS  ws://HOST:38202/socket.io/1/websocket/SID
 * 
 * This server listens on BOTH:
 *   PORT     (main HTTP, 8080/443 on Render) → Ecast + room creation
 *   PORT_SIO (38202 for Blobcast Socket.IO v1)
 */

const http   = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const crypto = require("crypto");

const PORT     = parseInt(process.env.PORT)     || 8080;
const PORT_SIO = parseInt(process.env.PORT_SIO) || 38202;
const HOST = process.env.ACCESSIBLE_HOST
          || process.env.RENDER_EXTERNAL_HOSTNAME
          || "localhost";

console.log(`Jackbox v5 | main=${PORT} blobcast=${PORT_SIO} host=${HOST}`);

// ─── STATE ────────────────────────────────────────────────────────────────────
const rooms   = new Map();
const sioSess = new Map(); // sid → session

function randHex(n) { return crypto.randomBytes(n).toString("hex"); }
function makeCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = ""; for (let i=0;i<4;i++) s+=c[Math.floor(Math.random()*c.length)]; return s;
}
function uniqueCode() { let c; do{c=makeCode();}while(rooms.has(c)); return c; }
function makeRoom(code, appTag, hostId) {
  return { code, appTag:appTag||"unknown", hostId:hostId||null,
           clients:new Map(), locked:false, state:null, created:Date.now() };
}

// ─── SOCKET.IO v1 PROTOCOL ────────────────────────────────────────────────────
// Socket.IO v1 handshake response: "SID:HB_TIMEOUT:HB_INTERVAL:TRANSPORTS"
// Messages over WebSocket: "TYPE:ID:ENDPOINT:DATA"
// Types: 0=disconnect 1=connect 2=heartbeat 3=message 4=json 5=event 6=ack 7=error 8=noop

function sio1Send(ws, type, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (type === 5) { // event
    ws.send(`5:::${JSON.stringify(data)}`);
  } else if (type === 2) { // heartbeat
    ws.send(`2::`);
  } else if (type === 1) { // connect
    ws.send(`1::`);
  } else {
    ws.send(`${type}:::${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
}

function sio1Event(ws, name, ...args) {
  sio1Send(ws, 5, { name, args });
}

// ─── BLOBCAST HTTP SERVER (port 38202) ───────────────────────────────────────
const sioServer = http.createServer((req, res) => {
  const u    = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Origin");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  console.log(`[SIO1] HTTP ${req.method} ${req.url}`);

  // Socket.IO v1 handshake: GET /socket.io/1/?t=TIMESTAMP
  // Also handles: GET /socket.io/1/  and  GET /socket.io/
  if (path.match(/^\/socket\.io\/?/) && req.method === "GET" && !u.searchParams.get("sid")) {
    const sid       = randHex(8) + randHex(8);
    const roomCode  = (u.searchParams.get("roomId") || u.searchParams.get("roomid") || "").toUpperCase();
    const userId    = u.searchParams.get("userId")  || randHex(4);
    const name      = decodeURIComponent(u.searchParams.get("name") || "Player");
    const role      = u.searchParams.get("role") || "player";

    // Store session
    sioSess.set(sid, {
      sid, roomCode, userId, name,
      role: role === "host" ? "host" : "player",
      ws: null, created: Date.now()
    });

    // Associate with room
    let room = rooms.get(roomCode);
    if (!room && roomCode.length === 4) {
      room = makeRoom(roomCode, "unknown", userId);
      rooms.set(roomCode, room);
    }
    if (room) room.clients.set(userId, sioSess.get(sid));

    // Socket.IO v1 handshake: SID:HB_TIMEOUT:HB_INTERVAL:TRANSPORTS
    const handshake = `${sid}:60:60:websocket,xhr-polling`;
    res.setHeader("Content-Type", "text/plain");
    res.writeHead(200);
    res.end(handshake);
    console.log(`[SIO1] Handshake → sid=${sid.slice(0,8)} room=${roomCode}`);
    return;
  }

  // XHR polling fallback (we don't support it fully, just return noop)
  if (path.match(/^\/socket\.io\/1\/xhr-polling\//)) {
    res.setHeader("Content-Type", "text/plain");
    res.writeHead(200);
    res.end("8::"); // noop
    return;
  }

  res.writeHead(200);
  res.end("ok");
});

// Socket.IO v1 WebSocket: /socket.io/1/websocket/SID
const sio1Wss = new WebSocketServer({ noServer: true });
sio1Wss.on("connection", (ws, req, sid) => {
  const sess = sioSess.get(sid);
  if (!sess) {
    console.log(`[SIO1-WS] Unknown sid=${sid.slice(0,8)}, closing`);
    ws.close(); return;
  }
  sess.ws = ws;
  const room = rooms.get(sess.roomCode);
  const isHost = sess.role === "host";

  console.log(`[SIO1-WS] Connected sid=${sid.slice(0,8)} room=${sess.roomCode} role=${sess.role}`);

  // Send Socket.IO v1 connect packet
  ws.send(`1::`);

  // Heartbeat
  const hb = setInterval(() => { if (ws.readyState===WebSocket.OPEN) ws.send(`2::`); }, 25000);

  // Send current room state to new player
  if (!isHost && room?.state) {
    sio1Event(ws, "object", { key: "bc:room", val: room.state });
  }

  // Notify host of new player
  if (!isHost && room) {
    const hostSess = getHostSess(room.code);
    if (hostSess?.ws) sio1Event(hostSess.ws, "client:joined", {
      userId: sess.userId, name: sess.name, role: sess.role, roomid: room.code
    });
  }

  ws.on("message", raw => {
    const str = raw.toString();
    console.log(`[SIO1][${sess.roomCode}][${isHost?"H":"P"}] RAW: ${str.slice(0,150)}`);

    // Parse: "TYPE:ID:ENDPOINT:DATA"
    const parts = str.split(":");
    const type  = parseInt(parts[0]);
    if (isNaN(type)) return;

    if (type === 2) { ws.send(`2::`); return; } // heartbeat reply
    if (type === 0) { cleanupSess(sess); return; } // disconnect

    // Event (type 5): parse JSON
    if (type === 5) {
      const jsonStr = parts.slice(3).join(":") || parts[3] || "";
      let event = "", args = [];
      try {
        const obj = JSON.parse(jsonStr);
        event = obj.name; args = obj.args || [];
      } catch { return; }
      handleBlobEvent(sess, room, isHost, event, args[0]);
    }

    // Message (type 3): forward raw
    if (type === 3) {
      const data = parts.slice(3).join(":");
      if (isHost) broadcastSio1(room, sess, 3, data);
      else {
        const h = getHostSess(room?.code);
        if (h?.ws) h.ws.send(str);
      }
    }
  });

  ws.on("close", () => {
    clearInterval(hb);
    cleanupSess(sess);
  });
  ws.on("error", e => console.error(`[SIO1-WS] error:`, e.message));
});

sioServer.on("upgrade", (req, socket, head) => {
  const u    = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname;
  console.log(`[SIO1] WS Upgrade: ${path}`);

  // /socket.io/1/websocket/SID
  const wsM = path.match(/^\/socket\.io\/1\/websocket\/(.+)$/);
  if (wsM) {
    const sid = wsM[1];
    sio1Wss.handleUpgrade(req, socket, head, ws => sio1Wss.emit("connection", ws, req, sid));
    return;
  }
  socket.destroy();
});

function handleBlobEvent(sess, room, isHost, event, data) {
  if (!room) return;
  console.log(`[SIO1][${room.code}][${isHost?"H":"P"}] event=${event}`);

  switch (event) {
    case "bc:room":
    case "object":
      if (data && data.key === "bc:room") {
        room.state = data.val;
        broadcastSio1Event(room, sess, "object", { key: "bc:room", val: room.state });
      } else if (isHost) {
        broadcastSio1Event(room, sess, event, data);
      } else {
        const h = getHostSess(room.code);
        if (h?.ws) sio1Event(h.ws, event, { ...data, userId: sess.userId, name: sess.name });
      }
      break;
    case "lock":
      room.locked = !data || data.lock !== false;
      broadcastSio1Event(room, null, "lock", { locked: room.locked });
      break;
    case "send": case "msg":
      if (isHost) {
        broadcastSio1Event(room, sess, "msg", { from:"server", body: data?.body || data });
      } else {
        const h = getHostSess(room.code);
        if (h?.ws) sio1Event(h.ws, "msg", { userId:sess.userId, name:sess.name, body:data });
      }
      break;
    default:
      if (isHost) broadcastSio1Event(room, sess, event, data);
      else {
        const h = getHostSess(room.code);
        if (h?.ws) sio1Event(h.ws, event, { userId:sess.userId, name:sess.name, ...data });
      }
  }
}

function getHostSess(roomCode) {
  return [...sioSess.values()].find(s => s.roomCode === roomCode && s.role === "host");
}
function broadcastSio1Event(room, skipSess, event, data) {
  for (const [, s] of sioSess) {
    if (s.roomCode !== room.code || s === skipSess) continue;
    if (s.ws) sio1Event(s.ws, event, data);
  }
}
function broadcastSio1(room, skipSess, type, data) {
  for (const [, s] of sioSess) {
    if (s.roomCode !== room.code || s === skipSess) continue;
    if (s.ws?.readyState === WebSocket.OPEN) sio1Send(s.ws, type, data);
  }
}
function cleanupSess(sess) {
  const room = rooms.get(sess.roomCode);
  if (room) {
    room.clients.delete(sess.userId);
    if (sess.role === "host") {
      broadcastSio1Event(room, null, "server:disconnected", { reason:"Host left" });
    } else {
      const h = getHostSess(sess.roomCode);
      if (h?.ws) sio1Event(h.ws, "client:left", { userId:sess.userId, name:sess.name });
    }
  }
  sioSess.delete(sess.sid);
}

// ─── MAIN HTTP SERVER (port 8080 / Render) ────────────────────────────────────
const mainServer = http.createServer((req, res) => {
  const u    = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname.replace(/\/+$/,"") || "/";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
  if (req.method==="OPTIONS"){res.writeHead(204);res.end();return;}

  console.log(`HTTP ${req.method} ${req.url}`);

  const readBody = () => new Promise(ok => {
    let b=""; req.on("data",d=>b+=d); req.on("end",()=>ok(b));
  });

  // Blobcast room create/info
  if (path==="/room") {
    const handle = (data) => {
      const appTag = data.appTag||data.apptag||u.searchParams.get("appTag")||u.searchParams.get("apptag")||"unknown";
      const userId = data.userId||data.user_id||u.searchParams.get("userId")||randHex(4);
      const wc     = data.roomId||data.roomid||u.searchParams.get("roomId");
      const code   = (wc&&wc.length===4&&!rooms.has(wc.toUpperCase()))?wc.toUpperCase():uniqueCode();
      rooms.set(code, makeRoom(code, appTag, userId));
      console.log(`[Room] CREATED ${code} appTag=${appTag}`);
      res.writeHead(200);
      res.end(JSON.stringify({
        roomid:code, roomId:code, server:HOST,
        apptag:appTag, appTag, appid:"jb-private",
        numPlayers:0, numAudience:0,
        audienceEnabled:true, requiresPassword:false,
        locked:false, joinAs:"player", error:"", success:true,
      }));
    };
    if (req.method==="POST") readBody().then(r=>{let d={};try{d=JSON.parse(r);}catch{}handle(d);});
    else handle({ appTag:u.searchParams.get("appTag")||u.searchParams.get("apptag"),
                  userId:u.searchParams.get("userId"), roomId:u.searchParams.get("roomId") });
    return;
  }

  const blobInfo = path.match(/^\/room\/([A-Za-z]{4})$/);
  if (blobInfo) {
    const code = blobInfo[1].toUpperCase();
    const room = rooms.get(code);
    if (!room){res.writeHead(404);res.end(JSON.stringify({roomid:null,success:false}));return;}
    res.writeHead(200);
    res.end(JSON.stringify({ roomid:code, server:HOST, apptag:room.appTag,
      locked:room.locked, numPlayers:room.clients.size, numAudience:0,
      audienceEnabled:true, requiresPassword:false,
      joinAs:room.locked?"full":"player", success:true, error:"" }));
    return;
  }

  // Ecast
  if (path.match(/^\/api\/v2\/app-configs\//)) {
    const appTag = path.split("/").pop();
    res.writeHead(200);
    res.end(JSON.stringify({ appTag, serverUrl:`wss://${HOST}`, blobcastHost:`https://${HOST}`, isTestServer:false }));
    return;
  }
  if (path==="/api/v2/rooms"&&req.method==="POST") {
    readBody().then(r=>{let d={};try{d=JSON.parse(r);}catch{}
      const code=uniqueCode(); rooms.set(code,makeRoom(code,d.appTag||"unknown",d.userId));
      res.writeHead(200); res.end(JSON.stringify({roomId:code,code,host:`wss://${HOST}`,success:true}));
    }); return;
  }
  const ecastInfo = path.match(/^\/api\/v2\/rooms\/([A-Za-z]{4})$/);
  if (ecastInfo) {
    const room = rooms.get(ecastInfo[1].toUpperCase());
    if (!room){res.writeHead(404);res.end(JSON.stringify({error:"Not found"}));return;}
    res.writeHead(200);
    res.end(JSON.stringify({roomId:room.code,appTag:room.appTag,locked:room.locked}));
    return;
  }

  res.writeHead(200);
  res.end(JSON.stringify({ ok:true, host:HOST, rooms:rooms.size,
    note:`Blobcast (PP1-PP6) needs port ${PORT_SIO} open. On Render use Railway or fly.io instead.` }));
});

// Ecast WS on main server
const ecastWss = new WebSocketServer({ noServer: true });
ecastWss.on("connection", (ws, req, code) => {
  const u      = new URL(req.url,`http://${req.headers.host}`);
  const userId = u.searchParams.get("userId")||randHex(4);
  const name   = decodeURIComponent(u.searchParams.get("name")||"Player");
  const role   = u.searchParams.get("role")||"player";
  const room   = rooms.get(code);
  if (!room){ws.close(4004,"Not found");return;}
  const isHost = role==="host"||userId===room.hostId;
  if (isHost) room.hostWs=ws;
  room.clients.set(userId,{ws,id:userId,name,role});
  ws.send(JSON.stringify({opcode:"connected",userId,roomId:code}));
  if (!isHost&&room.hostWs?.readyState===WebSocket.OPEN)
    room.hostWs.send(JSON.stringify({opcode:"client/join",userId,name,role}));
  ws.on("message",raw=>{
    let msg;try{msg=JSON.parse(raw.toString());}catch{return;}
    const op=msg.opcode||"";
    if(isHost){const fwd=op.replace(/^bc\/server\//,"bc/client/");
      for(const[,c]of room.clients)if(c.ws!==ws&&c.ws?.readyState===WebSocket.OPEN)
        c.ws.send(JSON.stringify({opcode:fwd,...(msg.params||{})}));
    }else if(room.hostWs?.readyState===WebSocket.OPEN)
      room.hostWs.send(JSON.stringify({opcode:op,userId,name,...(msg.params||{})}));
  });
  ws.on("close",()=>{room.clients.delete(userId);if(isHost)room.hostWs=null;
    else if(room.hostWs?.readyState===WebSocket.OPEN)
      room.hostWs.send(JSON.stringify({opcode:"client/leave",userId,name}));});
});

mainServer.on("upgrade",(req,socket,head)=>{
  const u=new URL(req.url,`http://${req.headers.host}`);
  const path=u.pathname;
  console.log(`WS Upgrade: ${path}`);
  const eM=path.match(/\/api\/v2\/rooms\/([A-Za-z]{4})(\/play)?$/i);
  if(eM){const code=eM[1].toUpperCase();
    ecastWss.handleUpgrade(req,socket,head,ws=>ecastWss.emit("connection",ws,req,code));return;}
  socket.destroy();
});

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
setInterval(()=>{
  const now=Date.now();
  for(const[k,s]of sioSess)if(now-s.created>3600000)sioSess.delete(k);
  for(const[k,r]of rooms)  if(now-r.created>4*3600000)rooms.delete(k);
},60000);

// ─── START BOTH SERVERS ───────────────────────────────────────────────────────
mainServer.listen(PORT, ()=>console.log(`Main server (Ecast) → :${PORT}`));
sioServer.listen(PORT_SIO, ()=>console.log(`Blobcast Socket.IO v1 → :${PORT_SIO}`));

console.log(`
╔══════════════════════════════════════════════════════════╗
║         Jackbox Private Server v5                        ║
╠══════════════════════════════════════════════════════════╣
║  PP1-PP6 (Blobcast/Socket.IO v1):                        ║
║    In jbg.config.jet: "serverUrl": "${HOST}"    ║
║    Needs port 38202 open! Use Railway/fly.io/VPS         ║
║                                                          ║
║  PP7+ (Ecast):                                           ║
║    In jbg.config.jet: "serverUrl": "https://${HOST}" ║
╚══════════════════════════════════════════════════════════╝
`);
