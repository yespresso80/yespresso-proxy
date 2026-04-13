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


const HD_BASE_URL = "https://api.helpdesk.com/v1";

// ══════════════════════════════════════════════════════
// AUTO-RISPOSTA SERVER-SIDE — gira ogni 60s anche a PC spento
// ══════════════════════════════════════════════════════
const AUTO_REPLY_INTERVAL = 60 * 1000;
const _serverAutoProcessed = {}; // {tid: isoTimestamp ultima risposta}
const _serverAutoBlocked = new Set(); // ticket bloccati (cliente insoddisfatto)
const _serverNeedsAction = new Set(); // ticket che richiedono azione manuale

async function hdGet(path) {
  const r = await fetch(HD_BASE_URL + path, {
    headers: { 'Authorization': 'Basic ' + HD_TOKEN, 'User-Agent': 'Yespresso/1.0' }
  });
  return r.json();
}
async function hdPatch(path, body) {
  return fetch(HD_BASE_URL + path, {
    method: 'PATCH',
    headers: { 'Authorization': 'Basic ' + HD_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'Yespresso/1.0' },
    body: JSON.stringify(body)
  });
}
async function hdPut(path, body) {
  return fetch(HD_BASE_URL + path, {
    method: 'PUT',
    headers: { 'Authorization': 'Basic ' + HD_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'Yespresso/1.0' },
    body: JSON.stringify(body)
  });
}
async function shopifyGet(path) {
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/${path}`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  return r.json();
}

function serverNeedsManualAction(text) {
  const t = text || '';
  const keywords = [
    'rimborso','rimborseremo','rimborsiamo','emettere un rimborso',
    'provvederemo.*rimborso','procederemo.*rimborso','abbiamo.*rimborsato',
    'rimborso.*è stato','accredito.*verrà','accrediteremo','abbiamo accreditato',
    'procediamo.*accredito','procediamo.*rimborso','procediamo.*credito','procediamo immediatamente',
    'invieremo.*credito','abbiamo inviato.*credito','credito.*è stato inviato',
    'invieremo.*credito','abbiamo inviato.*credito','credito.*è stato inviato',
    // annullamento sito gestito automaticamente — rimane solo per marketplace
    'rispediremo','provvederemo.*rispedire','nuova spedizione.*partirà',
    'sostituiremo','provvederemo.*sostituzione',
    'modifica.*indirizzo','cambio.*indirizzo','aggiorneremo.*indirizzo',
    'comunicher.*corriere','comunicare.*corriere','contatter.*brt',
    'sbloccare.*spedizione','rimessa in consegna','provveder.*brt',
    'disposizioni.*corriere','avvis.*corriere',
    'prenotiamo il ritiro','organizziamo il ritiro',
  ];
  return keywords.some(k => new RegExp(k, 'i').test(t));
}

function serverClienteInsoddisfatto(text) {
  const t = (text || '').toLowerCase();
  const segnali = [
    'non è quello che volevo','non mi ha risposto','risposta inutile',
    'non avete capito','non capite','stessa risposta','risposta automatica',
    'voglio parlare con','voglio un umano','operatore','responsabile',
    'assurdo','vergogna','pessimo','schifo','scandaloso','inaccettabile',
    'mai più','denuncia','ancora lo stesso problema','problema persiste',
    'non è risolto','non avete risolto','ancora non funziona',
    'ho già spiegato','vi ho già detto','ennesima volta',
  ];
  return segnali.some(s => t.includes(s));
}

function serverIsSpam(ticket) {
  const email = ((ticket.requester && ticket.requester.email) || '').toLowerCase();
  const subject = (ticket.subject || '').toLowerCase();
  // Marketplace non è mai spam
  if (subject.includes('amazon') || subject.includes('temu') || subject.includes('tiktok') ||
      email.includes('marketplace.amazon') || email.includes('orders.temu')) return false;
  const spamPat = ['noreply','no-reply','donotreply','newsletter','promo','marketing',
    'bulk','mailer-daemon','postmaster','bounce','daemon','robot','automat'];
  if (spamPat.some(p => email.includes(p))) return true;
  const localPart = email.split('@')[0] || '';
  const numCount = (localPart.match(/\d/g) || []).length;
  if (localPart.length > 15 && numCount > 8) return true;
  return false;
}

const NO_AI_SERVER = ['vasnoreply@brt.it','servizioclienti@brt.it','assistenza@paypal.it','seller@orders.temu.com'];
const AUTO_REPLY_TEST_MODE = false; // 🧪 TEST: risponde solo a commerciale@yespresso.it — rimuovere dopo i test
const AUTO_REPLY_TEST_EMAIL = 'commerciale@yespresso.it';
function serverIsNoAi(email) {
  if (AUTO_REPLY_TEST_MODE && email !== AUTO_REPLY_TEST_EMAIL) return true; // blocca tutto tranne l'email di test
  return NO_AI_SERVER.some(e => email.includes(e));
}

// Verifica se un ordine sito è annullabile in base all'orario e giorno
function serverCanCancelOrder(order) {
  if (!order || !order.created_at) return false;
  if (order.cancelled_at) return false; // già annullato
  if (order.fulfillment_status && order.fulfillment_status !== 'unfulfilled') return false; // già in lavorazione

  const created = new Date(order.created_at);
  const now = new Date();

  // Helper: è giorno lavorativo (lun-ven)?
  function isWorkday(d) { const day = d.getDay(); return day >= 1 && day <= 5; }
  // Helper: prossimo giorno lavorativo alle 9:00
  function nextWorkdayAt9(d) {
    const next = new Date(d); next.setHours(0,0,0,0); next.setDate(next.getDate()+1);
    while (!isWorkday(next)) next.setDate(next.getDate()+1);
    next.setHours(9,0,0,0); return next;
  }

  const createdHour = created.getHours() + created.getMinutes()/60;
  const createdDay = created.getDay(); // 0=dom, 1=lun, ..., 5=ven, 6=sab
  const isCreatedWorkday = isWorkday(created);

  let deadline = null;

  if (!isCreatedWorkday) {
    // Weekend o festivo → annullabile entro le 9 del prossimo lun/giorno lavorativo
    deadline = nextWorkdayAt9(created);
    // Se venerdì dalle 16:46+ → stesso lunedì
    if (createdDay === 5 && createdHour >= 16.767) {
      deadline = nextWorkdayAt9(created);
    }
  } else {
    // Giorno lavorativo
    if (createdHour <= 9.0) {
      // 00:01-09:00 → entro le 9:00 stesso giorno
      deadline = new Date(created); deadline.setHours(9,0,0,0);
    } else if (createdHour <= 16.0) {
      // 09:01-16:00 → entro 1 ora dalla creazione e comunque entro le 16:15
      const oneHourLater = new Date(created.getTime() + 60*60*1000);
      const cutoff = new Date(created); cutoff.setHours(16,15,0,0);
      deadline = oneHourLater < cutoff ? oneHourLater : cutoff;
    } else if (createdHour <= 16.75) {
      // 16:01-16:45 → NON annullabile
      return false;
    } else {
      // 16:46-23:59 → entro le 9 del giorno lavorativo successivo
      deadline = nextWorkdayAt9(created);
    }
  }

  return deadline && now <= deadline;
}

// Verifica se un ticket riguarda richiesta annullamento sito
function serverIsAnnullamentoSito(subject, events) {
  const subj = (subject||'').toLowerCase();
  if (!subj.includes('annull')) {
    // Cerca nel testo degli eventi
    const lastMsgs = (events||[]).slice(-3).map(ev =>
      ((ev.message&&(ev.message.text||ev.message.richTextHtml))||ev.text||'').toLowerCase()
    ).join(' ');
    if (!lastMsgs.includes('annull')) return false;
  }
  return true;
}

async function serverAutoReplyWorker(processAll) {
  if (!HD_TOKEN || !ANTHROPIC_KEY) return;
  let settings = {};
  try { const fd = await ghFilippoGet(); settings = fd.data || {}; } catch(e) {}

  const wasOff = serverAutoReplyWorker._lastEnabled === false;
  const isNowOn = !!settings.autoReplyEnabled;
  serverAutoReplyWorker._lastEnabled = isNowOn;
  if (!isNowOn) return;

  const shouldProcessAll = processAll || wasOff;
  console.log('[AUTO-REPLY-SERVER] Start worker... processAll='+shouldProcessAll);

  try {
    const pages = await Promise.all([1,2,3].map(p =>
      hdGet(`/tickets?pageSize=50&page=${p}&status=open&sortBy=lastMessageAt&order=desc`).catch(() => [])
    ));
    const allOpen = pages.flat().filter(t => t && (t.ID || t.id));

    for (const ticket of allOpen) {
      const tid = String(ticket.ID || ticket.id);
      if (_serverAutoBlocked.has(tid)) continue;
      const email = ((ticket.requester && ticket.requester.email) || '').toLowerCase();
      if (serverIsNoAi(email) || serverIsSpam(ticket)) continue;

      if (!shouldProcessAll && _serverAutoProcessed[tid]) {
        const lastMsg = ticket.lastMessageAt || ticket.updatedAt || '';
        if (!lastMsg || new Date(lastMsg) <= new Date(_serverAutoProcessed[tid])) continue;
      }

      _serverAutoProcessed[tid] = new Date().toISOString();

      try {
        const full = await hdGet(`/tickets/${tid}`);
        if (!full || (full.status && full.status !== 'open')) continue;

        const events = (full.events || []).sort((a,b) => new Date(a.createdAt||0)-new Date(b.createdAt||0));

        // Controlla insoddisfazione
        if (events.length) {
          const prevTime = new Date(_serverAutoProcessed[tid]);
          for (let i = events.length-1; i >= 0; i--) {
            const ev = events[i];
            const isClient = !ev.actor || ev.actor.type==='contact' || ev.actor.type==='customer';
            if (isClient && new Date(ev.createdAt||0) < prevTime) {
              const txt = ((ev.message&&(ev.message.text||ev.message.richTextHtml))||ev.text||'').replace(/<[^>]+>/g,' ').trim();
              if (serverClienteInsoddisfatto(txt)) {
                _serverAutoBlocked.add(tid); _serverNeedsAction.add(tid); delete _serverAutoProcessed[tid];
              }
              break;
            }
          }
          if (_serverAutoBlocked.has(tid)) continue;
        }

        // ══ CONTROLLO FONDAMENTALE: l'ultimo messaggio è del cliente? ══
        // Se l'ultimo messaggio è nostro (agente), non rispondere
        const sortedEvs = (full.events||[]).filter(ev => ev.message && (
          (ev.message.text && ev.message.text.trim()) ||
          (ev.message.richTextHtml && ev.message.richTextHtml.trim())
        )).sort((a,b) => new Date(a.createdAt||0)-new Date(b.createdAt||0));

        if (!sortedEvs.length) continue; // nessun messaggio

        const lastEv = sortedEvs[sortedEvs.length-1];
        const lastIsAgent = lastEv.actor && (lastEv.actor.type === 'agent' || lastEv.actor.type === 'member');
        if (lastIsAgent) {
          console.log(`[AUTO-REPLY-SERVER] Ticket ${tid} — ultimo msg è agente, skip`);
          _serverAutoProcessed[tid] = new Date().toISOString();
          continue;
        }

        // Cerca ordine Shopify
        const subj = full.subject || '';
        let order = null;
        try {
          const amzM = subj.match(/\d{3}-\d{7}-\d{7}/);
          const shopM = subj.match(/#?(\d{8,13})/);
          const temuM = subj.match(/PO-\d+-\d+/i);
          let oQ = null;
          if (amzM) oQ = 'query='+encodeURIComponent(amzM[0]);
          else if (temuM) oQ = 'query='+encodeURIComponent(temuM[0]);
          else if (shopM) oQ = 'name=%23'+shopM[1];
          else if (email && !email.includes('marketplace') && !email.includes('temu') && !email.includes('amazon'))
            oQ = 'email='+encodeURIComponent(email);
          if (oQ) {
            const od = await shopifyGet(`orders.json?status=any&limit=3&${oQ}`).catch(()=>null);
            if (od && od.orders && od.orders.length) order = od.orders[0];
          }
        } catch(e) {}

        // Stato spedizione critico
        if (order) {
          const fship = (order.fulfillments||[]).slice(-1)[0];
          const shipSt = fship && fship.shipment_status;
          if (['ready_for_pickup','failure','attempted_delivery'].includes(shipSt)) { _serverNeedsAction.add(tid); continue; }
        }

        // Costruisci thread
        let fullThread = '';
        events.forEach(ev => {
          const txt = ((ev.message&&(ev.message.text||ev.message.richTextHtml))||ev.text||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,600);
          if (!txt) return;
          const who = ev.actor ? (ev.actor.name||ev.actor.email||'Agente') : 'Cliente';
          fullThread += who+': '+txt+'\n';
        });

        // ══ STEP 1: CLASSIFICAZIONE ══
        const classifyMsg = `Analizza questo ticket e classifica il tipo di richiesta.

Oggetto: ${subj}
Storico:
${fullThread}

Rispondi SOLO con JSON esatto, nessun testo aggiuntivo:
{"categoria": "CATEGORIA", "motivo": "breve spiegazione"}

CATEGORIE — scegli la prima che corrisponde:

SOLO_INFO → se il ticket riguarda ESCLUSIVAMENTE informazioni senza problemi da risolvere:
- Dove è il mio ordine / tracking / stato spedizione / quando arriva
- Ordine non ancora spedito (quando viene spedito)
- Info prodotti, compatibilità capsule, orari, info aziendali
- Conferma di ricezione ordine

GESTIBILE_AUTO → se c'è un problema specifico gestibile:
- Capsule danneggiate, rotte, di qualità inferiore (anche se chiede rimborso)
- Problema tecnico con capsule o macchina
- Capsule sbagliate acquistate per errore (acquisto errato)
- Annullamento ordine sito (non Amazon/Temu/TikTok)
- Prodotto sbagliato ricevuto per errore di spedizione

AZIONE_MANUALE → SOLO se:
- Cliente espressamente insoddisfatto di una risposta già ricevuta da noi
- Richiesta di rimborso o credito monetario esplicita senza problema dichiarato

IMPORTANTE: "Dov'è il mio ordine", "quando arriva", "non ho ricevuto nulla" → SEMPRE SOLO_INFO.
In caso di dubbio usa SEMPRE AZIONE_MANUALE.\``;

        const classRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 100, system: 'Sei un classificatore di ticket. Rispondi SOLO con JSON valido.', messages: [{ role: 'user', content: classifyMsg }] })
        });
        const classData = await classRes.json();
        const classText = (classData.content && classData.content[0] && classData.content[0].text) || '';
        let categoria = 'AZIONE_MANUALE';
        try {
          const classJson = JSON.parse(classText.match(/\{[^}]+\}/)[0]);
          categoria = classJson.categoria || 'AZIONE_MANUALE';
          if (!['SOLO_INFO','GESTIBILE_AUTO'].includes(categoria)) categoria = 'AZIONE_MANUALE';
        } catch(e) { categoria = 'AZIONE_MANUALE'; }

        console.log(`[AUTO-REPLY-SERVER] Ticket ${tid} → ${categoria}`);

        if (categoria === 'AZIONE_MANUALE') {
          _serverNeedsAction.add(tid);
          continue;
        }

        // ══ STEP 2: CARICA PROMPT E ORDINE INFO ══
        let aiPrompt = "Sei l'assistente clienti di Yespresso. Rispondi in italiano, tono cordiale. Firma come Il Team Yespresso. NON usare markdown.";
        try {
          const ghToken = process.env.GH_TOKEN;
          if (ghToken) {
            const promptRes = await fetch('https://api.github.com/repos/yespresso80/yespresso-proxy/contents/ai-prompt.json', {
              headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' }
            });
            if (promptRes.ok) {
              const promptJ = await promptRes.json();
              const promptData = JSON.parse(Buffer.from(promptJ.content.replace(/\n/g,''),'base64').toString('utf8'));
              const sections = promptData.sections || promptData;
              if (Array.isArray(sections)) {
                const txt = sections.filter(s => !s.disabled && s.text && s.text.trim()).map(s => s.text.trim()).join('\n\n');
                if (txt) aiPrompt = txt;
              }
            }
          }
        } catch(e) {}

        let orderInfo = '';
        if (order) {
          const f = order.fulfillments && order.fulfillments[0];
          orderInfo = `Ordine ${order.name} | Stato: ${order.fulfillment_status||'non spedito'} | €${order.total_price}`;
          if (order.created_at) orderInfo += ` | Creato il: ${new Date(order.created_at).toLocaleString('it-IT')}`;
          if (order.cancelled_at) orderInfo += ` | ANNULLATO il ${new Date(order.cancelled_at).toLocaleDateString('it-IT')}`;
          if (order.payment_gateway) orderInfo += ` | Metodo pagamento: ${order.payment_gateway}`;
          if (f && f.tracking_number) orderInfo += ` | Tracking BRT: https://vas.brt.it/vas/sped_det_show.hsm?referer=sped_numspe_par.htm&Nspediz=${f.tracking_number}`;
          if ((order.line_items||[]).length) orderInfo += ` | Prodotti: ${order.line_items.map(i=>i.quantity+'x '+i.name).join(', ')}`;
        }

        // ══ STEP 3: ISTRUZIONI SPECIFICHE PER CATEGORIA ══
        let istruzioni = '';
        let isFirstReplyOnly = false; // per "prodotto sbagliato" non risponde più dopo la prima

        if (categoria === 'SOLO_INFO') {
          istruzioni = 'Rispondi SOLO con informazioni fattuali (tracking, tempi, stato ordine). NON promettere mai rimborsi, crediti, sostituzioni o compensazioni.';
        } else if (categoria === 'GESTIBILE_AUTO') {
          // Determina sottocategoria dal testo
          const txt = fullThread.toLowerCase() + ' ' + subj.toLowerCase();
          if (/capsul.*dann|dann.*capsul|capsul.*rott|busta.*dann|qualit|lotto|bruciato|difettos/i.test(txt)) {
            const hasFoto = /allego|invio le foto|foto inviate|ho inviato|vedi foto|in allegato/i.test(txt);
            const hasQta = /\d+\s*capsule|\d+\s*buste|capsule.*\d+|\d+\s*pezzi/i.test(txt);
            if (hasFoto || hasQta) {
              // Foto o quantità già fornite → serve intervento umano per compensazione
              _serverNeedsAction.add(tid);
              continue;
            }
            istruzioni = 'Il cliente segnala capsule danneggiate o di qualità inferiore. Chiedi SOLO: 1) foto delle capsule/buste danneggiate in formato JPG, 2) foto del pacco ricevuto, 3) quantità esatta danneggiata. NON promettere rimborsi, crediti o sostituzioni. NON calcolare importi.';
          } else if (/problem.*tecnic|non funzion|macchina|non riconosc|non ero|non bucata|erogazione|pressione/i.test(txt)) {
            istruzioni = 'Il cliente ha un problema tecnico con le capsule. Fornisci istruzioni tecniche specifiche per il tipo di capsula/macchina. NON promettere rimborsi o sostituzioni.';
          } else if (/acquist.*errat|errat.*acquist|sbagliato|compatibil|compatibilità|non compatibil|macchina.*nespresso|macchina.*bialetti|macchina.*dolce|capsule che acquisto|prodotto che acquisto/i.test(txt)) {
            const wantsBrt = /il cliente ha scelto la modalit.*ritiro da parte nostra/i.test(txt);
            if (wantsBrt) {
              istruzioni = 'Il chatbot ha indicato che il cliente ha scelto il ritiro da parte nostra. Conferma che organizzeremo il ritiro tramite BRT e che al ricevimento verrà creato un credito pari al valore dei prodotti al netto di 8€ di gestione reso.';
            } else {
              istruzioni = 'Il cliente ha acquistato per errore le capsule sbagliate. Spiega la procedura reso: entro 14 giorni, spese spedizione a carico del cliente, indirizzo YESPRESSO via Galileo Galilei 16 20054 Segrate, includere copia ordine, prodotti integri e non aperti. NON offrire sostituzione né rimborso diretto.';
            }
          } else if (/annull/i.test(txt)) {
            // Annullamento — già gestito sotto con serverCanCancelOrder
            istruzioni = 'Il cliente richiede annullamento ordine. Verifica le condizioni e conferma se possibile. Se non annullabile, spiega il motivo.';
          } else if (/prodotto sbagliato.*ricevu|ricevu.*prodotto sbagliato|spediz.*errat|errat.*spediz|prodotto errato|capsule diverse/i.test(txt)) {
            istruzioni = 'Il cliente ha ricevuto il prodotto sbagliato per errore nostro. Chiedi: 1) descrizione del prodotto ricevuto per errore, 2) foto della scatola/pacco con etichetta BRT visibile (JPG), 3) foto della busta con le capsule ricevute (JPG). NON procedere con rimborsi o sostituzioni. Questa è la PRIMA e UNICA risposta automatica su questo ticket.';
            isFirstReplyOnly = true;
          } else {
            // Fallback sicuro
            categoria = 'AZIONE_MANUALE';
            _serverNeedsAction.add(tid);
            continue;
          }
        }

        // ══ STEP 4: GENERA RISPOSTA ══
        const systemFull = aiPrompt + '\n\nMODALITÀ AUTO-RISPOSTA — ISTRUZIONI SPECIFICHE:\n' + istruzioni + '\n\nREGOLA ASSOLUTA: NON promettere mai rimborsi, accrediti, crediti, compensazioni economiche o sostituzioni. Se necessario farlo, NON rispondere.';
        const userMsg = `Oggetto: ${subj}\nDa: ${(full.requester&&full.requester.name)||'Cliente'}\nEmail: ${email}`+
          (orderInfo ? `\n\nDati ordine:\n${orderInfo}` : '')+
          `\n\nSTORICO:\n${fullThread}\n\nRispondi seguendo le istruzioni specifiche. NON fare promesse economiche.`;

        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 600, system: systemFull, messages: [{ role: 'user', content: userMsg }] })
        });
        const aiData = await aiRes.json();
        let reply = (aiData.content && aiData.content[0] && aiData.content[0].text) || '';
        if (!reply.trim()) continue;

        // Pulizia
        reply = reply.replace(/\s*\[COPIA_IMPORTO:[^\]]+\]\s*$/,'').replace(/<a\s[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi,'$1').replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ').trim();

        // Verifica finale sicurezza
        const unsafePatterns = [/provvederemo.*rimborso/i,/procediamo.*rimborso/i,/effettueremo.*rimborso/i,/rimborso.*entro/i,/rimborso.*verrà/i,/accrediteremo/i,/abbiamo accreditato/i,/accredito.*verrà/i,/invieremo.*credito/i,/procediamo.*sostituzione/i,/provvederemo.*sostituzione/i,/rispediremo/i,/procediamo.*accredito/i,/procediamo immediatamente/i];
        if (unsafePatterns.some(p => p.test(reply))) {
          console.log(`[AUTO-REPLY-SERVER] Ticket ${tid} — risposta contiene promesse economiche, skip`);
          _serverNeedsAction.add(tid);
          continue;
        }

        // ══ STEP 5: ANNULLAMENTO SHOPIFY (se richiesto) ══
        if (/annull/i.test(fullThread + ' ' + subj)) {
          const isMarketplaceOrder = order && ((order.note_attributes||[]).some(a => ['Amazon Order Id','PARENT_ORDER_SN','Temu Order Id','tiktok_order'].includes(a.name)));
          if (order && !isMarketplaceOrder && serverCanCancelOrder(order)) {
            try {
              const cancelRes = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/orders/${order.id}/cancel.json`,{
                method:'POST',
                headers:{'X-Shopify-Access-Token':SHOPIFY_TOKEN,'Content-Type':'application/json'},
                body:JSON.stringify({reason:'customer',email:true,refund:true})
              });
              if (cancelRes.ok) {
                console.log(`[AUTO-REPLY-SERVER] ✅ Ordine ${order.name} annullato su Shopify`);
                reply = reply.replace(/annulleremo|annullare|annullerà/i,'abbiamo annullato');
              }
            } catch(ce) { console.log('[AUTO-REPLY-SERVER] Errore annullamento:', ce.message); }
          }
        }

        // ══ STEP 6: INVIA ══
        // Per "prodotto sbagliato" non chiudere il ticket — lascia Open ma segna come processato
        const newStatus = isFirstReplyOnly ? 'open' : 'solved';
        const sendRes = await hdPatch(`/tickets/${tid}`, { message: { text: reply }, status: newStatus });
        if (!sendRes.ok) {
          const sendRes2 = await hdPatch(`/tickets/${tid}`, { message: { text: reply } });
          if (!sendRes2.ok) { console.log(`[AUTO-REPLY-SERVER] Invio fallito ticket ${tid}: ${sendRes2.status}`); continue; }
          if (!isFirstReplyOnly) {
            for (const m of ['PUT','PATCH']) {
              try { await hdPut(`/tickets/${tid}`, { status: 'solved' }); break; } catch(e) {}
            }
          }
        }

        _serverAutoProcessed[tid] = new Date().toISOString();
        _serverNeedsAction.delete(tid);
        console.log(`[AUTO-REPLY-SERVER] ✅ Ticket ${tid} risposto e chiuso`);
        await new Promise(r => setTimeout(r, 2000));

      } catch(e) {
        console.log(`[AUTO-REPLY-SERVER] Errore ticket ${tid}:`, e.message);
      }
    }
  } catch(e) {
    console.log('[AUTO-REPLY-SERVER] Errore worker:', e.message);
  }
}

// Avvia worker dopo 10 secondi dal boot, poi ogni 60s
setTimeout(() => {
  serverAutoReplyWorker(true); // true = processa anche ticket esistenti al boot
  setInterval(() => serverAutoReplyWorker(false), AUTO_REPLY_INTERVAL);
}, 10000);
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
          // Estrai testo body per ricerca numero ordine
          let bodyText = "";
          try {
            const textPartMatch = raw.match(/Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)(?=--|\r\n--)/i);
            if (textPartMatch) bodyText = textPartMatch[1].replace(/=\r?\n/g,"").substring(0,2000);
            else bodyText = raw.replace(/<[^>]+>/g," ").substring(0,2000);
          } catch(e3) {}
          attachmentsCache.set(messageId, { from: fromEmail, subject, date, attachments, bodyText });
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

function findAttachmentsForTicket(requesterEmail, subject, orderNum) {
  const results = [];
  const emailLow = (requesterEmail||"").toLowerCase();
  const subjLow = (subject||"").toLowerCase();
  const orderNumLow = (orderNum||"").toLowerCase();

  for (const [, data] of attachmentsCache) {
    const fromLow = (data.from||"").toLowerCase();
    const dataSubjLow = (data.subject||"").toLowerCase();

    // 1. Match per email esatta (escludi email anonime Amazon/Temu)
    const isAnonEmail = emailLow.includes("amazon") || emailLow.includes("temu") ||
                        emailLow.includes("marketplace") || emailLow.includes("bounce-");
    const emailMatch = !isAnonEmail && emailLow && fromLow &&
      (fromLow.includes(emailLow) || emailLow.includes(fromLow.split("@")[0]));

    // 2. Match per numero ordine Amazon nel subject O nel body dell'email ricevuta
    const bodyTextLow = (data.bodyText||"").toLowerCase();
    const orderMatch = orderNumLow.length > 5 && (
      dataSubjLow.includes(orderNumLow) ||
      bodyTextLow.includes(orderNumLow)
    );

    // 3. Match per subject (solo se non Amazon/marketplace)
    const subjClean = subjLow.replace(/^(re:|fwd:|fw:)\s*/gi,"").trim().substring(0,30);
    const subjMatch = !isAnonEmail && subjClean.length > 5 &&
      (data.subject||"").toLowerCase().includes(subjClean.substring(0,20));

    if (emailMatch || orderMatch || subjMatch) {
      results.push(...data.attachments.map(a => ({ ...a, from: data.from, date: data.date, subject: data.subject })));
    }
  }
  // Deduplicazione per URL
  const seen = new Set();
  return results.filter(a => { if(seen.has(a.url)) return false; seen.add(a.url); return true; });
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

const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const PROXY_TOKEN = process.env.PROXY_TOKEN || "";

function checkProxyToken(req) {
  if (!PROXY_TOKEN) return true; // non configurato = aperto (backward compatible)
  return req.headers["x-app-token"] === PROXY_TOKEN;
}

// ── Autenticazione pagina reso-magazzino ──
function checkAuth(req) {
  if (!SITE_PASSWORD) return true;
  const cookies = req.headers.cookie || "";
  const match = cookies.match(/(?:^|;\s*)hd_auth=([^;]+)/);
  return match && match[1] === SITE_PASSWORD;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Accesso — Yespresso HelpDesk</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#1a1d27;border:1px solid #2e3347;border-radius:16px;padding:36px 32px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,.4)}
  .logo{font-size:32px;text-align:center;margin-bottom:8px}
  h1{color:#f0f2f8;font-size:20px;font-weight:700;text-align:center;margin-bottom:4px}
  .sub{color:#8891a8;font-size:13px;text-align:center;margin-bottom:28px}
  label{color:#8891a8;font-size:12px;font-weight:600;display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
  input{width:100%;background:#22263a;border:1px solid #2e3347;border-radius:10px;padding:12px 14px;font-size:15px;color:#f0f2f8;font-family:inherit;outline:none;transition:.2s}
  input:focus{border-color:#e53e3e}
  button{width:100%;margin-top:16px;background:#e53e3e;border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:700;color:#fff;cursor:pointer;font-family:inherit;transition:.15s}
  button:active{background:#c53030}
  .err{color:#ff6b6b;font-size:13px;text-align:center;margin-top:12px;display:none}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡</div>
  <h1>Yespresso HelpDesk</h1>
  <p class="sub">Inserisci la password per accedere</p>
  <form method="POST" action="/hd-login">
    <label>Password</label>
    <input type="password" name="pwd" placeholder="••••••••" autofocus autocomplete="current-password">
    <button type="submit">Accedi</button>
  </form>
  <div class="err" id="err">Password non corretta</div>
</div>
<script>
  const u = new URLSearchParams(location.search);
  if(u.get('err')) document.getElementById('err').style.display='block';
</script>
</body>
</html>`;

// ── FILIPPO DATA (merce inserita + attività) ──
const GH_FILIPPO_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/filippo-data.json';
async function ghFilippoGet() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: null, sha: null };
  const r = await fetch(GH_FILIPPO_URL, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
  if (r.status === 404) return { data: null, sha: null };
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
}
async function ghFilippoSave(data, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN non configurato');
  const body = { message: 'update filippo-data', content: Buffer.from(JSON.stringify(data)).toString('base64') };
  if (sha) body.sha = sha;
  await fetch(GH_FILIPPO_URL, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ── GITHUB: Quick Replies ──
const GH_QR_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/quick-replies.json';
async function ghQrGet() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: { replies: [], cats: [] }, sha: null };
  const r = await fetch(GH_QR_URL, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
  if (r.status === 404) return { data: { replies: [], cats: [] }, sha: null };
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
}
async function ghQrSave(data, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN non configurato');
  const body = { message: 'update quick-replies', content: Buffer.from(JSON.stringify(data)).toString('base64') };
  if (sha) body.sha = sha;
  await fetch(GH_QR_URL, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ── GITHUB: Reso AI Prompt ──
const GH_RESO_AI_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/reso-ai-prompt.json';
async function ghResoAIGet() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: null, sha: null };
  const r = await fetch(GH_RESO_AI_URL, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
  if (r.status === 404) return { data: null, sha: null };
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
}
async function ghResoAISave(data, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN non configurato');
  const body = { message: 'update reso-ai-prompt', content: Buffer.from(JSON.stringify(data)).toString('base64') };
  if (sha) body.sha = sha;
  await fetch(GH_RESO_AI_URL, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ── GITHUB: AI Prompt ──
const GH_AIPROMPT_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/ai-prompt.json';
async function ghAiPromptGet() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: null, sha: null };
  const r = await fetch(GH_AIPROMPT_URL, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
  if (r.status === 404) return { data: null, sha: null };
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
}
async function ghAiPromptSave(data, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN non configurato');
  const body = { message: 'update ai-prompt', content: Buffer.from(JSON.stringify(data)).toString('base64') };
  if (sha) body.sha = sha;
  await fetch(GH_AIPROMPT_URL, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const server = http.createServer(async function(req, res) {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key, User-Agent");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health" || req.url === "/ping") { res.writeHead(200); res.end("OK"); return; }

  // ── Login reso-magazzino ──
  if (req.url === "/hd-login" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const pwd = params.get("pwd") || "";
      if (pwd === SITE_PASSWORD) {
        res.writeHead(302, {
          "Set-Cookie": "hd_auth=" + SITE_PASSWORD + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400",
          "Location": "/"
        });
      } else {
        res.writeHead(302, { "Location": "/hd-login?err=1" });
      }
      res.end();
    });
    return;
  }
  if (req.url === "/hd-login") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LOGIN_PAGE);
    return;
  }

  // Endpoint allegati IMAP
  if (req.url.startsWith("/imap/attachments")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const email = params.get("email") || "";
    const subject = params.get("subject") || "";
    const orderNum = params.get("ordernum") || "";
    await syncImapAttachments();
    const attachments = findAttachmentsForTicket(email, subject, orderNum);
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
    const resoFile = path.join(__dirname, "reso-magazzino.html");
    fs.readFile(resoFile, function(err, data) {
      if (err) { res.writeHead(404); res.end("File non trovato"); return; }
      let html = data.toString('utf8');
      html = html.replace('{{PROXY_TOKEN}}', PROXY_TOKEN);
      html = html.replace('{{HD_TOKEN}}', HD_TOKEN);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    return;
  }

  if (req.url === "/" || req.url === "/index.html" || req.url === "/yespresso-helpdesk.html") {
    if (!checkAuth(req)) {
      res.writeHead(302, { "Location": "/hd-login" });
      res.end();
      return;
    }
    const filePath = path.join(__dirname, "yespresso-helpdesk.html");
    fs.readFile(filePath, function(err, data) {
      if (err) { res.writeHead(404); res.end("File non trovato"); return; }
      // Inietta token segreti nel HTML — non appaiono nel file su GitHub
      let html = data.toString('utf8');
      html = html.replace('{{HD_TOKEN}}', HD_TOKEN);
      html = html.replace('{{PROXY_TOKEN}}', PROXY_TOKEN);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
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
  // ── Verifica token su endpoint sensibili ──
  const sensitiveEndpoints = ["/brt/", "/shopify", "/anthropic", "/creditsyard/"];
  if (sensitiveEndpoints.some(function(e){ return req.url.startsWith(e); })) {
    if (!checkProxyToken(req)) {
      res.writeHead(401, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
      res.end(JSON.stringify({error:"Unauthorized"}));
      return;
    }
  }

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
      
      // Estrai indirizzo punto di ritiro dalla struttura BRT
      let punto_info = "";
      try {
        const filiale = spedizione.filiale_destinazione || spedizione.filiale || {};
        const ragSoc = filiale.ragione_sociale || filiale.descrizione || "";
        const via = filiale.indirizzo || filiale.via || "";
        const cap = filiale.cap || "";
        const citta = filiale.localita || filiale.citta || "";
        const prov = filiale.provincia || "";
        if(ragSoc || via) {
          punto_info = [ragSoc, via, cap+' '+citta+' ('+prov+')'].filter(Boolean).join(", ").trim();
        }
        // Fallback: cerca nell'ultimo evento
        if(!punto_info && ultimoEvento.filiale) {
          const fe = ultimoEvento.filiale;
          punto_info = [fe.ragione_sociale||fe.descrizione, fe.indirizzo, (fe.cap||'')+' '+(fe.localita||fe.citta||'')].filter(Boolean).join(", ").trim();
        }
      } catch(pe) {}
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, at_fermopoint, scadenza_ritiro, punto_info, raw: data }));
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

  // ── RESO AI PROMPT ───────────────────────────────────────────
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


  // ── AI PROMPT ───────────────────────────────────────────────
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


  // ── AUTO-REPLY STATUS — lista ticket che richiedono azione ──
  if (req.url === '/auto-reply-status') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      needsAction: [..._serverNeedsAction],
      blocked: [..._serverAutoBlocked],
      processed: Object.keys(_serverAutoProcessed)
    }));
    return;
  }

  // ── FILIPPO DATA endpoint ──
  if (req.url === '/filippo-data') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') { res.writeHead(200,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,x-app-token'}); res.end(); return; }
    if (req.method === 'GET') {
      try { const { data } = await ghFilippoGet(); res.writeHead(200,CORS); res.end(JSON.stringify(data||{})); }
      catch(e) { res.writeHead(200,CORS); res.end(JSON.stringify({})); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data',c=>chunks.push(c));
      req.on('end', async function(){
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          let retries = 3;
          while (retries-- > 0) {
            try { const { sha } = await ghFilippoGet(); await ghFilippoSave(parsed, sha); break; }
            catch(e2) { if (retries === 0) throw e2; await new Promise(r => setTimeout(r, 300)); }
          }
          res.writeHead(200,CORS); res.end(JSON.stringify({ok:true}));
        } catch(e) { res.writeHead(500,CORS); res.end(JSON.stringify({ok:false,error:e.message})); }
      }); return;
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



  // ── SCATOLE BEVANDE ──────────────────────────────────────────
  const GH_SCATBEV_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/scatbev-data.json';
  async function ghScatbevGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: null, sha: null };
    const r = await fetch(GH_SCATBEV_URL, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
    if (r.status === 404) return { data: null, sha: null };
    const j = await r.json();
    return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
  }
  async function ghScatbevSave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update scatbev-data', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(GH_SCATBEV_URL, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  if (req.url === '/scatbev-data') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') { res.writeHead(200,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); res.end(); return; }
    if (req.method === 'GET') {
      try { const { data } = await ghScatbevGet(); res.writeHead(200,CORS); res.end(JSON.stringify(data||null)); }
      catch(e) { res.writeHead(200,CORS); res.end(JSON.stringify(null)); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data',c=>chunks.push(c));
      req.on('end', async function(){
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          let retries = 3;
          while (retries-- > 0) {
            try { const { sha } = await ghScatbevGet(); await ghScatbevSave(parsed, sha); break; }
            catch(e2) { if (retries===0) throw e2; await new Promise(r=>setTimeout(r,300)); }
          }
          res.writeHead(200,CORS); res.end(JSON.stringify({ok:true}));
        } catch(e) { res.writeHead(500,CORS); res.end(JSON.stringify({ok:false,error:e.message})); }
      }); return;
    }
  }

  // ── SCATOLE MAGAZZINO ─────────────────────────────────────────
  const GH_SCATOLE_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/scatole-data.json';
  async function ghScatoleGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: null, sha: null };
    const r = await fetch(GH_SCATOLE_URL, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
    if (r.status === 404) return { data: null, sha: null };
    const j = await r.json();
    return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
  }
  async function ghScatoleSave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update scatole-data', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(GH_SCATOLE_URL, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  if (req.url === '/scatole-data') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') { res.writeHead(200,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); res.end(); return; }
    if (req.method === 'GET') {
      try { const { data } = await ghScatoleGet(); res.writeHead(200,CORS); res.end(JSON.stringify(data||null)); }
      catch(e) { res.writeHead(200,CORS); res.end(JSON.stringify(null)); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data',c=>chunks.push(c));
      req.on('end', async function(){
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          let retries = 3;
          while (retries-- > 0) {
            try {
              const { sha } = await ghScatoleGet();
              await ghScatoleSave(parsed, sha);
              break;
            } catch(e2) {
              if (retries === 0) throw e2;
              await new Promise(r => setTimeout(r, 300));
            }
          }
          console.log('[SCATOLE] Salvato su GitHub');
          res.writeHead(200,CORS); res.end(JSON.stringify({ok:true}));
        } catch(e) { res.writeHead(500,CORS); res.end(JSON.stringify({ok:false,error:e.message})); }
      }); return;
    }
  }

  // ── MATERIALI PRODUZIONE

  // ── MATERIALI PRODUZIONE ───────────────────────────────────────
  const GH_MATPROD_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/matprod-data.json';
  async function ghMatprodGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: null, sha: null };
    const r = await fetch(GH_MATPROD_URL, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
    if (r.status === 404) return { data: null, sha: null };
    const j = await r.json();
    return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
  }
  async function ghMatprodSave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update matprod-data', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(GH_MATPROD_URL, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  if (req.url === '/matprod-data') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') { res.writeHead(200,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); res.end(); return; }
    if (req.method === 'GET') {
      try { const { data } = await ghMatprodGet(); res.writeHead(200,CORS); res.end(JSON.stringify(data||null)); }
      catch(e) { res.writeHead(200,CORS); res.end(JSON.stringify(null)); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data',c=>chunks.push(c));
      req.on('end', async function(){
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          let retries = 3;
          while (retries-- > 0) {
            try {
              const { sha } = await ghMatprodGet();
              await ghMatprodSave(parsed, sha);
              break;
            } catch(e2) {
              if (retries === 0) throw e2;
              await new Promise(r => setTimeout(r, 300));
            }
          }
          console.log('[MATPROD] Salvato su GitHub');
          res.writeHead(200,CORS); res.end(JSON.stringify({ok:true}));
        } catch(e) { res.writeHead(500,CORS); res.end(JSON.stringify({ok:false,error:e.message})); }
      }); return;
    }
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
