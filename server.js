const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3001;
const HD_TOKEN = "OWU2Yzk0NjItMGM4YS00MmQ2LWJjZjMtODEwZGE5MWNmZDk5OnVzLXNvdXRoMTpQeXN0dE1oQzZUZnhvWXRrTS1VTHVORnpLelE=";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const SHOPIFY_SHOP = "40f758-3.myshopify.com";
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";
let SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || "";

console.log("[INIT] ANTHROPIC_KEY presente:", !!ANTHROPIC_KEY);
console.log("[INIT] SHOPIFY_TOKEN presente:", !!SHOPIFY_TOKEN);
console.log("[INIT] SHOPIFY_API_KEY presente:", !!SHOPIFY_API_KEY);
console.log("[INIT] SHOPIFY_API_SECRET presente:", !!SHOPIFY_API_SECRET);

// Verifica HMAC Shopify per sicurezza
function verifyShopifyHmac(query) {
  if (!SHOPIFY_API_SECRET) return true; // skip se secret non configurato
  const { hmac, ...rest } = query;
  const message = Object.keys(rest).sort().map(k => k + "=" + rest[k]).join("&");
  const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(message).digest("hex");
  return digest === hmac;
}

// Parsa query string
function parseQuery(url) {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

// Scambia code con access token via Shopify OAuth
function exchangeCodeForToken(shop, code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code: code
    });
    const options = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request("https://" + shop + "/admin/oauth/access_token", options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Risposta non valida: " + data)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer(async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key, User-Agent");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health" || req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // ── SHOPIFY OAUTH: callback con ?code=... (dopo installazione app)
  if (req.url.startsWith("/shopify/callback") || 
      (req.url.startsWith("/?") && parseQuery(req.url).code && parseQuery(req.url).shop)) {
    const query = parseQuery(req.url);
    const { shop, code, hmac } = query;
    console.log("[OAUTH] Callback ricevuto | shop:", shop, "| code presente:", !!code);

    if (!code || !shop) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>❌ Parametri OAuth mancanti</h2>");
      return;
    }

    try {
      const tokenData = await exchangeCodeForToken(shop, code);
      const newToken = tokenData.access_token;
      if (!newToken) throw new Error("Token non ricevuto: " + JSON.stringify(tokenData));

      // Aggiorna token in memoria per questa sessione
      SHOPIFY_TOKEN = newToken;

      console.log("[OAUTH] ✅ Nuovo token ricevuto:", newToken.substring(0, 12) + "...");

      // Mostra pagina con il token da copiare su Render
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><title>Token Shopify</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:600px;margin:60px auto;padding:20px;background:#f8f9fa}
  .box{background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,.1)}
  h2{color:#2a7a50;margin-bottom:8px}
  .token{background:#f0faf0;border:2px solid #2a7a50;border-radius:8px;padding:16px;font-family:monospace;font-size:14px;word-break:break-all;margin:16px 0}
  .steps{background:#fff8e0;border:1px solid #f0c040;border-radius:8px;padding:16px;font-size:14px;line-height:1.8}
  button{background:#1a73e8;color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-size:14px;margin-top:8px}
  button:hover{background:#1557b0}
  .copied{background:#2a7a50!important}
</style>
</head>
<body>
<div class="box">
  <h2>✅ Token Shopify ottenuto!</h2>
  <p>Copia questo token e aggiornalo su <strong>Render → Environment → SHOPIFY_TOKEN</strong>:</p>
  <div class="token" id="token">${newToken}</div>
  <button onclick="copyToken()">📋 Copia token</button>
  <div class="steps" style="margin-top:24px">
    <strong>Passaggi:</strong><br>
    1. Clicca "Copia token" sopra<br>
    2. Vai su <a href="https://dashboard.render.com" target="_blank">dashboard.render.com</a><br>
    3. Apri <strong>yespresso-proxy</strong> → <strong>Environment</strong><br>
    4. Aggiorna <strong>SHOPIFY_TOKEN</strong> con il valore copiato<br>
    5. Salva — Render farà il redeploy automatico (~1 min)<br>
    6. Torna sull'app e verifica che Shopify funzioni
  </div>
</div>
<script>
function copyToken(){
  const t=document.getElementById("token").textContent;
  navigator.clipboard.writeText(t).then(()=>{
    const btn=document.querySelector("button");
    btn.textContent="✓ Copiato!";btn.className="copied";
    setTimeout(()=>{btn.textContent="📋 Copia token";btn.className="";},3000);
  });
}
</script>
</body></html>`);
    } catch(e) {
      console.error("[OAUTH] Errore scambio token:", e.message);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h2>❌ Errore OAuth</h2><p>${e.message}</p><p>Verifica che SHOPIFY_API_KEY e SHOPIFY_API_SECRET siano configurati su Render.</p>`);
    }
    return;
  }

  // ── SHOPIFY OAUTH: redirect iniziale (quando Shopify manda ?hmac=...&shop=...&timestamp=... senza code)
  if (req.url.startsWith("/?") && parseQuery(req.url).hmac && !parseQuery(req.url).code) {
    const query = parseQuery(req.url);
    const { shop } = query;
    console.log("[OAUTH] Redirect iniziale OAuth | shop:", shop);

    if (!SHOPIFY_API_KEY) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>❌ SHOPIFY_API_KEY non configurata su Render</h2><p>Aggiungi la variabile d'ambiente SHOPIFY_API_KEY su Render.</p>");
      return;
    }

    const scopes = "read_orders,read_customers,read_fulfillments,write_orders";
    const redirectUri = "https://yespresso-proxy.onrender.com/shopify/callback";
    const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    
    console.log("[OAUTH] Redirect a:", authUrl);
    res.writeHead(302, { "Location": authUrl });
    res.end();
    return;
  }

  // ── Serve HTML app
  if (req.url === "/" || req.url === "/index.html" || req.url === "/yespresso-helpdesk.html") {
    const filePath = path.join(__dirname, "yespresso-helpdesk.html");
    fs.readFile(filePath, function(err, data) {
      if (err) { res.writeHead(404); res.end("File non trovato"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  let targetUrl, requestHeaders;

  if (req.url.startsWith("/shopify")) {
    const p = req.url.replace(/^\/shopify/, "");
    targetUrl = "https://" + SHOPIFY_SHOP + "/admin/api/2024-01" + p;
    requestHeaders = {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    };
  } else if (req.url.startsWith("/anthropic")) {
    const p = req.url.replace("/anthropic", "");
    targetUrl = "https://api.anthropic.com" + p;
    requestHeaders = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": ANTHROPIC_KEY || "",
    };
  } else {
    const p = req.url.replace(/^\/api/, "");
    targetUrl = "https://api.helpdesk.com" + p;
    requestHeaders = {
      "Authorization": "Basic " + HD_TOKEN,
      "User-Agent": "Yespresso-Claude-Integration/1.0",
    };
    if (req.headers["content-type"]) {
      requestHeaders["Content-Type"] = req.headers["content-type"];
    } else {
      requestHeaders["Content-Type"] = "application/json";
    }
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
        if (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 201) {
          console.log(responseBody.toString().substring(0, 300));
        }
        const respHeaders = { "Content-Type": proxyRes.headers["content-type"] || "application/json" };
        if (proxyRes.headers["link"]) respHeaders["Link"] = proxyRes.headers["link"];
        if (proxyRes.headers["x-shopify-shop-api-call-limit"]) respHeaders["x-shopify-shop-api-call-limit"] = proxyRes.headers["x-shopify-shop-api-call-limit"];
        res.writeHead(proxyRes.statusCode, respHeaders);
        res.end(responseBody);
      });
    });

    proxyReq.on("error", function(err) {
      console.error("[ERRORE]", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });

    if (bodyBuffer.length > 0) proxyReq.write(bodyBuffer);
    proxyReq.end();
  });
});

server.listen(PORT, "0.0.0.0", function() {
  console.log("✅ Server Yespresso avviato su porta " + PORT);
});
