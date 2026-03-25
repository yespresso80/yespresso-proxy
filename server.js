const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
let SftpClient;
try { SftpClient = require("ssh2-sftp-client"); } catch(e) { console.log("[SFTP] ssh2-sftp-client non installato:", e.message); }

const PORT = process.env.PORT || 3001;
const HD_TOKEN = "OWU2Yzk0NjItMGM4YS00MmQ2LWJjZjMtODEwZGE5MWNmZDk5OnVzLXNvdXRoMTpQeXN0dE1oQzZUZnhvWXRrTS1VTHVORnpLelE=";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const SHOPIFY_SHOP = "40f758-3.myshopify.com";
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || "";
const IMAP_USER = process.env.IMAP_USER || "allegati@yespresso.it";
const IMAP_PASSWORD = process.env.IMAP_PASSWORD || "";
const IMAP_HOST = "imap.ionos.it";
const IMAP_PORT = 993;

console.log("[INIT] ANTHROPIC_KEY presente:", !!ANTHROPIC_KEY);
console.log("[INIT] SHOPIFY_TOKEN presente:", !!SHOPIFY_TOKEN);
console.log("[INIT] IMAP_USER:", IMAP_USER);
console.log("[INIT] IMAP_PASSWORD presente:", !!IMAP_PASSWORD);

// Cache allegati in memoria
const attachmentsCache = new Map();
let lastImapSync = 0;
const IMAP_SYNC_INTERVAL = 5 * 60 * 1000;

