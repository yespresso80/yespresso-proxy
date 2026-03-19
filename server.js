// deploy: 1773907616467
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
const CREDITSYARD_KEY = "412b510ba19f72e6eaab40fdf63aa114";

// ── TIKTOK SHOP ──
const TT_APP_KEY = "6jc8vkkup848i";
const TT_APP_SECRET = "ba6c0d8d774802160c443dfa956f9c7607aa95be";
const TT_REDIRECT_URI = "https://yespresso-proxy.onrender.com/tiktok/callback";
const TT_BASE = "https://open-api.tiktokglobalshop.com";
let ttAccessToken = process.env.TT_ACCESS_TOKEN || "";
let ttRefreshToken = process.env.TT_REFRESH_TOKEN || "";
let ttShopId = process.env.TT_SHOP_ID || "";
let ttTokenExpiry = 0;

console.log("[INIT] ANTHROPIC_KEY presente:", !!ANTHROPIC_KEY);
console.log("[INIT] SHOPIFY_TOKEN presente:", !!SHOPIFY_TOKEN);
console.log("[INIT] IMAP_USER:", IMAP_USER);
console.log("[INIT] IMAP_PASSWORD presente:", !!IMAP_PASSWORD);
console.log("[INIT] TT_APP_KEY:", TT_APP_KEY);
console.log("[INIT] TT_ACCESS_TOKEN presente:", !!ttAccessToken);

async function ttSign(appSecret, params) {
  const crypto = require("crypto");
  const sorted = Object.keys(params).filter(k => k !== "sign" && k !== "sign_method").sort();
  let base = "";
  for (const k of sorted) base += k + params[k];
  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(base);
  return hmac.digest("hex").toUpperCase();
}

async function ttApiCall(path, queryParams = {}, method = "GET", body = null) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { app_key: TT_APP_KEY, timestamp: String(timestamp), ...queryParams };
  params.sign = await ttSign(TT_APP_SECRET, params);
  const qs = Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const url = TT_BASE + path + "?" + qs;
  const headers = { "Content-Type": "application/json", "x-tts-access-token": ttAccessToken || "" };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  console.log("[TT API]", method, url.substring(0, 120));
  const r = await fetch(url, opts);
  const text = await r.text();
  console.log("[TT API] status:", r.status, "body:", text.substring(0, 300));
  try { return JSON.parse(text); } catch(e) { return { raw: text, status: r.status }; }
}

