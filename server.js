const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

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