async function syncImapAttachments() {
  if (!IMAP_PASSWORD) { console.log("[IMAP] IMAP_PASSWORD non configurata"); return; }
  const now = Date.now();
  if (now - lastImapSync < IMAP_SYNC_INTERVAL) return;
  lastImapSync = now;

  try {
    const { ImapFlow } = require("imapflow");
    const client = new ImapFlow({
      host: IMAP_HOST, port: IMAP_PORT, secure: true,
      auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
      logger: false
    });

    await client.connect();
    await client.mailboxOpen("INBOX");

    const messages = [];
    for await (const msg of client.fetch("1:*", { envelope: true, bodyStructure: true, uid: true })) {
      messages.push(msg);
    }
    console.log("[IMAP] Messaggi trovati:", messages.length);

    for (const msg of messages.slice(-200)) {
      const messageId = msg.envelope?.messageId || String(msg.uid);
      if (attachmentsCache.has(messageId)) continue;

      const fromEmail = msg.envelope?.from?.[0]?.address || "";
      const subject = msg.envelope?.subject || "";
      const date = msg.envelope?.date || new Date();

      // Verifica se ha allegati
      const struct = msg.bodyStructure;
      const hasAtt = struct && (
        (struct.childNodes||[]).some(n => n.disposition === "attachment" || (n.type && !["text","multipart"].includes(n.type))) ||
        (struct.disposition === "attachment")
      );
      if (!hasAtt) continue;

      // Scarica messaggio completo
      try {
        const download = await client.download(String(msg.seq));
        if (!download) continue;
        const rawChunks = [];
        for await (const chunk of download.content) rawChunks.push(chunk);
        const raw = Buffer.concat(rawChunks).toString("binary");

        // Parsing allegati dal raw - versione robusta
        const attachments = [];
        // Trova tutti i boundary nel messaggio
        const boundaryMatches = [...raw.matchAll(/boundary=["']?([^"'\r\n;\s]+)["']?/gi)];
        const boundaries = [...new Set(boundaryMatches.map(m => m[1]))];
        
        for (const boundary of boundaries) {
          const parts = raw.split(new RegExp("--" + boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          for (const part of parts) {
            // Cerca Content-Disposition: attachment
            const isAttachment = /Content-Disposition:\s*(attachment|inline)/i.test(part);
            const fnMatch = part.match(/(?:filename\*=UTF-8''([^\r\n;]+)|filename="?([^"\r\n;]+)"?)/i);
            const ctMatch = part.match(/Content-Type:\s*([^\r\n;,]+)/i);
            const encMatch = part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
            
            if (fnMatch && ctMatch) {
              let filename = fnMatch[1] || fnMatch[2] || "";
              try { filename = decodeURIComponent(filename.trim()); } catch(e) { filename = filename.trim(); }
              filename = filename.replace(/['"]/g,"").trim();
              const contentType = ctMatch[1].trim().toLowerCase();
              const encoding = (encMatch ? encMatch[1].trim() : "").toLowerCase();
              
              // Accetta base64 per immagini, pdf e altri file
              if (encoding === "base64" && filename) {
                const bodyIdx = part.indexOf("\r\n\r\n");
                const bodyIdx2 = part.indexOf("\n\n");
                const startIdx = bodyIdx >= 0 ? bodyIdx + 4 : (bodyIdx2 >= 0 ? bodyIdx2 + 2 : -1);
                if (startIdx > 0) {
                  // Prendi solo caratteri base64 validi e rimuovi residui esadecimali in coda
                  let b64 = part.slice(startIdx).replace(/[^A-Za-z0-9+/=]/g,"");
                  // Tronca tutto dopo il padding = finale (es. =000000abc e spazzatura esadecimale)
                  const lastEqIdx = b64.lastIndexOf("=");
                  if (lastEqIdx > 0) b64 = b64.substring(0, lastEqIdx + 1);
                  // Normalizza padding
                  const rem = b64.replace(/=/g,"").length % 4;
                  if (rem) b64 = b64.replace(/=*$/, "") + "===".substring(0, 4-rem);
                  if (b64.length > 100) {
                    // Evita duplicati per filename
                    if (!attachments.find(a => a.filename === filename)) {
                      attachments.push({ filename, contentType, data: b64 });
                    }
                  }
                }
              }
            }
          }
        }

        if (attachments.length > 0) {
          attachmentsCache.set(messageId, { from: fromEmail, subject, date, attachments });
          console.log("[IMAP] Allegati salvati:", fromEmail, "|", subject.substring(0,40), "| n:", attachments.length);
        }
      } catch(e2) { console.log("[IMAP] Errore msg:", e2.message); }
    }

    await client.logout();
    console.log("[IMAP] Sync OK. Cache:", attachmentsCache.size, "email con allegati");
  } catch(e) {
    console.error("[IMAP] Errore sync:", e.message);
  }
}

function findAttachmentsForTicket(requesterEmail, subject) {
  const results = [];
  const emailLow = (requesterEmail||"").toLowerCase();
  const subjLow = (subject||"").toLowerCase().substring(0,50);
  for (const [, data] of attachmentsCache) {
    const fromLow = (data.from||"").toLowerCase();
    const dataSubjLow = (data.subject||"").toLowerCase();
    const emailMatch = emailLow && fromLow && (fromLow.includes(emailLow) || emailLow.includes(fromLow.split("@")[0]));
    const subjMatch = subjLow && dataSubjLow && (dataSubjLow.includes(subjLow.substring(0,20)) || subjLow.includes(dataSubjLow.substring(0,20)));
    if (emailMatch || subjMatch) {
      results.push(...data.attachments.map(a => ({ ...a, from: data.from, date: data.date })));
    }
  }
  return results;
}

setTimeout(syncImapAttachments, 8000);

async function getShopifyToken() {
  if (!SHOPIFY_TOKEN) console.error("[SHOPIFY] SHOPIFY_TOKEN non configurato!");
  return SHOPIFY_TOKEN;
}

const server = http.createServer(async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key, User-Agent");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health" || req.url === "/ping") { res.writeHead(200); res.end("OK"); return; }

  // Endpoint allegati IMAP
  if (req.url.startsWith("/imap/attachments")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const email = params.get("email") || "";
    const subject = params.get("subject") || "";
    await syncImapAttachments();
    const attachments = findAttachmentsForTicket(email, subject);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ attachments, cached: attachmentsCache.size }));
    return;
  }

  // Forza sync IMAP
  if (req.url === "/imap/sync") {
    lastImapSync = 0;
    syncImapAttachments().catch(e => console.error(e));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "sync avviato", cached: attachmentsCache.size }));
    return;
  }

  if (req.url === "/" || req.url === "/index.html" || req.url === "/yespresso-helpdesk.html") {
    const filePath = path.join(__dirname, "yespresso-helpdesk.html");
    fs.readFile(filePath, function(err, data) {
      if (err) { res.writeHead(404); res.end("File non trovato"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (req.url.startsWith("/shopify/callback")) { res.writeHead(200); res.end("OK"); return; }


// ═══════════════════════════════════════════════
// BRT REST API Integration
// ═══════════════════════════════════════════════
const BRT_USER = "1791201";
const BRT_PASS = "Dus0549dsb";
const BRT_SFTP_HOST = "sftp.brt.it";
const BRT_SFTP_PORT = 22;
const BRT_SFTP_USER = "1791201";
const BRT_SFTP_PASS = "qyo^G16^H3";
const BRT_SFTP_PATH = "/OUT";
const BRT_REST_BASE = "https://api.brt.it/rest/v1/tracking";
const BRT_VAS = "https://vas.brt.it";
// Token base64 user:pass
const BRT_AUTH = "Basic " + Buffer.from(BRT_USER + ":" + BRT_PASS).toString("base64");

async function brtRestGet(path) {
  const url = BRT_REST_BASE + path;
  console.log("[BRT REST] GET " + url);
  const res = await fetch(url, {
    headers: {
      "Authorization": BRT_AUTH,
      "Accept": "application/json",
      "Content-Type": "application/json"
    }
  });
  const text = await res.text();
  console.log("[BRT REST] status:" + res.status + " body:" + text.substring(0, 300));
  if (!res.ok) throw new Error("BRT " + res.status + ": " + text.substring(0, 100));
  try { return JSON.parse(text); } catch(e) { return text; }
}

async function brtRestPost(path, body) {
  const res = await fetch(BRT_REST_BASE + path, {
    method: "POST",
    headers: {
      "Authorization": BRT_AUTH,
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  console.log("[BRT REST] POST " + path + " status:" + res.status + " body:" + text.substring(0, 300));
  if (!res.ok) throw new Error("BRT " + res.status + ": " + text.substring(0, 200));
  try { return JSON.parse(text); } catch(e) { return text; }
}


  // BRT test connessione - usa parcelID di esempio
  if (req.url.startsWith("/brt/test")) {
    try {
      // Prova con un parcelID di test (numero spedizione)
      const qs = req.url.split("?")[1] || "";
      const params = new URLSearchParams(qs);
      const testId = params.get("id") || "179010735604";
      const data = await brtRestGet("/parcelID/" + testId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // BRT tracking per numero spedizione (parcelID)
  if (req.url.startsWith("/brt/track")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const nspediz = params.get("nspediz") || "";
    if (!nspediz) { res.writeHead(400); res.end(JSON.stringify({ error: "nspediz required" })); return; }
    try {
      const data = await brtRestGet("/parcelID/" + encodeURIComponent(nspediz));
      // Dalla doc: dati_consegna.data_consegna_merce valorizzato = consegnato
      const result = data.ttParcelIdResponse || data;
      const spedizione = result.spedizione || {};
      const datiConsegna = spedizione.dati_consegna || {};
      const delivered = !!(datiConsegna.data_consegna_merce && datiConsegna.data_consegna_merce.trim());
      const firmatario = datiConsegna.firmatario_consegna || "";
      const dataConsegna = datiConsegna.data_consegna_merce || "";
      const eventi = (spedizione.eventi && spedizione.eventi.evento) || [];
      const ultimoEvento = Array.isArray(eventi) ? eventi[eventi.length-1] : eventi;
      console.log("[BRT TRACK] " + nspediz + " consegnato:" + delivered + " data:" + dataConsegna);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered, data_consegna: dataConsegna, firmatario, ultimo_evento: ultimoEvento, raw: data }));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // BRT lista giacenze
  if (req.url.startsWith("/brt/giacenze")) {
    try {
      const data = await brtRestGet("/shipment/storage/list");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // BRT svincola giacenza
  if (req.url.startsWith("/brt/svincola")) {
    const chunks3 = [];
    req.on("data", chunk => chunks3.push(chunk));
    await new Promise(resolve => req.on("end", resolve));
    const body3 = JSON.parse(Buffer.concat(chunks3).toString() || "{}");
    try {
      const data = await brtRestPost("/shipment/storage/release", body3);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // BRT crea ritiro
  if (req.url.startsWith("/brt/ritiro")) {
    const chunks4 = [];
    req.on("data", chunk => chunks4.push(chunk));
    await new Promise(resolve => req.on("end", resolve));
    const body4 = JSON.parse(Buffer.concat(chunks4).toString() || "{}");
    try {
      const data = await brtRestPost("/pickup/create", body4);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Shopify GraphQL proxy
  if (req.url.startsWith("/shopify-graphql")) {
    const token = await getShopifyToken();
    const chunks2 = [];
    req.on("data", chunk => chunks2.push(chunk));
    await new Promise(resolve => req.on("end", resolve));
    const body2 = Buffer.concat(chunks2).toString();
    const gqlRes = await fetch("https://" + SHOPIFY_SHOP + "/admin/api/2024-01/graphql.json", {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: body2
    });
    const gqlData = await gqlRes.text();
    console.log("[GRAPHQL] status:", gqlRes.status, "body:", gqlData.substring(0, 200));
    res.writeHead(gqlRes.status, { "Content-Type": "application/json" });
    res.end(gqlData);
    return;
  }

  // BRT SFTP - leggi file giacenze
  if (req.url.startsWith("/brt/sftp-giacenze")) {
    if (!SftpClient) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "ssh2-sftp-client non installato. Aggiungilo al package.json" }));
      return;
    }
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: BRT_SFTP_HOST,
        port: BRT_SFTP_PORT,
        username: BRT_SFTP_USER,
        password: BRT_SFTP_PASS,
        readyTimeout: 10000,
        retries: 1
      });
      console.log("[BRT SFTP] Connesso a sftp.brt.it");
      // Lista file nella directory OUT
      const fileList = await sftp.list(BRT_SFTP_PATH);
      console.log("[BRT SFTP] File trovati:", fileList.length);
      // Leggi i file più recenti (giacenze)
      const files = fileList.filter(f => f.type === "-").sort((a,b) => b.modifyTime - a.modifyTime).slice(0, 5);
      const results = [];
      for (const file of files) {
        try {
          const content = await sftp.get(BRT_SFTP_PATH + "/" + file.name);
          results.push({ name: file.name, size: file.size, date: new Date(file.modifyTime).toISOString(), content: content.toString("utf8").substring(0, 5000) });
        } catch(fe) { results.push({ name: file.name, error: fe.message }); }
      }
      await sftp.end();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, files: results }));
    } catch(e) {
      console.log("[BRT SFTP] Errore:", e.message);
      try { await sftp.end(); } catch(ee) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Creditsyard customer lookup by email
  if (req.url.startsWith("/creditsyard/customer")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const email = params.get("email") || "";
    if (!email) { res.writeHead(400); res.end(JSON.stringify({ error: "email required" })); return; }
    try {
      const csRes = await fetch("https://creditsyard.com/api/common/customers/get", {
        method: "POST",
        headers: {
          "X-Shop-Api-Key": "412b510ba19f72e6eaab40fdf63aa114",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ customer_email: email })
      });
      const text = await csRes.text();
      console.log("[CREDITSYARD] status:" + csRes.status + " body:", text.substring(0, 200));
      let customer = {};
      try { customer = JSON.parse(text); } catch(pe) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(customer));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── BRT ORM API (Ordini Ritiro Merce) ──
  if (req.url.startsWith("/brt-orm/")) {
    const brtOrmPath = req.url.replace("/brt-orm", "");
    const BRT_ORM_BASE = "https://api.brt.it/orm";
    const BRT_ORM_KEY = "f393e3d3-8402-4614-a90e-8d111fa73ced";
    const ormChunks = []; req.on("data", c => ormChunks.push(c)); await new Promise(r => req.on("end", r));
    const ormBody = Buffer.concat(ormChunks);
    try {
      const ormRes = await fetch(BRT_ORM_BASE + brtOrmPath, {
        method: req.method,
        headers: { "Content-Type": "application/json", "X-Api-Key": BRT_ORM_KEY, "Accept": "application/json" },
        body: ormBody.length > 0 ? ormBody : undefined
      });
      const ormData = await ormRes.text();
      console.log("[BRT ORM]", req.method, brtOrmPath, "->", ormRes.status, ormData.substring(0, 200));
      res.writeHead(ormRes.status, { "Content-Type": "application/json" });
      res.end(ormData);
    } catch(e) {
      console.error("[BRT ORM] Errore:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  let targetUrl, requestHeaders;

  if (req.url.startsWith("/shopify")) {
    const p = req.url.replace(/^\/shopify/, "");
    const token = await getShopifyToken();
    targetUrl = "https://" + SHOPIFY_SHOP + "/admin/api/2024-01" + p;
    requestHeaders = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  } else if (req.url.startsWith("/anthropic")) {
    const p = req.url.replace("/anthropic", "");
    targetUrl = "https://api.anthropic.com" + p;
    requestHeaders = { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": ANTHROPIC_KEY || "" };
  } else {
    const p = req.url.replace(/^\/api/, "");
    targetUrl = "https://api.helpdesk.com" + p;
    requestHeaders = { "Authorization": "Basic " + HD_TOKEN, "User-Agent": "Yespresso-Claude-Integration/1.0" };
    requestHeaders["Content-Type"] = req.headers["content-type"] || "application/json";
  }

  console.log("[PROXY] " + req.method + " " + targetUrl);

  const chunks = [];
  req.on("data", function(chunk) { chunks.push(chunk); });
  req.on("end", function() {
    const bodyBuffer = Buffer.concat(chunks);
    const options = { method: req.method, headers: requestHeaders };
    const proxyReq = https.request(targetUrl, options, function(proxyRes) {
      const respChunks = [];
      proxyRes.on("data", function(chunk) { respChunks.push(chunk); });
      proxyRes.on("end", function() {
        const responseBody = Buffer.concat(respChunks);
        console.log("[RISPOSTA] " + proxyRes.statusCode);
        if (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 201) console.log(responseBody.toString().substring(0, 300));
        const respHeaders = { "Content-Type": proxyRes.headers["content-type"] || "application/json" };
        if (proxyRes.headers["link"]) respHeaders["Link"] = proxyRes.headers["link"];
        if (proxyRes.headers["x-shopify-shop-api-call-limit"]) respHeaders["x-shopify-shop-api-call-limit"] = proxyRes.headers["x-shopify-shop-api-call-limit"];
        res.writeHead(proxyRes.statusCode, respHeaders);
        res.end(responseBody);
      });
    });
    proxyReq.on("error", function(err) { console.error("[ERRORE]", err.message); res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
    if (bodyBuffer.length > 0) proxyReq.write(bodyBuffer);
    proxyReq.end();
  });
});

server.listen(PORT, "0.0.0.0", function() {
  console.log("✅ Server Yespresso avviato su porta " + PORT);
});