async function ttRefreshIfNeeded() {
  if (!ttRefreshToken) return false;
  if (ttAccessToken && ttTokenExpiry > Date.now()) return true;
  try {
    const r = await fetch(`${TT_BASE}/api/v2/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: TT_APP_KEY, app_secret: TT_APP_SECRET, refresh_token: ttRefreshToken, grant_type: "refresh_token" })
    });
    const d = await r.json();
    if (d.data && d.data.access_token) {
      ttAccessToken = d.data.access_token;
      ttRefreshToken = d.data.refresh_token || ttRefreshToken;
      ttTokenExpiry = Date.now() + (d.data.access_token_expire_in || 86400) * 1000 - 60000;
      return true;
    }
    return false;
  } catch(e) { return false; }
}

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
    const client = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASSWORD }, logger: false });
    await client.connect();
    await client.mailboxOpen("INBOX");
    const messages = [];
    for await (const msg of client.fetch("1:*", { envelope: true, bodyStructure: true, uid: true })) { messages.push(msg); }
    console.log("[IMAP] Messaggi trovati:", messages.length);
    for (const msg of messages.slice(-200)) {
      const messageId = msg.envelope?.messageId || String(msg.uid);
      if (attachmentsCache.has(messageId)) continue;
      const fromEmail = msg.envelope?.from?.[0]?.address || "";
      const subject = msg.envelope?.subject || "";
      const date = msg.envelope?.date || new Date();
      const struct = msg.bodyStructure;
      const hasAtt = struct && ((struct.childNodes||[]).some(n => n.disposition === "attachment" || (n.type && !["text","multipart"].includes(n.type))) || (struct.disposition === "attachment"));
      if (!hasAtt) continue;
      try {
        const download = await client.download(String(msg.seq));
        if (!download) continue;
        const rawChunks = [];
        for await (const chunk of download.content) rawChunks.push(chunk);
        const raw = Buffer.concat(rawChunks).toString("binary");
        const attachments = [];
        const boundaryMatches = [...raw.matchAll(/boundary=["']?([^"'\r\n;\s]+)["']?/gi)];
        const boundaries = [...new Set(boundaryMatches.map(m => m[1]))];
        for (const boundary of boundaries) {
          const parts = raw.split(new RegExp("--" + boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          for (const part of parts) {
            const fnMatch = part.match(/(?:filename\*=UTF-8''([^\r\n;]+)|filename="?([^"\r\n;]+)"?)/i);
            const ctMatch = part.match(/Content-Type:\s*([^\r\n;,]+)/i);
            const encMatch = part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
            if (fnMatch && ctMatch) {
              let filename = fnMatch[1] || fnMatch[2] || "";
              try { filename = decodeURIComponent(filename.trim()); } catch(e) { filename = filename.trim(); }
              filename = filename.replace(/['"]/g,"").trim();
              const contentType = ctMatch[1].trim().toLowerCase();
              const encoding = (encMatch ? encMatch[1].trim() : "").toLowerCase();
              if (encoding === "base64" && filename) {
                const bodyIdx = part.indexOf("\r\n\r\n");
                const bodyIdx2 = part.indexOf("\n\n");
                const startIdx = bodyIdx >= 0 ? bodyIdx + 4 : (bodyIdx2 >= 0 ? bodyIdx2 + 2 : -1);
                if (startIdx > 0) {
                  let b64 = part.slice(startIdx).replace(/[^A-Za-z0-9+/=]/g,"");
                  const lastEqIdx = b64.lastIndexOf("=");
                  if (lastEqIdx > 0) b64 = b64.substring(0, lastEqIdx + 1);
                  const rem = b64.replace(/=/g,"").length % 4;
                  if (rem) b64 = b64.replace(/=*$/, "") + "===".substring(0, 4-rem);
                  if (b64.length > 100 && !attachments.find(a => a.filename === filename)) { attachments.push({ filename, contentType, data: b64 }); }
                }
              }
            }
          }
        }
        if (attachments.length > 0) { attachmentsCache.set(messageId, { from: fromEmail, subject, date, attachments }); console.log("[IMAP] Allegati salvati:", fromEmail, "|", subject.substring(0,40), "| n:", attachments.length); }
      } catch(e2) { console.log("[IMAP] Errore msg:", e2.message); }
    }
    await client.logout();
    console.log("[IMAP] Sync OK. Cache:", attachmentsCache.size, "email con allegati");
  } catch(e) { console.error("[IMAP] Errore sync:", e.message); }
}

function findAttachmentsForTicket(requesterEmail, subject) {
  const results = [];
  const EXCLUDE_FILES = ["logo yespresso", "logo_yespresso", "qapla-brt", "qapla_brt", "firma", "signature"];
  const emailLow = (requesterEmail||"").toLowerCase();
  const subjNorm = (subject||"").toLowerCase().replace(/^(re|fwd|fw|r|i):\s*/gi,"").trim();

  const amazonOrderMatch = subjNorm.match(/(\d{3}-\d{7}-\d{7})/);
  const amazonOrderId = amazonOrderMatch ? amazonOrderMatch[1] : null;

  const isAmazon = emailLow.includes("marketplace.amazon") || emailLow.includes("donotreply@amazon") || emailLow.includes("atoz-guarantee");
  const isTemu = emailLow.includes("orders.temu") || emailLow.includes("temu");
  const isTiktok = emailLow.includes("tiktok") || emailLow.includes("scs3.");
  const isBrt = emailLow.includes("vasnoreply@brt") || emailLow.includes("servizioclienti@brt");
  const isMarketplace = isAmazon || isTemu || isTiktok || isBrt;

  for (const [, data] of attachmentsCache) {
    const fromLow = (data.from||"").toLowerCase();
    const dataSubjNorm = (data.subject||"").toLowerCase().replace(/^(re|fwd|fw|r|i):\s*/gi,"").trim();
    // Normalizza \r\n nel subject IMAP (alcuni client mandano subject multiriga)
    const dataSubjClean = dataSubjNorm.replace(/\r?\n\s*/g," ");

    let isMatch = false;

    if (isAmazon && amazonOrderId) {
      // Match SOLO se il numero ordine Amazon e presente nel subject IMAP
      // Cerchiamo sia nella versione originale che in quella pulita (senza \r\n)
      if (dataSubjClean.includes(amazonOrderId) || dataSubjNorm.includes(amazonOrderId)) {
        isMatch = true;
      }
      // Fallback subject SOLO se il ticket NON ha un numero ordine Amazon nel subject
      // (es. cliente risponde con subject completamente diverso tipo "Ho un problema")
      // NON usare il fallback se il ticket HA un numero ordine: evita di matchare
      // ticket diversi con soggetti identici tipo "Articolo danneggiato...(Ordine: xxx)"
      // (il numero ordine diverso e l'unica differenza e viene rimossa nel fallback)
    } else if (isAmazon && !amazonOrderId) {
      // Nessun numero ordine nel subject del ticket: usa fallback su email + subject base
      // Verifica prima che l'email mittente corrisponda (stessa email Amazon anonima)
      const emailMatch = emailLow && fromLow && (fromLow === emailLow || fromLow.includes(emailLow) || emailLow.includes(fromLow));
      if (emailMatch) {
        // Match subject escludendo il numero ordine da entrambi i lati
        const subjBase = subjNorm.replace(/\s*\(ordine[:\s]+[\d-]+\)/gi,"").replace(/\s*\(order[:\s]+[\d-]+\)/gi,"").trim();
        const dataBase = dataSubjClean.replace(/\s*\(ordine[:\s]+[\d-]+\)/gi,"").replace(/\s*\(order[:\s]+[\d-]+\)/gi,"").trim();
        const minLen = Math.min(subjBase.length, dataBase.length, 50);
        if (minLen >= 15 && (dataBase.includes(subjBase.substring(0,minLen)) || subjBase.includes(dataBase.substring(0,minLen)))) {
          isMatch = true;
          console.log("[IMAP] Amazon fallback (no order in subject):", dataSubjNorm.substring(0,70));
        }
      }
    } else if (isMarketplace) {
      const emailMatch = emailLow && fromLow && (fromLow === emailLow || fromLow.includes(emailLow) || emailLow.includes(fromLow));
      const minLen = Math.min(subjNorm.length, dataSubjClean.length, 40);
      const subjMatch = minLen >= 10 && (dataSubjClean.includes(subjNorm.substring(0, minLen)) || subjNorm.includes(dataSubjClean.substring(0, minLen)));
      isMatch = emailMatch && subjMatch;
    } else {
      const emailMatch = emailLow && fromLow && fromLow === emailLow;
      const minLen = Math.min(subjNorm.length, dataSubjClean.length, 30);
      const subjMatch = minLen >= 10 && (dataSubjClean.includes(subjNorm.substring(0, minLen)) || subjNorm.includes(dataSubjClean.substring(0, minLen)));
      isMatch = emailMatch && subjMatch;
    }

    if (isMatch) {
      const filteredAtts = data.attachments.filter(a => { const fn = (a.filename||"").toLowerCase(); return !EXCLUDE_FILES.some(ex => fn.includes(ex)); });
      if (filteredAtts.length > 0) results.push(...filteredAtts.map(a => ({ ...a, from: data.from, date: data.date })));
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

  if (req.url === "/tiktok/auth-url") {
    const state = "yespresso_" + Date.now();
    const authUrl = `https://auth.tiktok-shops.com/oauth/authorize?app_key=${TT_APP_KEY}&redirect_uri=${encodeURIComponent(TT_REDIRECT_URI)}&state=${state}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ auth_url: authUrl, state }));
    return;
  }

  if (req.url.startsWith("/tiktok/callback")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const code = params.get("code") || "";
    const errParam = params.get("error") || "";
    if (errParam) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<h2>❌ Errore TikTok: ${errParam}</h2>`); return; }
    if (!code) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<h2>⚠️ Nessun codice ricevuto</h2><pre>${qs}</pre>`); return; }
    try {
      const tokenRes = await fetch(`${TT_BASE}/api/v2/token/get`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_key: TT_APP_KEY, app_secret: TT_APP_SECRET, auth_code: code, grant_type: "authorized_code" })
      });
      const tokenData = await tokenRes.json();
      if (tokenData.data && tokenData.data.access_token) {
        ttAccessToken = tokenData.data.access_token;
        ttRefreshToken = tokenData.data.refresh_token || "";
        ttTokenExpiry = Date.now() + (tokenData.data.access_token_expire_in || 86400) * 1000 - 60000;
        if (tokenData.data.open_id) ttShopId = tokenData.data.open_id;
        let shopsInfo = "";
        try {
          const shopsRes = await ttApiCall("/authorization/202309/shops", {});
          const shops = shopsRes.data && shopsRes.data.shops ? shopsRes.data.shops : [];
          if (shops.length > 0) { ttShopId = shops[0].cipher || shops[0].id || ttShopId; shopsInfo = `<p>✅ Negozi: ${shops.map(s => s.name || s.id).join(", ")}</p>`; }
        } catch(se) { shopsInfo = `<p>⚠️ Shop list error: ${se.message}</p>`; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>TikTok Auth OK</title></head><body style="font-family:sans-serif;padding:40px;max-width:600px"><h2>✅ TikTok Shop autorizzato!</h2>${shopsInfo}<p><strong>Puoi chiudere questa finestra.</strong></p></body></html>`);
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<h2>❌ Token non ricevuto</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
      }
    } catch(e) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<h2>❌ Errore: ${e.message}</h2>`); }
    return;
  }

  if (req.url === "/tiktok/test") {
    await ttRefreshIfNeeded();
    if (!ttAccessToken) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Non autorizzato" })); return; }
    try {
      const shops = await ttApiCall("/authorization/202309/shops", {});
      const orders = await ttApiCall("/order/202309/orders/search", { shop_cipher: ttShopId }, "POST", { page_size: 5 });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, shops: shops.data, orders_sample: orders.data }));
    } catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url === "/tiktok/status") {
    const authUrl = `https://auth.tiktok-shops.com/oauth/authorize?app_key=${TT_APP_KEY}&redirect_uri=${encodeURIComponent(TT_REDIRECT_URI)}&state=yespresso`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authorized: !!ttAccessToken, shop_id: ttShopId, token_expiry: ttTokenExpiry ? new Date(ttTokenExpiry).toISOString() : null, has_refresh: !!ttRefreshToken, auth_url: authUrl }));
    return;
  }

  if (req.url.startsWith("/tiktok/orders")) {
    await ttRefreshIfNeeded();
    if (!ttAccessToken) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: "Non autorizzato" })); return; }
    try {
      const qs2 = req.url.split("?")[1] || ""; const p2 = new URLSearchParams(qs2); const orderId = p2.get("order_id") || "";
      let data;
      if (orderId) { data = await ttApiCall("/order/202309/orders", { shop_cipher: ttShopId, order_id_list: JSON.stringify([orderId]) }); }
      else { const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch(e) {} data = await ttApiCall("/order/202309/orders/search", { shop_cipher: ttShopId }, "POST", { page_size: 20, ...body }); }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/tiktok/order/")) {
    await ttRefreshIfNeeded();
    if (!ttAccessToken) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: "Non autorizzato" })); return; }
    try { const orderId = req.url.split("/tiktok/order/")[1].split("?")[0]; const data = await ttApiCall("/order/202309/orders", { shop_cipher: ttShopId, order_id_list: JSON.stringify([orderId]) }); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/tiktok/returns")) {
    await ttRefreshIfNeeded(); if (!ttAccessToken) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: "Non autorizzato" })); return; }
    try { const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch(e) {} const data = await ttApiCall("/return_refund/202309/returns/search", { shop_cipher: ttShopId }, "POST", { page_size: 20, ...body }); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/tiktok/return/approve")) {
    await ttRefreshIfNeeded(); if (!ttAccessToken) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: "Non autorizzato" })); return; }
    try { const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch(e) {} const data = await ttApiCall("/return_refund/202309/returns/approve", { shop_cipher: ttShopId }, "POST", body); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/tiktok/return/reject")) {
    await ttRefreshIfNeeded(); if (!ttAccessToken) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: "Non autorizzato" })); return; }
    try { const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch(e) {} const data = await ttApiCall("/return_refund/202309/returns/reject", { shop_cipher: ttShopId }, "POST", body); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/tiktok/refunds")) {
    await ttRefreshIfNeeded(); if (!ttAccessToken) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: "Non autorizzato" })); return; }
    try { const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch(e) {} const data = await ttApiCall("/return_refund/202309/refunds/search", { shop_cipher: ttShopId }, "POST", { page_size: 20, ...body }); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/tiktok/refund/approve")) {
    await ttRefreshIfNeeded(); if (!ttAccessToken) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: "Non autorizzato" })); return; }
    try { const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch(e) {} const data = await ttApiCall("/return_refund/202309/refunds/approve", { shop_cipher: ttShopId }, "POST", body); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/tiktok/products")) {
    await ttRefreshIfNeeded(); if (!ttAccessToken) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: "Non autorizzato" })); return; }
    try { const data = await ttApiCall("/product/202309/products/search", { shop_cipher: ttShopId }, "POST", { page_size: 20 }); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // ── IMAP routes ──
  if (req.url.startsWith("/imap/attachments")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const email = params.get("email") || "";
    const subject = params.get("subject") || "";
    await syncImapAttachments();
    const attachments = findAttachmentsForTicket(email, subject);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ attachments, cached: attachmentsCache.size }));
    return;
  }

  if (req.url.startsWith("/imap/debug")) {
    await syncImapAttachments();
    const qsD = req.url.split("?")[1] || "";
    const pD = new URLSearchParams(qsD);
    const search = (pD.get("search") || "").toLowerCase();
    const list = [];
    for (const [, data] of attachmentsCache) {
      if (!search || data.subject.toLowerCase().includes(search) || data.from.toLowerCase().includes(search)) {
        list.push({ from: data.from, subject: data.subject, date: data.date, files: data.attachments.map(a => a.filename) });
      }
    }
    list.sort((a,b) => new Date(b.date||0) - new Date(a.date||0));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ total: attachmentsCache.size, results: list.slice(0,100) }));
    return;
  }

  if (req.url === "/imap/sync") {
    lastImapSync = 0;
    syncImapAttachments().catch(e => console.error(e));
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "sync avviato", cached: attachmentsCache.size }));
    return;
  }

  if (req.url === "/" || req.url === "/index.html" || req.url === "/yespresso-helpdesk.html") {
    const filePath = path.join(__dirname, "yespresso-helpdesk.html");
    fs.readFile(filePath, function(err, data) {
      if (err) { res.writeHead(404); res.end("File non trovato"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(data);
    });
    return;
  }

  if (req.url.startsWith("/shopify/callback")) { res.writeHead(200); res.end("OK"); return; }

const BRT_USER = "1791201";
const BRT_PASS = "Dus0549dsb";
const BRT_SFTP_HOST = "sftp.brt.it";
const BRT_SFTP_PORT = 22;
const BRT_SFTP_USER = "1791201";
const BRT_SFTP_PASS = "qyo^G16^H3";
const BRT_SFTP_PATH = "/OUT";
const BRT_REST_BASE = "https://api.brt.it/rest/v1";
const BRT_TRACKING_BASE = "https://api.brt.it/rest/v1/tracking";
const BRT_AUTH = "Basic " + Buffer.from(BRT_USER + ":" + BRT_PASS).toString("base64");
const BRT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

async function brtRestGet(p, useTrackingBase) {
  const base = useTrackingBase ? BRT_TRACKING_BASE : BRT_REST_BASE;
  const r = await fetch(base + p, { headers: { "Authorization": BRT_AUTH, "Accept": "application/json", "Content-Type": "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new Error("BRT " + r.status + ": " + text.substring(0, 100));
  try { return JSON.parse(text); } catch(e) { return text; }
}

async function brtRestPost(p, body, useTrackingBase) {
  const base = useTrackingBase ? BRT_TRACKING_BASE : BRT_REST_BASE;
  const r = await fetch(base + p, { method: "POST", headers: { "Authorization": BRT_AUTH, "Accept": "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error("BRT " + r.status + ": " + text.substring(0, 200));
  try { return JSON.parse(text); } catch(e) { return text; }
}

  if (req.url.startsWith("/brt/test")) {
    try { const qs = req.url.split("?")[1] || ""; const params = new URLSearchParams(qs); const testId = params.get("id") || "179010735604"; const data = await brtRestGet("/parcelID/" + testId, true); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, data })); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/brt/check-fermopoint")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const nspediz = params.get("nspediz") || "";
    if (!nspediz) { res.writeHead(400); res.end(JSON.stringify({ error: "nspediz required" })); return; }
    try {
      const vasUrl = "https://vas.brt.it/vas/sped_det_show.hsm?referer=sped_numspe_par.htm&Nspediz=" + encodeURIComponent(nspediz);
      const pageRes = await fetch(vasUrl, { headers: { "User-Agent": BRT_UA, "Accept": "text/html" } });
      const pageHtml = await pageRes.text();
      const pageLow = pageHtml.toLowerCase();
      const hasArrivataBRT = pageLow.includes("arrivata al brt-fermopoint");
      const hasRitiroDisponibile = pageLow.includes("ritiro disponibile");
      const hasInAttesaRitiro = pageLow.includes("in attesa di ritiro");
      const hasDisponibileAlRitiro = pageLow.includes("disponibile al brt-fermopoint");
      const hasConsegnatoAMani = pageLow.includes("consegnato a mani");
      const hasConsegnatoDestinatario = pageLow.includes("consegnato al destinatario");
      const hasFirmatario = pageLow.includes("firmatario") && (pageLow.includes("firma:") || pageLow.includes("firmato da"));
      const hasDataConsegnaEffettiva = /consegn[ao][^<]{0,50}\d{2}[\/.\-]\d{2}[\/.\-]\d{4}/i.test(pageHtml);
      const atFermopoint = (hasArrivataBRT || hasRitiroDisponibile || hasInAttesaRitiro || hasDisponibileAlRitiro)
                        && !hasConsegnatoAMani && !hasConsegnatoDestinatario && !hasFirmatario && !hasDataConsegnaEffettiva;
      const scadMatch = pageHtml.match(/fino al\s*([\d.\/-]+)/i) || pageHtml.match(/ritiro disponibile[^<]{0,60}(\d{2}[\/.\-]\d{2}[\/.\-]\d{4})/i);
      const scadenza = scadMatch ? scadMatch[1].trim() : "";
      let puntoInfo = "";
      if (atFermopoint) {
        const rows = [...pageHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
        for (const row of rows) {
          if (row[1].toLowerCase().includes("fermopoint") || row[1].toLowerCase().includes("punto di ritiro")) {
            const cells = [...row[1].matchAll(/<td[^>]*>([^<]{5,100})<\/td>/gi)];
            const vals = cells.map(c => c[1].trim()).filter(v => v.length > 5 && !/^[\s<>]+$/.test(v));
            if (vals.length > 0) { puntoInfo = vals.join(" - "); break; }
          }
        }
      }
      console.log("[BRT fermopoint] nspediz:", nspediz, "| arrivataBRT:", hasArrivataBRT, "| ritiroDisp:", hasRitiroDisponibile, "| RESULT:", atFermopoint);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, at_fermopoint: atFermopoint, scadenza_ritiro: scadenza, punto_info: puntoInfo }));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, at_fermopoint: false, error: e.message }));
    }
    return;
  }

  if (req.url.startsWith("/brt/track")) {
    const qs = req.url.split("?")[1] || ""; const params = new URLSearchParams(qs); const nspediz = params.get("nspediz") || "";
    if (!nspediz) { res.writeHead(400); res.end(JSON.stringify({ error: "nspediz required" })); return; }
    try {
      const data = await brtRestGet("/parcelID/" + encodeURIComponent(nspediz), true);
      const result = data.ttParcelIdResponse || data; const spedizione = result.spedizione || {}; const datiConsegna = spedizione.dati_consegna || {};
      const delivered = !!(datiConsegna.data_consegna_merce && datiConsegna.data_consegna_merce.trim());
      const eventi = (spedizione.eventi && spedizione.eventi.evento) || [];
      const ultimoEvento = Array.isArray(eventi) ? eventi[eventi.length-1] : eventi;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered, data_consegna: datiConsegna.data_consegna_merce||"", firmatario: datiConsegna.firmatario_consegna||"", luogo_consegna: datiConsegna.luogo_consegna||"", indirizzo_consegna: datiConsegna.indirizzo_consegna||"", ultimo_evento: ultimoEvento, raw: data }));
    } catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/brt/pod-image")) {
    const qs = req.url.split("?")[1] || ""; const params = new URLSearchParams(qs); const imgUrl = params.get("url") || "";
    if (!imgUrl || !imgUrl.startsWith("https://vas.brt.it/")) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "url non valido" })); return; }
    try {
      const imgRes = await fetch(imgUrl, { headers: { "User-Agent": BRT_UA, "Referer": "https://vas.brt.it/vas/SPED_DET_SHOW_LDV.HTM" } });
      if (!imgRes.ok) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Download fallito: " + imgRes.status })); return; }
      const ct = imgRes.headers.get("content-type") || "image/jpeg";
      const buf = await imgRes.arrayBuffer(); const b64 = Buffer.from(buf).toString("base64");
      const mime = ct.includes("png") ? "image/png" : ct.includes("pdf") ? "application/pdf" : "image/jpeg";
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, mime, data: b64 }));
    } catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/brt/pod-capture")) {
    const qs = req.url.split("?")[1] || ""; const params = new URLSearchParams(qs); const tnPod = params.get("tnPod") || "";
    if (!tnPod) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "tnPod required" })); return; }
    const podPageUrl = "https://vas.brt.it/vas/SPED_DET_SHOW_LDV.HTM?SpedizioneImmagineLDV=" + encodeURIComponent(tnPod) + "&PODChkCde=348365243";
    try {
      const pageRes = await fetch(podPageUrl, { headers: { "User-Agent": BRT_UA, "Accept": "text/html,*/*", "Referer": "https://vas.brt.it/vas/sped_numspe_par.htm" } });
      const pageHtml = await pageRes.text();
      const imgPatterns = [ /src=["']([^"']*\.(?:jpg|jpeg|png|gif))['"]/gi, /src=["']([^"']*(?:pod|firma|ldv|immagine|spediz)[^"']*)['"]/gi, /src=["'](\/vas\/[^"']+)['"]/gi ];
      let imgSrc = null;
      for (const pat of imgPatterns) { pat.lastIndex = 0; const m = pat.exec(pageHtml); if (m) { imgSrc = m[1]; break; } }
      if (!imgSrc) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Immagine POD non trovata" })); return; }
      if (!imgSrc.startsWith("http")) imgSrc = "https://vas.brt.it" + (imgSrc.startsWith("/") ? "" : "/") + imgSrc;
      const imgRes = await fetch(imgSrc, { headers: { "User-Agent": BRT_UA, "Referer": podPageUrl } });
      if (!imgRes.ok) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Download immagine fallito: " + imgRes.status })); return; }
      const ct = imgRes.headers.get("content-type") || "image/jpeg";
      const buf = await imgRes.arrayBuffer(); const b64 = Buffer.from(buf).toString("base64");
      const mime = ct.includes("png") ? "image/png" : ct.includes("pdf") ? "application/pdf" : "image/jpeg";
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, mime, data: b64, tnPod, podUrl: podPageUrl }));
    } catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/brt/pod-auto")) {
    const qs = req.url.split("?")[1] || ""; const params = new URLSearchParams(qs); const nspediz = params.get("nspediz") || "";
    if (!nspediz) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "nspediz required" })); return; }
    try {
      const pubRes = await fetch("https://vas.brt.it/vas/sped_numspe_par.htm", { headers: { "User-Agent": BRT_UA, "Accept": "text/html" } });
      const pubHtml = await pubRes.text();
      const sessionMatch = pubHtml.match(/name="IDSESSIONE"[^>]*value="([^"]+)"/i) || pubHtml.match(/value="([^"]+)"[^>]*name="IDSESSIONE"/i);
      const idsessione = sessionMatch ? sessionMatch[1] : "";
      const pubCookies = (pubRes.headers.get("set-cookie") || "").split(/,(?=[^ ])/).map(c=>c.split(";")[0].trim()).filter(Boolean).join("; ");
      const detUrl = "https://vas.brt.it/vas/sped_det_show.hsm?referer=sped_numspe_par.htm&Nspediz=" + encodeURIComponent(nspediz) + (idsessione ? "&IDSESSIONE=" + encodeURIComponent(idsessione) : "");
      const detRes = await fetch(detUrl, { headers: { "User-Agent": BRT_UA, "Cookie": pubCookies, "Accept": "text/html", "Referer": "https://vas.brt.it/vas/sped_numspe_par.htm" } });
      const detHtml = await detRes.text();
      const detCookies = [pubCookies, (detRes.headers.get("set-cookie")||"").split(/,(?=[^ ])/).map(c=>c.split(";")[0].trim()).filter(Boolean).join("; ")].filter(Boolean).join("; ");
      const chkMatch = detHtml.match(/name="PODChkCde"[^>]*value="([^"]+)"/i) || detHtml.match(/value="([^"]+)"[^>]*name="PODChkCde"/i);
      const spedMatch = detHtml.match(/name="SpedizioneImmagineLDV"[^>]*value="([^"]+)"/i) || detHtml.match(/value="([^"]+)"[^>]*name="SpedizioneImmagineLDV"/i);
      const addMatch = detHtml.match(/name="AddebitoImmagineLDV"[^>]*value="([^"]+)"/i) || detHtml.match(/value="([^"]+)"[^>]*name="AddebitoImmagineLDV"/i);
      const dateMatch = detHtml.match(/name="DataFineGratisLDV"[^>]*value="([^"]+)"/i) || detHtml.match(/value="([^"]+)"[^>]*name="DataFineGratisLDV"/i);
      if (!chkMatch || !spedMatch) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "POD non disponibile" })); return; }
      const podBody = "SpedizioneImmagineLDV=" + encodeURIComponent(spedMatch[1]) + "&AddebitoImmagineLDV=" + encodeURIComponent(addMatch?addMatch[1]:"1") + "&DataFineGratisLDV=" + encodeURIComponent(dateMatch?dateMatch[1]:"01.01.0001") + "&PODChkCde=" + encodeURIComponent(chkMatch[1]) + "&PODImage=P.O.D.+image";
      const podRes = await fetch("https://vas.brt.it/vas/conferma_pod_image.htm", { method: "POST", headers: { "User-Agent": BRT_UA, "Cookie": detCookies, "Content-Type": "application/x-www-form-urlencoded", "Referer": detUrl, "Accept": "image/*, text/html, */*" }, body: podBody });
      const ct = podRes.headers.get("content-type") || "";
      if (ct.includes("image") || ct.includes("pdf")) {
        const buf = await podRes.arrayBuffer(); const b64 = Buffer.from(buf).toString("base64");
        const mime = ct.includes("png") ? "image/png" : ct.includes("pdf") ? "application/pdf" : "image/jpeg";
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, mime, data: b64, nspediz }));
      } else {
        const podHtml = await podRes.text();
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Risposta non immagine", ct, html_sample: podHtml.substring(0, 500) }));
      }
    } catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/brt/giacenze")) {
    try { const data = await brtRestGet("/shipment/storage/list", false); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, data })); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/brt/svincola")) {
    const chunks3 = []; req.on("data", c => chunks3.push(c)); await new Promise(r => req.on("end", r));
    const body3 = JSON.parse(Buffer.concat(chunks3).toString() || "{}");
    try { const data = await brtRestPost("/shipment/storage/release", body3, false); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, data })); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/brt/ritiro")) {
    const chunks4 = []; req.on("data", c => chunks4.push(c)); await new Promise(r => req.on("end", r));
    const body4 = JSON.parse(Buffer.concat(chunks4).toString() || "{}");
    try { const data = await brtRestPost("/pickup/create", body4, false); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, data })); }
    catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/shopify-graphql")) {
    const token = await getShopifyToken();
    const chunks2 = []; req.on("data", c => chunks2.push(c)); await new Promise(r => req.on("end", r));
    const body2 = Buffer.concat(chunks2).toString();
    const gqlRes = await fetch("https://" + SHOPIFY_SHOP + "/admin/api/2024-01/graphql.json", { method: "POST", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }, body: body2 });
    const gqlData = await gqlRes.text();
    res.writeHead(gqlRes.status, { "Content-Type": "application/json" }); res.end(gqlData);
    return;
  }

  if (req.url.startsWith("/brt/sftp-giacenze")) {
    if (!SftpClient) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "ssh2-sftp-client non installato" })); return; }
    const sftp = new SftpClient();
    try {
      await sftp.connect({ host: BRT_SFTP_HOST, port: BRT_SFTP_PORT, username: BRT_SFTP_USER, password: BRT_SFTP_PASS, readyTimeout: 10000, retries: 1 });
      const fileList = await sftp.list(BRT_SFTP_PATH);
      const files = fileList.filter(f => f.type === "-").sort((a,b) => b.modifyTime - a.modifyTime).slice(0, 5);
      const results = [];
      for (const file of files) {
        try { const content = await sftp.get(BRT_SFTP_PATH + "/" + file.name); results.push({ name: file.name, size: file.size, date: new Date(file.modifyTime).toISOString(), content: content.toString("utf8").substring(0, 5000) }); }
        catch(fe) { results.push({ name: file.name, error: fe.message }); }
      }
      await sftp.end();
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, files: results }));
    } catch(e) { try { await sftp.end(); } catch(ee) {} res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.url.startsWith("/creditsyard/customer")) {
    const qs = req.url.split("?")[1] || ""; const params = new URLSearchParams(qs); const email = params.get("email") || "";
    if (!email) { res.writeHead(400); res.end(JSON.stringify({ error: "email required" })); return; }
    try {
      const csRes = await fetch("https://creditsyard.com/api/common/customers/get", { method: "POST", headers: { "X-Shop-Api-Key": CREDITSYARD_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ customer_email: email }) });
      const text = await csRes.text(); let customer = {}; try { customer = JSON.parse(text); } catch(pe) {}
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(customer));
    } catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.url.startsWith("/creditsyard/adjust")) {
    const chunks5 = []; req.on("data", c => chunks5.push(c)); await new Promise(r => req.on("end", r));
    let body5 = {}; try { body5 = JSON.parse(Buffer.concat(chunks5).toString() || "{}"); } catch(e) {}
    const { customer_email, customer_id, amount, reason, send_email_notification } = body5;
    if (!customer_email || !amount) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "customer_email e amount obbligatori" })); return; }
    try {
      const payload = { customer_email, amount };
      if (customer_id) payload.customer_id = customer_id;
      if (reason) payload.reason = reason;
      payload.send_email_notification = send_email_notification || 0;
      const csRes = await fetch("https://creditsyard.com/api/common/credits/adjust", { method: "POST", headers: { "X-Shop-Api-Key": CREDITSYARD_KEY, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const text = await csRes.text(); let result = {}; try { result = JSON.parse(text); } catch(pe) {}
      res.writeHead(csRes.ok ? 200 : csRes.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
    } catch(e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  let targetUrl, requestHeaders;
  if (req.url.startsWith("/shopify")) {
    const p = req.url.replace(/^\/shopify/, ""); const token = await getShopifyToken();
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
        res.writeHead(proxyRes.statusCode, respHeaders); res.end(responseBody);
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
