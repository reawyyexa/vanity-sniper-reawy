const http2 = require("http2");
const tls = require("tls");
const WebSocket = require("ultimate-ws");
const https = require("https");
const os = require("os");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
os.setPriority(process.pid, -20);

let mfaToken = null;
const token = 'vanity alacak token';
const listenerToken = 'vanity izleyecek token';
const password = 'vanity alacak tokenin şifresi';
const serverID = 'vanitynin alınacağı sunucu idsi';
const ips = ["canary.discord.com"];

const REAWY_WEBHOOK = "webhook url";

const guilds = new Map();
const cache = new Map();
const tlsSockets = [];
const keepAliveBuffer = Buffer.from("GET / HTTP/1.1\r\nHost: canary.discord.com\r\n\r\n");

const sessionSettings = [
  { initialWindowSize: 1073741824, maxConcurrentStreams: 100, maxHeaderListSize: 16384, maxFrameSize: 16777215, headerTableSize: 4096 },
  { initialWindowSize: 1073741824, maxConcurrentStreams: 5000, maxHeaderListSize: 8192, maxFrameSize: 32768, headerTableSize: 4096 },
  { initialWindowSize: 1073741824, maxConcurrentStreams: 5000, maxHeaderListSize: 3500, maxFrameSize: 32768, headerTableSize: 4096 },
];

function cacheRequest(code) {
  const payload = `{"code":"${code}"}`;
  const tlsBuffer = Buffer.from(
    `PATCH /api/v9/guilds/${serverID}/vanity-url HTTP/1.1\r\n` +
    `Host: canary.discord.com\r\n` +
    `Authorization: ${token}\r\n` +
    `Content-Type: application/json\r\n` +
    `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36\r\n` +
    `X-Discord-Mfa-Authorization: ${mfaToken}\r\n` +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
    payload
  );

  cache.set(code, {
    tlsBuffer,
    http2Headers: {
      ":method": "PATCH",
      ":path": `/api/v9/guilds/${serverID}/vanity-url`,
      "Authorization": token,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      "X-Discord-Mfa-Authorization": mfaToken || ""
    },
    payload
  });
}

function createTlsSocket(ip) {
  const socket = tls.connect({
    host: ip, port: 443, servername: 'canary.discord.com',
    minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
    rejectUnauthorized: false, noDelay: true
  });
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);
  socket.once('error', () => { setTimeout(() => createTlsSocket(ip), 1500); });
  tlsSockets.push(socket);
  return socket;
}

const sessionPool = sessionSettings.map((settings, idx) => {
  const session = http2.connect("https://canary.discord.com", {
    settings: { enablePush: false, ...settings },
    createConnection: () => tls.connect({
      host: "canary.discord.com", port: 443, servername: "canary.discord.com",
      ALPNProtocols: ['h2'], rejectUnauthorized: false, noDelay: true
    })
  });
  session.on("connect", () => console.log(`[HTTP2] connected: ${idx}`));
  return session;
});

sessionPool[0].once("connect", () => {
  ips.forEach(ip => createTlsSocket(ip));
  handleMFA();
  setInterval(handleMFA, 5 * 60 * 1000);
});

const heartbeat = Buffer.from('{"op":1,"d":null}');
const identifyPayload = Buffer.from(JSON.stringify({
  op: 2,
  d: { token: listenerToken, intents: 1, properties: { os: "linux", browser: "Discord Client", device: "Desktop" } }
}));

for (let i = 1; i <= 2; i++) {
  sessionPool[i].once("connect", () => {
    const ws = new WebSocket(`wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json`, {
      perMessageDeflate: false, rejectUnauthorized: false
    });
    let isReady = false;

    ws.onopen = () => {
      ws.send(identifyPayload);
      setInterval(() => { if (ws.readyState === 1) ws.send(heartbeat); }, 41250);
    };

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.t === "GUILD_UPDATE" && isReady) {
        const vanity = guilds.get(msg.d.id);
        if (vanity && vanity !== msg.d.vanity_url_code) {
          const cached = cache.get(vanity);
          
          for (let j = 0; j < tlsSockets.length; j++) tlsSockets[j].write(cached.tlsBuffer);
          
          for (let j = 0; j < sessionPool.length; j++) {
            const req = sessionPool[j].request(cached.http2Headers);
            req.on("response", () => {
              let resData = "";
              req.on("data", (chunk) => resData += chunk);
              req.on("end", () => {
                setImmediate(() => {
                  const whBody = JSON.stringify({
                    content: "@everyone",
                    embeds: [{ 
                      description: `・ **Vanity : discord.gg/${vanity}**\n\n**Response:**\n\`\`\`json\n${resData}\n\`\`\``, 
                      color: 0x000000,
                      footer: { text: "all vanity urls will be ours one day" }
                    }]
                  });
                  const whReq = https.request(REAWY_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" } });
                  whReq.on("error", () => {});
                  whReq.write(whBody);
                  whReq.end();
                });
              });
            });
            req.end(cached.payload);
          }
        }
      } else if (msg.t === "READY") {
        isReady = true;
        msg.d.guilds.forEach(g => {
          if (g.vanity_url_code) {
            guilds.set(g.id, g.vanity_url_code);
            cacheRequest(g.vanity_url_code);
          }
        });
        console.log(`[READY] Guilds: (${guilds.size}) - ${[...guilds.values()].join(", ")}`);
      }
    };
    ws.onerror = () => ws.close();
  });
}

