const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
let SftpClient;
try { SftpClient = require("ssh2-sftp-client"); } catch(e) { console.log("[SFTP] ssh2-sftp-client non installato:", e.message); }

const PORT = process.env.PORT || 3001;
const HD_TOKEN = process.env.HD_TOKEN || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const SHOPIFY_SHOP = "40f758-3.myshopify.com";
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || "";
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "";
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";
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

      // Verifica se ha allegati (ricerca ricorsiva)
      const struct = msg.bodyStructure;
      function hasAttachment(node) {
        if (!node) return false;
        if (node.disposition === "attachment") return true;
        if (node.encoding === "base64" && node.type && node.type.indexOf("text/") !== 0) return true;
        if (node.childNodes) return node.childNodes.some(hasAttachment);
        return false;
      }
      const hasAtt = hasAttachment(struct);
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

let _shopifyToken = null;
let _shopifyTokenExpiresAt = 0;

async function getShopifyToken() {
  if (SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET) {
    if (_shopifyToken && Date.now() < _shopifyTokenExpiresAt - 60000) return _shopifyToken;
    try {
      const params = new URLSearchParams({ grant_type: "client_credentials", client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET });
      const resp = await fetch("https://" + SHOPIFY_SHOP + "/admin/oauth/access_token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
      if (!resp.ok) throw new Error("Token " + resp.status + ": " + await resp.text());
      const data = await resp.json();
      _shopifyToken = data.access_token;
      _shopifyTokenExpiresAt = Date.now() + (data.expires_in || 86399) * 1000;
      console.log("[SHOPIFY] Token rinnovato, scade in", data.expires_in, "sec");
      return _shopifyToken;
    } catch(e) {
      console.error("[SHOPIFY] Errore rinnovo:", e.message);
      if (SHOPIFY_TOKEN) return SHOPIFY_TOKEN;
      throw e;
    }
  }
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

  if (req.url === "/imap/clear-cache") {
    attachmentsCache.clear();
    lastImapSync = 0;
    syncImapAttachments().catch(e => console.error(e));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "cache svuotata e sync avviato" }));
    return;
  }

  if (req.url === "/reso-magazzino.html") {
    const rpFile = path.join(__dirname, "reso-magazzino.html");
    fs.readFile(rpFile, function(err, data) {
      if (err) { res.writeHead(404); res.end("File non trovato"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(data);
    });
    return;
  }
  if (req.url === "/reso-magazzino.html") {
    const resoFile = path.join(__dirname, "reso-magazzino.html");
    fs.readFile(resoFile, function(err, data) {
      if (err) { res.writeHead(404); res.end("File non trovato"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(data);
    });
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
const BRT_PASS = process.env.BRT_PASS || "";
const BRT_SFTP_HOST = "sftp.brt.it";
const BRT_SFTP_PORT = 22;
const BRT_SFTP_USER = "1791201";
const BRT_SFTP_PASS = process.env.BRT_SFTP_PASS || "";
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

  // BRT check fermopoint
  if (req.url.startsWith("/brt/check-fermopoint")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const nspediz = params.get("nspediz") || "";
    if (!nspediz) { res.writeHead(400); res.end(JSON.stringify({ error: "nspediz required" })); return; }
    try {
      const data = await brtRestGet("/parcelID/" + encodeURIComponent(nspediz));
      const result = data.ttParcelIdResponse || data;
      const spedizione = result.spedizione || {};
      const eventi = (spedizione.eventi && spedizione.eventi.evento) || [];
      const eventiArr = Array.isArray(eventi) ? eventi : [eventi];
      const ultimoEvento = eventiArr[eventiArr.length - 1] || {};
      const descEvento = (ultimoEvento.descrizione_evento || "").toUpperCase();
      const at_fermopoint = descEvento.includes("FERMO") || descEvento.includes("PUNTO DI RITIRO") || descEvento.includes("FERMOPOINT");
      const scadenza_ritiro = ultimoEvento.data_evento || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, at_fermopoint, scadenza_ritiro, raw: data }));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // BRT ORM - prenotazione ritiri
  if (req.url.startsWith("/brt-orm/")) {
    const p = req.url.replace("/brt-orm", "");
    const chunks_orm = [];
    req.on("data", chunk => chunks_orm.push(chunk));
    await new Promise(resolve => req.on("end", resolve));
    const body_orm = Buffer.concat(chunks_orm);
    try {
      const brtOrmRes = await fetch("https://api.brt.it/orm" + p, {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": req.headers["x-api-key"] || "f393e3d3-8402-4614-a90e-8d111fa73ced"
        },
        body: body_orm.length > 0 ? body_orm : undefined
      });
      const brtOrmText = await brtOrmRes.text();
      console.log("[BRT ORM]", req.method, p, "->", brtOrmRes.status, brtOrmText.substring(0, 200));
      res.writeHead(brtOrmRes.status, { "Content-Type": "application/json" });
      res.end(brtOrmText);
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
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

  // Creditsyard adjust - crea/modifica credito cliente
  if (req.url.startsWith("/creditsyard/adjust")) {
    const chunks_cs = [];
    req.on("data", chunk => chunks_cs.push(chunk));
    await new Promise(resolve => req.on("end", resolve));
    const body_cs = Buffer.concat(chunks_cs).toString();
    try {
      const csRes = await fetch("https://creditsyard.com/api/common/credits/adjust", {
        method: "POST",
        headers: { "X-Shop-Api-Key": "412b510ba19f72e6eaab40fdf63aa114", "Content-Type": "application/json" },
        body: body_cs
      });
      const text = await csRes.text();
      console.log("[CREDITSYARD adjust] status:" + csRes.status + " body:", text.substring(0, 200));
      let result = {};
      try { result = JSON.parse(text); } catch(pe) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── RESI — GitHub come database persistente ──
  const GH_RESI_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/resi.json';

  async function ghResiGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: [], sha: null };
    const r = await fetch(GH_RESI_URL, {
      headers: { 'Authorization': 'token ' + ghToken, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (r.status === 404) return { data: [], sha: null };
    const j = await r.json();
    const data = JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8'));
    return { data, sha: j.sha };
  }

  async function ghResiSave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update resi', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(GH_RESI_URL, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + ghToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  if (req.url === '/resi' && req.method === 'GET') {
    try {
      const { data } = await ghResiGet();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      console.error('[RESI GET]', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  if (req.url === '/resi' && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const newData = JSON.parse(Buffer.concat(chunks).toString());
      const { sha } = await ghResiGet();
      await ghResiSave(Array.isArray(newData) ? newData : [], sha);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      console.error('[RESI POST]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── QUICK REPLIES — GitHub come database persistente ──
  const GH_QR_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/quick-replies.json';

  async function ghQrGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: { replies: [], cats: [] }, sha: null };
    const r = await fetch(GH_QR_URL, {
      headers: { 'Authorization': 'token ' + ghToken, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (r.status === 404) return { data: { replies: [], cats: [] }, sha: null };
    const j = await r.json();
    const data = JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8'));
    return { data, sha: j.sha };
  }

  async function ghQrSave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update quick-replies', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(GH_QR_URL, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + ghToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  if (req.url === '/quick-replies' && req.method === 'GET') {
    try {
      const { data } = await ghQrGet();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      console.error('[QR GET]', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ replies: [], cats: [] }));
    }
    return;
  }

  if (req.url === '/quick-replies' && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const newData = JSON.parse(Buffer.concat(chunks).toString());
      const { sha } = await ghQrGet();
      await ghQrSave(newData, sha);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      console.error('[QR POST]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── FAB DATA: salvataggio/lettura ordini fornitori su GitHub ────
  // ── RESO AI PROMPT ───────────────────────────────────────────
  const GH_RESO_AI_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/reso-ai-prompt.json';
  async function ghResoAIGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: null, sha: null };
    const r = await fetch(GH_RESO_AI_URL, { headers: { 'Authorization': 'token ' + ghToken, 'Accept': 'application/vnd.github.v3+json' } });
    if (r.status === 404) return { data: null, sha: null };
    const j = await r.json();
    return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
  }
  async function ghResoAISave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update reso-ai-prompt', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(GH_RESO_AI_URL, { method: 'PUT', headers: { 'Authorization': 'token ' + ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  if (req.url === '/reso-ai-prompt') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') { res.writeHead(200,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); res.end(); return; }
    if (req.method === 'GET') {
      try { const { data } = await ghResoAIGet(); res.writeHead(200,CORS); res.end(JSON.stringify(data||null)); }
      catch(e) { res.writeHead(200,CORS); res.end(JSON.stringify(null)); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data',c=>chunks.push(c));
      req.on('end', async function(){
        try { const parsed=JSON.parse(Buffer.concat(chunks).toString()); const {sha}=await ghResoAIGet(); await ghResoAISave(parsed,sha); res.writeHead(200,CORS); res.end(JSON.stringify({ok:true})); }
        catch(e) { res.writeHead(500,CORS); res.end(JSON.stringify({ok:false,error:e.message})); }
      }); return;
    }
  }


  // ── AI PROMPT: salvataggio sezioni prompt su GitHub ───────────
  const GH_AIPROMPT_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/ai-prompt.json';

  async function ghAiPromptGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: null, sha: null };
    const r = await fetch(GH_AIPROMPT_URL, {
      headers: { 'Authorization': 'token ' + ghToken, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (r.status === 404) return { data: null, sha: null };
    const j = await r.json();
    const data = JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8'));
    return { data, sha: j.sha };
  }

  async function ghAiPromptSave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update ai-prompt', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(GH_AIPROMPT_URL, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + ghToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  if (req.url === '/ai-prompt') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
      res.end(); return;
    }
    if (req.method === 'GET') {
      try {
        const { data } = await ghAiPromptGet();
        res.writeHead(200, CORS);
        res.end(JSON.stringify(data || null));
      } catch(e) {
        console.error('[AI PROMPT GET]', e.message);
        res.writeHead(200, CORS);
        res.end(JSON.stringify(null));
      }
      return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', function(c){ chunks.push(c); });
      req.on('end', async function(){
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          const { sha } = await ghAiPromptGet();
          await ghAiPromptSave(parsed, sha);
          console.log('[AI PROMPT] Salvato su GitHub: ' + (parsed.sections||[]).length + ' sezioni');
          res.writeHead(200, CORS);
          res.end(JSON.stringify({ok:true}));
        } catch(e) {
          console.error('[AI PROMPT POST]', e.message);
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ok:false,error:e.message}));
        }
      });
      return;
    }
  }


  // ── FAB VENDUTO: salvataggio venduto 7gg su GitHub ───────────────
  const GH_VEND_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/fab-venduto.json';

  async function ghVendGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: {fabSalesCache:{},fabSalesCacheDate:''}, sha: null };
    const r = await fetch(GH_VEND_URL, {
      headers: { 'Authorization': 'token ' + ghToken, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (r.status === 404) return { data: {fabSalesCache:{},fabSalesCacheDate:''}, sha: null };
    const j = await r.json();
    const data = JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8'));
    return { data, sha: j.sha };
  }

  async function ghVendSave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update fab-venduto', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(GH_VEND_URL, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + ghToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  if (req.url === '/fab-venduto') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
      res.end(); return;
    }
    if (req.method === 'GET') {
      try {
        const { data } = await ghVendGet();
        res.writeHead(200, CORS);
        res.end(JSON.stringify(data));
      } catch(e) {
        console.error('[FAB VENDUTO GET]', e.message);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({fabSalesCache:{},fabSalesCacheDate:''}));
      }
      return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', function(c){ chunks.push(c); });
      req.on('end', async function(){
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          const { sha } = await ghVendGet();
          await ghVendSave(parsed, sha);
          const nProd = Object.keys(parsed.fabSalesCache||{}).length;
          console.log('[FAB VENDUTO] Salvato su GitHub: ' + nProd + ' prodotti');
          res.writeHead(200, CORS);
          res.end(JSON.stringify({ok:true,prodotti:nProd}));
        } catch(e) {
          console.error('[FAB VENDUTO POST]', e.message);
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ok:false,error:e.message}));
        }
      });
      return;
    }
  }


  const GH_FAB_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/fab-data.json';

  async function ghFabGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: {fabOrdini:[],fabProducts:null}, sha: null };
    const r = await fetch(GH_FAB_URL, {
      headers: { 'Authorization': 'token ' + ghToken, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (r.status === 404) return { data: {fabOrdini:[],fabProducts:null}, sha: null };
    const j = await r.json();
    const data = JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8'));
    return { data, sha: j.sha };
  }

  async function ghFabSave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update fab-data', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(GH_FAB_URL, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + ghToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  if (req.url === '/fab-data') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
      res.end(); return;
    }
    if (req.method === 'GET') {
      try {
        const { data } = await ghFabGet();
        res.writeHead(200, CORS);
        res.end(JSON.stringify(data));
      } catch(e) {
        console.error('[FAB DATA GET]', e.message);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({fabOrdini:[],fabProducts:null}));
      }
      return;
    }
    if (req.method === 'POST') {
      const fabChunks = [];
      req.on('data', function(c){ fabChunks.push(c); });
      req.on('end', async function(){
        try {
          const parsed = JSON.parse(Buffer.concat(fabChunks).toString());
          const { sha } = await ghFabGet();
          await ghFabSave(parsed, sha);
          console.log('[FAB DATA] Salvato su GitHub: ' + (parsed.fabOrdini||[]).length + ' ordini');
          res.writeHead(200, CORS);
          res.end(JSON.stringify({ok:true,ordini:(parsed.fabOrdini||[]).length}));
        } catch(e) {
          console.error('[FAB DATA POST]', e.message);
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ok:false,error:e.message}));
        }
      });
      return;
    }
  }

  let targetUrl, requestHeaders;

  if (req.url.startsWith("/shopify")) {
    let p = req.url.replace(/^\/shopify/, "");
    // Se la URL contiene page_info, rimuovi tutti gli altri parametri query
    // Shopify non accetta nessun altro parametro insieme a page_info
    if (p.includes('page_info=')) {
      const [path, qs] = p.split('?');
      const params = new URLSearchParams(qs);
      const pageInfo = params.get('page_info');
      p = path + '?page_info=' + pageInfo;
    }
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
        // Inietta _nextPageInfo nel JSON Shopify per supportare paginazione lato client
        const linkHeader = proxyRes.headers["link"] || "";
        const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>; rel="next"/);
        if (nextMatch && proxyRes.statusCode === 200) {
          try {
            const json = JSON.parse(responseBody.toString());
            json._nextPageInfo = nextMatch[1];
            res.end(JSON.stringify(json));
          } catch(e) { res.end(responseBody); }
        } else {
          res.end(responseBody);
        }
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
