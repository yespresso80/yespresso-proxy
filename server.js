const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3001;
const HD_TOKEN = "OWU2Yzk0NjItMGM4YS00MmQ2LWJjZjMtODEwZGE5MWNmZDk5OnVzLXNvdXRoMTpQeXN0dE1oQzZUZnhvWXRrTS1VTHVORnpLelE=";
const ANTHROPIC_KEY = "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";

const server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Servi il file HTML
  if (req.url === "/" || req.url === "/index.html" || req.url === "/yespresso-helpdesk.html") {
    const filePath = path.join(__dirname, "yespresso-helpdesk.html");
    fs.readFile(filePath, function(err, data) {
      if (err) {
        res.writeHead(404);
        res.end("File non trovato");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  let targetUrl, requestHeaders;

  if (req.url.startsWith("/anthropic")) {
    const p = req.url.replace("/anthropic", "");
    targetUrl = "https://api.anthropic.com" + p;
    requestHeaders = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": ANTHROPIC_KEY,
    };
  } else {
    const p = req.url.replace(/^\/api/, "");
    targetUrl = "https://api.helpdesk.com" + p;
    requestHeaders = {
      "Authorization": "Basic " + HD_TOKEN,
      "Content-Type": "application/json",
      "User-Agent": "Yespresso-Claude-Integration/1.0",
    };
  }

  console.log("[PROXY] " + req.method + " " + targetUrl);

  let body = "";
  req.on("data", function(chunk) { body += chunk; });
  req.on("end", function() {
    const options = { method: req.method, headers: requestHeaders };

    const proxyReq = https.request(targetUrl, options, function(proxyRes) {
      let responseBody = "";
      proxyRes.on("data", function(chunk) { responseBody += chunk; });
      proxyRes.on("end", function() {
        console.log("[RISPOSTA] " + proxyRes.statusCode);
        if (proxyRes.statusCode !== 200) console.log(responseBody.substring(0, 300));
        res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
        res.end(responseBody);
      });
    });

    proxyReq.on("error", function(err) {
      console.error("[ERRORE]", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, function() {
  console.log("✅ Server Yespresso avviato su porta " + PORT);
});