async function handleMFA() {
  try {
    const ticket = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "canary.discord.com", port: 443, path: "/api/v10/guilds/0/vanity-url", method: "PATCH",
        headers: { Authorization: token, "Content-Type": "application/json" },
        timeout: 1000,
        agent: new https.Agent({
          ciphers: ["TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256", "TLS_AES_128_GCM_SHA256"].join(":"),
          honorCipherOrder: true, rejectUnauthorized: true
        })
      }, res => {
        let data = '';
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(data || "{}")?.mfa?.ticket); } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.end('{"code":""}');
    });

    if (!ticket) { setTimeout(handleMFA, 60000); return; }

    const mfaTokenResult = await new Promise((resolve, reject) => {
      const mfaReq = https.request({
        hostname: "canary.discord.com", port: 443, path: "/api/v10/mfa/finish", method: "POST",
        headers: {
          Authorization: token,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord-canary/1.0.697 Chrome/134.0.6998.205 Electron/35.3.0 Safari/537.36",
          "Content-Type": "application/json",
          "X-Super-Properties": "eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRGlzY29yZCBDbGllbnQiLCJyZWxlYXNlX2NoYW5uZWwiOiJjYW5hcnkiLCJjbGllbnRfdmVyc2lvbiI6IjEuMC42OTciLCJvc192ZXJzaW9uIjoiMTAuMC4xOTA0NSIsIm9zX2FyY2giOiJ4NjQiLCJhcHBfYXJjaCI6Ing2NCIsInN5c3RlbV9sb2NhbGUiOiJ0ciIsImhhc19jbGllbnRfbW9kcyI6ZmFsc2UsImNsaWVudF9sYXVuY2hfaWQiOiJjZjE1NzZhNC01NDEyLTRkOWQtYjY5Ny00OGJkZWY5MjE4NDQiLCJicm93c2VyX3VzZXJfYWdlbnQiOiJNb3ppbGxhLzUuMCAoV2luZG93cyBOVCAxMC4wOyBXaW42NDsgeDY0KSBBcHBsZVdlYktpdC81MzcuMzYgKEtIVE1MLCBsaWtlIEdlY2tvKSBkaXNjb3JkLWNhbmFyeS8xLjAuNjk3IENocm9tZS8xMzQuMC42OTk4LjIwNSBFbGVjdHJvbi8zNS4zLjAgU2FmYXJpLzUzNy4zNiIsImJyb3dzZXJfdmVyc2lvbiI6IjM1LjMuMCIsIm9zX3Nka192ZXJzaW9uIjoiMTkwNDUiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjo0MzI3MTMsIm5hdGl2ZV9idWlsZF9udW1iZXIiOjY3Njg1LCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsLCJsYXVuY2hfc2lnbmF0dXJlIjoiNGIyODRiMDMtODc3ZC00NzEyLThkNmEtYWUyY2ZlNTEwMzk1IiwiY2xpZW50X2hlYXJ0YmVhdF9zZXNzaW9uX2lkIjoiM2E1YThkZGMtYWFkMy00NjlhLTliYWYtYjZlNzc5N2UxOGEwIiwiY2xpZW50X2FwcF9zdGF0ZSI6ImZvY3VzZWQifQ=="
        },
        timeout: 1000,
        agent: new https.Agent({
          ciphers: ["TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256", "TLS_AES_128_GCM_SHA256"].join(":"),
          honorCipherOrder: true, rejectUnauthorized: true
        })
      }, mfaRes => {
        let data = '';
        mfaRes.on("data", chunk => data += chunk);
        mfaRes.on("end", () => {
          try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); }
        });
      });
      mfaReq.on("error", reject);
      mfaReq.end(`{"ticket":"${ticket}","mfa_type":"password","data":"${password}"}`);
    });

    if (mfaTokenResult?.token) {
      mfaToken = mfaTokenResult.token;
      console.log("[MFA] OK");
      for (const vanity of guilds.values()) cacheRequest(vanity);
    } else {
      console.log("[MFA] error:", mfaTokenResult);
      setTimeout(handleMFA, 60000);
    }
  } catch (e) { setTimeout(handleMFA, 60000); }
}

setInterval(() => {
  tlsSockets.forEach(sock => { if (!sock.destroyed) sock.write(keepAliveBuffer); });
}, 10000);

setTimeout(() => {
  console.log("[SYSTEM] restart...");
  process.exit(0);
}, 30 * 60 * 1000);
