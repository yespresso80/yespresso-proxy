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

// ── TEMPLATE WHATSAPP DI DEFAULT ────────────────────────────────────────
// Usati se whatsapp-templates.json non esiste ancora su GitHub.
// Dopo la prima modifica dal pannello Filippo, i template diventano editabili
// e vengono salvati su GitHub sovrascrivendo questi default.
const DEFAULT_WA_TEMPLATES = [
  {
    id: 'tpl_problema_prodotto',
    nome: 'Problema prodotto — invia foto/video',
    emoji: '📸',
    testo: 'Ciao {nome}, abbiamo ricevuto la tua segnalazione sull\'ordine {ordine}.\n\nPer poterti aiutare al meglio, potresti inviarci:\n• Una foto del prodotto\n• Un breve video che mostri il difetto\n• Una foto della busta con lotto e scadenza (se capsule)\n\nCosì possiamo valutare rapidamente la soluzione migliore.\n{if_ticket}Rif. ticket: {link_ticket}{/if_ticket}\n\nGrazie! ☕\nYespresso'
  },
  {
    id: 'tpl_indirizzo_incompleto',
    nome: 'Indirizzo inesistente/incompleto',
    emoji: '🏠',
    testo: 'Ciao {nome}, il corriere BRT non è riuscito a consegnare l\'ordine {ordine} perché l\'indirizzo risulta inesistente o incompleto.\n\nPotresti confermarci i dati completi di consegna:\n• Via e numero civico\n• CAP e città\n• Eventuale riferimento (scala, interno, nome sul citofono)\n• Numero di telefono attivo\n\nAppena riceviamo i dati aggiornati comunichiamo subito al corriere.\n{if_tracking}Tracking: {link_tracking}{/if_tracking}\n{if_ticket}Rif. ticket: {link_ticket}{/if_ticket}\n\nGrazie!\nYespresso ☕'
  },
  {
    id: 'tpl_errore_spedizione_foto',
    nome: 'Errore spedizione — foto scatola/etichetta',
    emoji: '📦',
    testo: 'Ciao {nome}, ci dispiace per l\'inconveniente con l\'ordine {ordine}.\n\nPer verificare velocemente cosa è successo, potresti inviarci:\n• Foto della scatola ricevuta (intera)\n• Foto dell\'etichetta BRT incollata sulla scatola\n• Foto del contenuto aperto\n\nAppena riceviamo le foto procediamo con la soluzione.\n{if_ticket}Rif. ticket: {link_ticket}{/if_ticket}\n\nGrazie per la pazienza!\nYespresso ☕'
  },
  {
    id: 'tpl_stato_spedizione',
    nome: 'Stato spedizione',
    emoji: '🚚',
    testo: 'Ciao {nome}, ecco l\'aggiornamento sulla spedizione del tuo ordine {ordine}:\n\n{if_tracking}📍 Tracking BRT: {link_tracking}{/if_tracking}\n{if_fermopoint}📍 Punto di ritiro:\n{punto_ritiro}{/if_fermopoint}\n{if_ticket}Rif. ticket: {link_ticket}{/if_ticket}\n\nYespresso ☕\n\n⚠️ Questo non è un canale di assistenza — per rispondere scrivi a assistenza@yespresso.it'
  },
  {
    id: 'tpl_rispedito_corretto',
    nome: 'Rispedito prodotto corretto',
    emoji: '🔄',
    testo: 'Ciao {nome}, abbiamo appena rispedito il prodotto corretto per l\'ordine {ordine}.\n\n{if_tracking}Puoi seguire la nuova spedizione qui: {link_tracking}{/if_tracking}\n\nLa consegna è prevista nei prossimi 2-3 giorni lavorativi.\nCi scusiamo ancora per il disguido.\n{if_ticket}Rif. ticket: {link_ticket}{/if_ticket}\n\nYespresso ☕\n\n⚠️ Questo non è un canale di assistenza — per rispondere scrivi a assistenza@yespresso.it'
  },
  {
    id: 'tpl_prenotato_ritiro',
    nome: 'Prenotato ritiro BRT',
    emoji: '📮',
    testo: 'Ciao {nome}, abbiamo prenotato il ritiro BRT per l\'ordine {ordine}.\n\nIl corriere passerà nei prossimi giorni lavorativi all\'indirizzo da te indicato. Ti chiediamo di:\n• Avere il pacco già pronto e sigillato\n• Applicare l\'etichetta di reso (se fornita)\n• Attendere il passaggio del corriere\n\n{if_ritiro_brt}N. prenotazione: {ritiro_brt}{/if_ritiro_brt}\n{if_ticket}Rif. ticket: {link_ticket}{/if_ticket}\n\nYespresso ☕\n\n⚠️ Questo non è un canale di assistenza — per rispondere scrivi a assistenza@yespresso.it'
  },
  {
    id: 'tpl_punto_ritiro',
    nome: 'Punto di ritiro',
    emoji: '📍',
    testo: 'Ciao {nome}, il tuo pacco {ordine} è disponibile presso il seguente punto di ritiro:\n\n{punto_ritiro}\n\n{if_tracking}Puoi verificare i dettagli della spedizione qui: {link_tracking}{/if_tracking}\n{if_ticket}Rif. ticket: {link_ticket}{/if_ticket}\n\nTi chiediamo di ritirarlo entro la data di scadenza indicata, portando con te un documento d\'identità.\n\nYespresso ☕\n\n⚠️ Questo non è un canale di assistenza — per rispondere scrivi a assistenza@yespresso.it'
  }
];

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

        const classRes = await (async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const r = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 100, system: 'Sei un classificatore di ticket. Rispondi SOLO con JSON valido.', messages: [{ role: 'user', content: classifyMsg }] })
            });
            if (r.status !== 529 && r.status !== 529) return r;
            console.log(`[AUTO-REPLY-SERVER] 529 overload, retry ${attempt+1}/3...`);
            await new Promise(res => setTimeout(res, 5000 * (attempt + 1)));
          }
          return null;
        })();
        const classData = classRes ? await classRes.json() : {};
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
            const hasQta = /\d+\s*capsule\s*(dann|rott|difett|guast|bruci|mancant)/i.test(txt) || /ho\s+(trovato|contato|riscontrato).*\d+/i.test(txt);
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
              filename = filename.trim();
              // Decodifica MIME encoded-word =?utf-8?Q?...?= o =?utf-8?B?...?=
              filename = filename.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, function(m, charset, enc, encoded) {
                try {
                  if (enc.toUpperCase() === 'Q') {
                    const qp = encoded.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, function(_, h){ return String.fromCharCode(parseInt(h,16)); });
                    return Buffer.from(qp, 'binary').toString('utf8');
                  } else {
                    return Buffer.from(encoded, 'base64').toString('utf8');
                  }
                } catch(e) { return encoded; }
              });
              try { filename = decodeURIComponent(filename); } catch(e) {}
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
  const emailLow = (requesterEmail||"").toLowerCase().trim();
  const subjLow = (subject||"").toLowerCase();
  const orderNumLow = (orderNum||"").toLowerCase();

  for (const [, data] of attachmentsCache) {
    const fromLow = (data.from||"").toLowerCase();
    const dataSubjLow = (data.subject||"").toLowerCase();
    const bodyTextLow = (data.bodyText||"").toLowerCase();

    // 1. Match per email ESATTA (stesso indirizzo completo)
    const isAnonEmail = emailLow.includes("amazon") || emailLow.includes("temu") ||
                        emailLow.includes("marketplace") || emailLow.includes("bounce-");
    const emailMatch = !isAnonEmail && emailLow.length > 5 && fromLow.length > 5 &&
      (fromLow === emailLow || fromLow.includes('<'+emailLow+'>') || fromLow.includes(emailLow));

    const isBrtEmail = emailLow.includes("brt.it") || emailLow.includes("servizioclienti@brt") || emailLow.includes("vasnoreply@brt");
    let _emailMatchBrt = emailMatch;
    if (isBrtEmail && _emailMatchBrt && orderNumLow.length >= 6) {
      const brtBodyMatch = dataSubjLow.includes(orderNumLow) || bodyTextLow.includes(orderNumLow);
      if (!brtBodyMatch) _emailMatchBrt = false;
    }
    // 2. Match per numero ordine Amazon nel subject O nel body (solo se orderNum >= 10 chars)
    const orderMatch = orderNumLow.length >= 10 && (
      dataSubjLow.includes(orderNumLow) ||
      bodyTextLow.includes(orderNumLow)
    );

    // 3. Match per subject — solo se subject è molto specifico (>= 15 chars) e match completo
    // NON usare match parziale per evitare false corrispondenze
    const subjClean = subjLow.replace(/^(re:|fwd:|fw:)\s*/gi,"").trim();
    const subjMatch = !isAnonEmail && subjClean.length >= 15 && emailMatch &&
      dataSubjLow.includes(subjClean.substring(0, 30));

    if (_emailMatchBrt || orderMatch || subjMatch) {
      results.push(...data.attachments.map(a => ({ ...a, from: data.from, date: data.date, subject: data.subject })));
    }
  }
  // Deduplicazione per URL/data
  const seen = new Set();
  return results.filter(a => {
    const key = a.url || (a.filename + (a.data||'').substring(0,20));
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

// ── GITHUB: Resi ──
const GH_RESI_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/resi.json';
async function ghResiGet() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: [], sha: null };
  const r = await fetch(GH_RESI_URL, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
  if (r.status === 404) return { data: [], sha: null };
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
}
async function ghResiSave(data, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN non configurato');
  const body = { message: 'update resi', content: Buffer.from(JSON.stringify(data)).toString('base64') };
  if (sha) body.sha = sha;
  const r = await fetch(GH_RESI_URL, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const err = await r.json().catch(()=>({}));
    throw new Error('GitHub PUT resi: '+(err.message||r.status));
  }
}

const server = http.createServer(async function(req, res) {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key, User-Agent");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health" || req.url === "/ping") { res.writeHead(200); res.end("OK"); return; }

  // ── Login reso-magazzino ──
  if (req.url.startsWith("/hd-login") && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const pwd = params.get("pwd") || "";
      // Recupera next dall'URL query string (opzionale)
      let nextUrl = "/";
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const next = urlObj.searchParams.get("next");
        if (next && next.startsWith("/") && !next.startsWith("//")) nextUrl = next;
      } catch(e) {}
      if (pwd === SITE_PASSWORD) {
        res.writeHead(302, {
          "Set-Cookie": "hd_auth=" + SITE_PASSWORD + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400",
          "Location": nextUrl
        });
      } else {
        const errLoc = "/hd-login?err=1" + (nextUrl !== "/" ? "&next=" + encodeURIComponent(nextUrl) : "");
        res.writeHead(302, { "Location": errLoc });
      }
      res.end();
    });
    return;
  }
  if (req.url.startsWith("/hd-login")) {
    // Inietta next nel form action per preservarlo
    let loginHtml = LOGIN_PAGE;
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const next = urlObj.searchParams.get("next");
      if (next && next.startsWith("/") && !next.startsWith("//")) {
        loginHtml = loginHtml.replace('action="/hd-login"', 'action="/hd-login?next=' + encodeURIComponent(next) + '"');
      }
    } catch(e) {}
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginHtml);
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

  if (req.url === "/" || req.url === "/index.html" || req.url === "/yespresso-helpdesk.html" || req.url.startsWith("/?ticket=") || req.url.startsWith("/?")) {
    if (!checkAuth(req)) {
      // Preserva parametri URL nel redirect al login (es. ?ticket=XXX)
      const loginUrl = "/hd-login" + (req.url.includes("?") ? "?next=" + encodeURIComponent(req.url) : "");
      res.writeHead(302, { "Location": loginUrl });
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
      // Estrai parametro ticket dall'URL se presente
      let ticketParam = '';
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        ticketParam = (urlObj.searchParams.get('ticket') || '').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 64);
      } catch(e) {}
      // Inietta script con deep-link ticket prima di </head>
      const injection = '<script>window._ticketDaAprire=' + (ticketParam ? JSON.stringify(ticketParam) : 'null') + ';</script>';
      html = html.replace('</head>', injection + '</head>');
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    return;
  }

  // ═══ MOBILE VERSION — URL /m ═══
  if (req.url === "/m" || req.url === "/m/" || req.url === "/yespresso-mobile.html" || req.url.startsWith("/m?") || req.url.startsWith("/m/?")) {
    if (!checkAuth(req)) {
      const loginUrl = "/hd-login?next=" + encodeURIComponent(req.url);
      res.writeHead(302, { "Location": loginUrl });
      res.end();
      return;
    }
    const filePath = path.join(__dirname, "yespresso-mobile.html");
    fs.readFile(filePath, function(err, data) {
      if (err) { res.writeHead(404); res.end("File mobile non trovato"); return; }
      let html = data.toString('utf8');
      html = html.replace('{{HD_TOKEN}}', HD_TOKEN);
      html = html.replace('{{PROXY_TOKEN}}', PROXY_TOKEN);
      // Estrai parametro ticket dall'URL
      let ticketParam = '';
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        ticketParam = (urlObj.searchParams.get('ticket') || '').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 64);
      } catch(e) {}
      const injection = '<script>window._ticketDaAprire=' + (ticketParam ? JSON.stringify(ticketParam) : 'null') + ';</script>';
      html = html.replace('</head>', injection + '</head>');
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
  // ── BOLLE ANALIZZA (AI analisi PDF) ────────────────────────────────────
  if (req.url === '/bolle-analizza' && req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  if (req.url === '/bolle-analizza' && req.method === 'POST') {
    const CORS_BA = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const { pdfBase64 } = payload;
      if (!pdfBase64) { res.writeHead(400, CORS_BA); res.end(JSON.stringify({error:'missing pdfBase64'})); return; }
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY || '';
      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': ANTHROPIC_KEY },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: 'Analizza questo PDF che contiene una o piu bolle di consegna (DDT - Documenti di Trasporto). Per ogni bolla trovata estrai: fornitore (nome azienda mittente), numero_bolla (numero DDT/documento), data_bolla (formato YYYY-MM-DD), anno (intero), pagina (numero pagina PDF dove inizia questa bolla, partendo da 1), note (descrizione breve dei prodotti es: Capsule Nespresso 320 pz). Rispondi SOLO con un array JSON valido, nessun testo aggiuntivo, nessun backtick. Esempio: [{"fornitore":"Noire S.r.l.","numero_bolla":"DI/505","data_bolla":"2025-12-16","anno":2025,"pagina":1,"note":"Capsule CAF 240 NAP Cremoso 320 pz"},{"fornitore":"Best Espresso SpA","numero_bolla":"1358","data_bolla":"2025-12-12","anno":2025,"pagina":3,"note":"Capsule Nespresso 704 SC"}]' }
            ]
          }]
        })
      });
      const aiData = await aiResp.json();
      res.writeHead(200, CORS_BA);
      res.end(JSON.stringify(aiData));
    } catch(e) {
      console.error('[BOLLE ANALIZZA]', e.message);
      res.writeHead(500, {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ── BILANCIO ANALIZZA (AI analisi PDF bilancio contabile) ─────────────
  if (req.url === '/bilancio-analizza' && req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  if (req.url === '/bilancio-analizza' && req.method === 'POST') {
    const CORS_BI = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const { pdfBase64 } = payload;
      if (!pdfBase64) { res.writeHead(400, CORS_BI); res.end(JSON.stringify({error:'missing pdfBase64'})); return; }
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY || '';
      const prompt = 'Analizza questo PDF che contiene una situazione contabile progressiva (da inizio anno a fine mese indicato) di una societa italiana.\n\n'
        + 'Devi estrarre i valori di voci specifiche e restituirli in un JSON PIATTO. Rispondi SOLO con JSON valido, nessun testo aggiuntivo, nessun backtick.\n\n'
        + 'FORMATO RICHIESTO:\n'
        + '{\n'
        + '  "periodo_da": "YYYY-MM-DD",\n'
        + '  "periodo_a": "YYYY-MM-DD",\n'
        + '  "anno": 2026,\n'
        + '  "mese": 1,\n'
        + '  "societa": "nome societa",\n'
        + '\n'
        + '  "sp_att_immobilizzazioni": 99162.43,\n'
        + '  "sp_att_rimanenze": 68113.47,\n'
        + '  "sp_att_clienti": 9231.33,\n'
        + '  "sp_att_crediti_tributari": 10096.07,\n'
        + '  "sp_att_crediti_diversi": 42879.81,\n'
        + '  "sp_att_fornitori": 59758.76,\n'
        + '  "sp_att_attivita_finanziarie_non_imm": 104.95,\n'
        + '  "sp_att_disponibilita_liquide": 984920.03,\n'
        + '  "sp_att_ratei_risconti_attivi": 1355.68,\n'
        + '\n'
        + '  "sp_cred_inc_brt": 0,\n'
        + '  "sp_cred_inc_paypal": 0,\n'
        + '  "sp_cred_inc_amazon": 0,\n'
        + '  "sp_cred_inc_shopify": 0,\n'
        + '  "sp_cred_inc_temu": 0,\n'
        + '  "sp_cred_inc_tiktok": 0,\n'
        + '\n'
        + '  "sp_pass_f_amm_imm_immateriali": 26820.63,\n'
        + '  "sp_pass_f_amm_imm_materiali": 48003.02,\n'
        + '  "sp_pass_fondo_tfr": 35148.06,\n'
        + '  "sp_pass_fornitori": 548409.20,\n'
        + '  "sp_pass_altri_debiti_v_fornitori": 88956.55,\n'
        + '  "sp_pass_debiti_tributari": 2100.71,\n'
        + '  "sp_pass_debiti_diversi": 21691.51,\n'
        + '  "sp_pass_patrimonio_netto": 506637.98,\n'
        + '\n'
        + '  "sp_totale_attivo_pdf": 1277767.66,\n'
        + '  "sp_totale_passivo_pdf": 1277767.66,\n'
        + '  "sp_utile_perdita_esercizio": -2145.13,\n'
        + '\n'
        + '  "ce_vendite_e_prestazioni": 274415.55,\n'
        + '  "ce_proventi_straordinari": 0,\n'
        + '  "ce_rimanenze_iniziali": 88219.79,\n'
        + '  "ce_rimanenze_finali": 68113.47,\n'
        + '  "ce_acquisti": 156649.33,\n'
        + '  "ce_costi_per_servizi": 76212.05,\n'
        + '  "ce_compensi_e_provvigioni": 12042.80,\n'
        + '  "ce_costi_godimento_beni_terzi": 3296.15,\n'
        + '  "ce_costi_personale": 4295.38,\n'
        + '  "ce_oneri_diversi_gestione": 3059.49,\n'
        + '  "ce_ammortamenti": 781.84,\n'
        + '  "ce_oneri_finanziari": 3.90,\n'
        + '  "ce_rettifiche_di_ricavi": 113.42,\n'
        + '\n'
        + '  "ce_totale_ricavi_pdf": 342529.02,\n'
        + '  "ce_totale_costi_pdf": 344674.15\n'
        + '}\n\n'
        + 'ISTRUZIONI DETTAGLIATE:\n'
        + '\n'
        + 'STATO PATRIMONIALE ATTIVO — cerca questi subtotali (righe in grassetto senza codice conto, oppure somma dei codici sottostanti se il subtotale manca):\n'
        + '- sp_att_immobilizzazioni = subtotale "Immobilizzazioni" (al lordo, include sia immateriali che materiali). Se non c e il subtotale totale ma ci sono separatamente "Immobilizzazioni immateriali" e "Immobilizzazioni materiali", sommale.\n'
        + '- sp_att_rimanenze = subtotale "Rimanenze" (tipicamente riga unica con codice 14043.1)\n'
        + '- sp_att_clienti = subtotale "Clienti" (riga SENZA codice conto sottostante, tipicamente poche migliaia di euro, es. 4.270,00 o 9.231,33). NON confondere con altre voci.\n'
        + '- sp_att_crediti_tributari = subtotale "Crediti tributari" (somma dei codici 16xxx)\n'
        + '- sp_att_crediti_diversi = subtotale "Crediti diversi" (somma dei codici 17xxx, inclusi crediti per incassi marketplace come Amazon seller, Shopify, PayPal, BRT, Temu, TikTok)\n'
        + '- sp_att_fornitori = subtotale "Fornitori" nella sezione ATTIVO (sono anticipi/note credito verso fornitori, riga SENZA codice conto sottostante, tipicamente decine di migliaia di euro, es. 39.280,81 o 59.758,76). Questa voce appare DOPO "Crediti diversi" nell attivo. E DIVERSA dal "Fornitori" del passivo.\n'
        + '- sp_att_attivita_finanziarie_non_imm = subtotale "Attivita finanziarie non immobilizzate" (somma codici 13xxx)\n'
        + '- sp_att_disponibilita_liquide = subtotale "Disponibilita liquide" (somma codici 18xxx: banca, PayPal, cassa, assegni)\n'
        + '- sp_att_ratei_risconti_attivi = subtotale "Ratei e risconti attivi" (somma codici 19xxx)\n'
        + '\n'
        + 'CREDITI PER INCASSI (dettaglio sottoconti di "Crediti diversi", codici 17440.x) — cerca nelle righe con codice specifico:\n'
        + '- sp_cred_inc_brt = valore riga codice 17440.2 "Crediti per incassi in contrassegno BRT" (0 se assente)\n'
        + '- sp_cred_inc_paypal = valore riga codice 17440.4 "Crediti per incassi paypal" (0 se assente)\n'
        + '- sp_cred_inc_amazon = valore riga codice 17440.5 "Crediti per incassi amazon seller" (0 se assente)\n'
        + '- sp_cred_inc_shopify = valore riga codice 17440.6 "Crediti per incassi shopify" (0 se assente)\n'
        + '- sp_cred_inc_temu = valore riga codice 17440.8 "Crediti per incassi temu" (0 se assente)\n'
        + '- sp_cred_inc_tiktok = valore riga codice 17440.9 "Crediti per incassi tik tok" (0 se assente)\n'
        + 'IMPORTANTE: questi valori NON sono subtotali separati, sono GIA inclusi dentro "Crediti diversi" (sp_att_crediti_diversi). Li estraiamo come DETTAGLIO informativo, non come voce aggiuntiva.\n'
        + '\n'
        + 'STATO PATRIMONIALE PASSIVO — cerca questi subtotali:\n'
        + '- sp_pass_f_amm_imm_immateriali = subtotale "Fondi ammortamento immobilizzazioni immateriali" (somma codici 21xxx)\n'
        + '- sp_pass_f_amm_imm_materiali = subtotale "Fondi ammortamento immobilizzazioni materiali" (somma codici 22xxx)\n'
        + '- sp_pass_fondo_tfr = subtotale "Fondo TFR" (somma codici 24xxx)\n'
        + '- sp_pass_fornitori = subtotale "Fornitori" nella sezione PASSIVO (debiti v/fornitori generici, riga SENZA codice conto sottostante, centinaia di migliaia di euro, es. 547.492,21 o 548.409,20). VOCE CRITICA: NON ometterla, se manca il bilancio non quadra.\n'
        + '- sp_pass_altri_debiti_v_fornitori = subtotale "Altri debiti v/fornitori" (somma codici 26xxx come Fatture da ricevere, decine di migliaia di euro)\n'
        + '- sp_pass_debiti_tributari = subtotale "Debiti tributari" (somma codici 27xxx)\n'
        + '- sp_pass_debiti_diversi = subtotale "Debiti diversi" (somma codici 28xxx piu eventuale codice 17360.1 "Arrotondamenti su retribuzioni e compensi")\n'
        + '- sp_pass_patrimonio_netto = subtotale "Patrimonio netto" (somma codici 20xxx: capitale sociale, riserve, utili portati a nuovo, utile provvisorio esercizio precedente)\n'
        + '\n'
        + 'TOTALI SP (alla fine dello stato patrimoniale):\n'
        + '- sp_totale_attivo_pdf = riga "Totale attivo" del PDF (include perdita d esercizio "a pareggio" se presente)\n'
        + '- sp_totale_passivo_pdf = riga "Totale passivo" del PDF (include utile d esercizio "a pareggio" se presente)\n'
        + '- sp_utile_perdita_esercizio = valore riga "Utile d esercizio" o "Perdita d esercizio" alla fine dello SP. NEGATIVO se perdita (es. -2145.13), POSITIVO se utile (es. 8120.24).\n'
        + '\n'
        + 'CONTO ECONOMICO — cerca questi subtotali (righe in grassetto):\n'
        + '- ce_vendite_e_prestazioni = SOMMA di TRE subtotali: "Vendite e prestazioni" (40010.*) + "Altri ricavi" (41101.*) + "Rettifiche di costi" (30210/30230/31910). Esempio: 274.330,22 + 50,44 + 34,89 = 274.415,55. IMPORTANTE: somma tu i tre subtotali e restituisci un unico valore.\n'
        + '- ce_proventi_straordinari = subtotale "Proventi straordinari" (codici 44xxx, tipo sopravvenienze attive). 0 se non presente.\n'
        + '- ce_rimanenze_iniziali = subtotale "Rimanenze iniziali" (codici 36xxx)\n'
        + '- ce_rimanenze_finali = subtotale "Rimanenze finali" (codici 42xxx)\n'
        + '- ce_acquisti = subtotale "Acquisti" (codici 30030/30041/30043/30044/30047/30060/30099/30110/30130/30199)\n'
        + '- ce_costi_per_servizi = subtotale "Costi per servizi" (codici 31011/31033/31050/31110/31135/31140/31199/31211/31241/31837/31860)\n'
        + '- ce_compensi_e_provvigioni = subtotale "Compensi e provvigioni" (codici 31310/31340/31370/31710/31720/31725/31730)\n'
        + '- ce_costi_godimento_beni_terzi = subtotale "Costi per godimento beni di terzi" (codici 32xxx)\n'
        + '- ce_costi_personale = subtotale "Costi per il personale" (codici 33xxx)\n'
        + '- ce_oneri_diversi_gestione = subtotale "Oneri diversi di gestione" (codici 35xxx)\n'
        + '- ce_ammortamenti = subtotale "Ammortamenti" (codici 34xxx)\n'
        + '- ce_oneri_finanziari = subtotale "Oneri finanziari" (codici 37xxx)\n'
        + '- ce_rettifiche_di_ricavi = subtotale "Rettifiche di ricavi" (codici 40430.*)\n'
        + '\n'
        + 'TOTALI CE:\n'
        + '- ce_totale_ricavi_pdf = riga "Totale ricavi" del PDF (include rimanenze finali e rettifiche costi)\n'
        + '- ce_totale_costi_pdf = riga "Totale costi" del PDF (include rimanenze iniziali e rettifiche ricavi)\n'
        + '\n'
        + 'REGOLE GENERALI:\n'
        + '- TUTTI i valori devono essere NUMERI (non stringhe). Usa il punto come separatore decimale.\n'
        + '- Se una voce non e presente nel PDF, restituisci 0 (non null, non stringa vuota).\n'
        + '- IGNORA completamente la parte "RETTIFICHE FISCALI" del PDF: prendi solo i valori "Importo" del conto economico e dello stato patrimoniale contabile.\n'
        + '- "mese" e il numero del mese di fine periodo (es. se "01/01/2026 - 31/03/2026" allora mese=3).\n'
        + '- VERIFICA FINALE: sp_totale_attivo_pdf deve essere uguale a sp_totale_passivo_pdf. Se non coincidono, hai letto male.';
      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': ANTHROPIC_KEY },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: prompt }
            ]
          }]
        })
      });
      const aiData = await aiResp.json();
      res.writeHead(200, CORS_BI);
      res.end(JSON.stringify(aiData));
    } catch(e) {
      console.error('[BILANCIO ANALIZZA]', e.message);
      res.writeHead(500, {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ── BILANCIO DATA (storage JSON su GitHub, un file per mese/anno) ──────
  if (req.url.startsWith('/bilancio-data') && req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  if (req.url.startsWith('/bilancio-data')) {
    const CORS_BD = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const GH_BILANCIO_INDEX = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/bilancio-index.json';
    async function ghBilancioIndexGet() {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) return { data: [], sha: null };
      const r = await fetch(GH_BILANCIO_INDEX, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
      if (r.status === 404) return { data: [], sha: null };
      const j = await r.json();
      return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
    }
    async function ghBilancioIndexSave(data, sha) {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) throw new Error('GH_TOKEN non configurato');
      const body = { message: 'update bilancio-index', content: Buffer.from(JSON.stringify(data)).toString('base64') };
      if (sha) body.sha = sha;
      const r = await fetch(GH_BILANCIO_INDEX, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const t = await r.text(); throw new Error('GitHub bilancio save error: '+t.substring(0,200)); }
    }
    if (req.method === 'GET') {
      try { const { data } = await ghBilancioIndexGet(); res.writeHead(200, CORS_BD); res.end(JSON.stringify(data)); }
      catch(e) { console.error('[BILANCIO GET]', e.message); res.writeHead(200, CORS_BD); res.end('[]'); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        // payload: { bilanci: [...array completo aggiornato] }
        const { sha } = await ghBilancioIndexGet();
        await ghBilancioIndexSave(payload.bilanci, sha);
        res.writeHead(200, CORS_BD); res.end(JSON.stringify({ ok: true }));
      } catch(e) { console.error('[BILANCIO POST]', e.message); res.writeHead(500, CORS_BD); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    res.writeHead(405, CORS_BD); res.end(JSON.stringify({error:'Method not allowed'}));
    return;
  }

  // ── MARGINI DATA (storage JSON su GitHub per dati margine prodotto) ──────
  if (req.url.startsWith('/margini-data') && req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  if (req.url.startsWith('/margini-data')) {
    const CORS_MD = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const GH_MARGINI_INDEX = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/margini-index.json';
    async function ghMarginiIndexGet() {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) return { data: [], sha: null };
      const r = await fetch(GH_MARGINI_INDEX, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
      if (r.status === 404) return { data: [], sha: null };
      const j = await r.json();
      return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
    }
    async function ghMarginiIndexSave(data, sha) {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) throw new Error('GH_TOKEN non configurato');
      const body = { message: 'update margini-index', content: Buffer.from(JSON.stringify(data)).toString('base64') };
      if (sha) body.sha = sha;
      const r = await fetch(GH_MARGINI_INDEX, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const t = await r.text(); throw new Error('GitHub margini save error: '+t.substring(0,200)); }
    }
    if (req.method === 'GET') {
      try { const { data } = await ghMarginiIndexGet(); res.writeHead(200, CORS_MD); res.end(JSON.stringify(data)); }
      catch(e) { console.error('[MARGINI GET]', e.message); res.writeHead(200, CORS_MD); res.end('[]'); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        // payload: { margini: [...array completo aggiornato] }
        const { sha } = await ghMarginiIndexGet();
        await ghMarginiIndexSave(payload.margini, sha);
        res.writeHead(200, CORS_MD); res.end(JSON.stringify({ ok: true }));
      } catch(e) { console.error('[MARGINI POST]', e.message); res.writeHead(500, CORS_MD); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    res.writeHead(405, CORS_MD); res.end(JSON.stringify({error:'Method not allowed'}));
    return;
  }

  // ── MARGINI CANALE DATA (storage JSON su GitHub per margine canale) ──
  if (req.url.startsWith('/margini-canale-data') && req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  if (req.url.startsWith('/margini-canale-data')) {
    const CORS_MC = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const GH_MC_INDEX = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/margini-canale-index.json';
    async function ghMCGet() {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) return { data: [], sha: null };
      const r = await fetch(GH_MC_INDEX, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
      if (r.status === 404) return { data: [], sha: null };
      const j = await r.json();
      return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
    }
    async function ghMCSave(data, sha) {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) throw new Error('GH_TOKEN non configurato');
      const body = { message: 'update margini-canale-index', content: Buffer.from(JSON.stringify(data)).toString('base64') };
      if (sha) body.sha = sha;
      const r = await fetch(GH_MC_INDEX, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const t = await r.text(); throw new Error('GitHub margini-canale save error: '+t.substring(0,200)); }
    }
    if (req.method === 'GET') {
      try { const { data } = await ghMCGet(); res.writeHead(200, CORS_MC); res.end(JSON.stringify(data)); }
      catch(e) { console.error('[MC GET]', e.message); res.writeHead(200, CORS_MC); res.end('[]'); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        const { sha } = await ghMCGet();
        await ghMCSave(payload.margini, sha);
        res.writeHead(200, CORS_MC); res.end(JSON.stringify({ ok: true }));
      } catch(e) { console.error('[MC POST]', e.message); res.writeHead(500, CORS_MC); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    res.writeHead(405, CORS_MC); res.end(JSON.stringify({error:'Method not allowed'}));
    return;
  }

  // ── FCF MANUALI DATA (valori manuali per calcolo flusso di cassa libero) ──
  if (req.url.startsWith('/fcf-manuali-data') && req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  if (req.url.startsWith('/fcf-manuali-data')) {
    const CORS_FCF = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const GH_FCF_INDEX = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/fcf-manuali-index.json';
    async function ghFcfGet() {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) return { data: {}, sha: null };
      const r = await fetch(GH_FCF_INDEX, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
      if (r.status === 404) return { data: {}, sha: null };
      const j = await r.json();
      return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
    }
    async function ghFcfSave(data, sha) {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) throw new Error('GH_TOKEN non configurato');
      const body = { message: 'update fcf-manuali-index', content: Buffer.from(JSON.stringify(data)).toString('base64') };
      if (sha) body.sha = sha;
      const r = await fetch(GH_FCF_INDEX, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const t = await r.text(); throw new Error('GitHub fcf save error: '+t.substring(0,200)); }
    }
    if (req.method === 'GET') {
      try { const { data } = await ghFcfGet(); res.writeHead(200, CORS_FCF); res.end(JSON.stringify(data)); }
      catch(e) { console.error('[FCF GET]', e.message); res.writeHead(200, CORS_FCF); res.end('{}'); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        const { sha } = await ghFcfGet();
        await ghFcfSave(payload.fcf, sha);
        res.writeHead(200, CORS_FCF); res.end(JSON.stringify({ ok: true }));
      } catch(e) { console.error('[FCF POST]', e.message); res.writeHead(500, CORS_FCF); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    res.writeHead(405, CORS_FCF); res.end(JSON.stringify({error:'Method not allowed'}));
    return;
  }

  // ── WHATSAPP TEMPLATES (storage JSON su GitHub per template messaggi) ──
  if (req.url.startsWith('/whatsapp-templates') && req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  if (req.url.startsWith('/whatsapp-templates')) {
    const CORS_WT = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const GH_WT_INDEX = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/whatsapp-templates.json';
    async function ghWTGet() {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) return { data: null, sha: null };
      const r = await fetch(GH_WT_INDEX, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
      if (r.status === 404) return { data: null, sha: null };
      const j = await r.json();
      return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
    }
    async function ghWTSave(data, sha) {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) throw new Error('GH_TOKEN non configurato');
      const body = { message: 'update whatsapp-templates', content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64') };
      if (sha) body.sha = sha;
      const r = await fetch(GH_WT_INDEX, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const t = await r.text(); throw new Error('GitHub whatsapp-templates save error: '+t.substring(0,200)); }
    }
    if (req.method === 'GET') {
      try {
        const { data } = await ghWTGet();
        // Se non esiste ancora il file, restituisci i template di default
        if (!data || !Array.isArray(data)) {
          res.writeHead(200, CORS_WT); res.end(JSON.stringify(DEFAULT_WA_TEMPLATES));
        } else {
          res.writeHead(200, CORS_WT); res.end(JSON.stringify(data));
        }
      } catch(e) { console.error('[WT GET]', e.message); res.writeHead(200, CORS_WT); res.end(JSON.stringify(DEFAULT_WA_TEMPLATES)); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        const { sha } = await ghWTGet();
        await ghWTSave(payload.templates, sha);
        res.writeHead(200, CORS_WT); res.end(JSON.stringify({ ok: true }));
      } catch(e) { console.error('[WT POST]', e.message); res.writeHead(500, CORS_WT); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    res.writeHead(405, CORS_WT); res.end(JSON.stringify({error:'Method not allowed'}));
    return;
  }

  // ── WHATSAPP LOG (storico invii template WhatsApp) ──
  if (req.url.startsWith('/whatsapp-log') && req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  if (req.url.startsWith('/whatsapp-log')) {
    const CORS_WL = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const GH_WL_INDEX = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/whatsapp-log.json';
    async function ghWLGet() {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) return { data: [], sha: null };
      const r = await fetch(GH_WL_INDEX, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
      if (r.status === 404) return { data: [], sha: null };
      const j = await r.json();
      return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
    }
    async function ghWLSave(data, sha) {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) throw new Error('GH_TOKEN non configurato');
      const body = { message: 'update whatsapp-log', content: Buffer.from(JSON.stringify(data)).toString('base64') };
      if (sha) body.sha = sha;
      const r = await fetch(GH_WL_INDEX, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const t = await r.text(); throw new Error('GitHub whatsapp-log save error: '+t.substring(0,200)); }
    }
    if (req.method === 'GET') {
      try { const { data } = await ghWLGet(); res.writeHead(200, CORS_WL); res.end(JSON.stringify(data)); }
      catch(e) { console.error('[WL GET]', e.message); res.writeHead(200, CORS_WL); res.end('[]'); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        // payload: { entry: {ticket, ordine, template, ts, agente} } → append
        const { data, sha } = await ghWLGet();
        var arr = Array.isArray(data) ? data : [];
        if (payload.entry) arr.push(payload.entry);
        // Mantieni solo gli ultimi 500 invii per non esplodere
        if (arr.length > 500) arr = arr.slice(arr.length - 500);
        await ghWLSave(arr, sha);
        res.writeHead(200, CORS_WL); res.end(JSON.stringify({ ok: true }));
      } catch(e) { console.error('[WL POST]', e.message); res.writeHead(500, CORS_WL); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    res.writeHead(405, CORS_WL); res.end(JSON.stringify({error:'Method not allowed'}));
    return;
  }

  // ── GIACENZA WA SENT (stato condiviso invii WhatsApp giacenza) ──
  // Mappa { ticketId: { ts, phone, agente } } persistita su GitHub.
  // Condivisa tra tutti gli agenti: se un collega ha inviato WA, appare il badge.
  if (req.url.startsWith('/giacenza-wa-sent') && req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  if (req.url.startsWith('/giacenza-wa-sent')) {
    const CORS_GWS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const GH_GWS_INDEX = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/giacenza-wa-sent.json';
    async function ghGWSGet() {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) return { data: {}, sha: null };
      const r = await fetch(GH_GWS_INDEX, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
      if (r.status === 404) return { data: {}, sha: null };
      const j = await r.json();
      try {
        return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')) || {}, sha: j.sha };
      } catch(e) { return { data: {}, sha: j.sha }; }
    }
    async function ghGWSSave(data, sha) {
      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) throw new Error('GH_TOKEN non configurato');
      const body = { message: 'update giacenza-wa-sent', content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64') };
      if (sha) body.sha = sha;
      const r = await fetch(GH_GWS_INDEX, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const t = await r.text(); throw new Error('GitHub giacenza-wa-sent save error: '+t.substring(0,200)); }
    }

    if (req.method === 'GET') {
      try {
        const { data } = await ghGWSGet();
        res.writeHead(200, CORS_GWS); res.end(JSON.stringify(data || {}));
      } catch(e) {
        console.error('[GWS GET]', e.message);
        res.writeHead(200, CORS_GWS); res.end('{}');
      }
      return;
    }

    if (req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        if (!payload.ticketId) throw new Error('ticketId mancante');
        const { data, sha } = await ghGWSGet();
        var map = (data && typeof data === 'object') ? data : {};
        map[String(payload.ticketId)] = {
          ts: new Date().toISOString(),
          phone: payload.phone || '',
          agente: payload.agente || ''
        };
        await ghGWSSave(map, sha);
        res.writeHead(200, CORS_GWS); res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[GWS POST]', e.message);
        res.writeHead(500, CORS_GWS); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === 'DELETE') {
      // URL tipo /giacenza-wa-sent/TICKET_ID oppure /giacenza-wa-sent?ticketId=...
      let ticketId = '';
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        ticketId = urlObj.searchParams.get('ticketId') || '';
        if (!ticketId) {
          // Prendi dalla path
          const parts = urlObj.pathname.split('/').filter(Boolean);
          if (parts.length >= 2) ticketId = decodeURIComponent(parts[1]);
        }
      } catch(e) {}
      if (!ticketId) {
        res.writeHead(400, CORS_GWS); res.end(JSON.stringify({ ok:false, error:'ticketId mancante' }));
        return;
      }
      try {
        const { data, sha } = await ghGWSGet();
        var map = (data && typeof data === 'object') ? data : {};
        delete map[String(ticketId)];
        await ghGWSSave(map, sha);
        res.writeHead(200, CORS_GWS); res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[GWS DELETE]', e.message);
        res.writeHead(500, CORS_GWS); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    res.writeHead(405, CORS_GWS); res.end(JSON.stringify({error:'Method not allowed'}));
    return;
  }

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

  // BRT check fermopoint — usa scraping pagina web BRT (API REST non restituisce dati utili)
  if (req.url.startsWith("/brt/check-fermopoint")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const nspediz = params.get("nspediz") || "";
    if (!nspediz) { res.writeHead(400); res.end(JSON.stringify({ error: "nspediz required" })); return; }
    try {
      // Scraping pagina pubblica BRT tracking
      const brtWebUrl = "https://vas.brt.it/vas/sped_det_show.hsm?referer=sped_numspe_par.htm&Nspediz=" + encodeURIComponent(nspediz);
      const webRes = await fetch(brtWebUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const html = await webRes.text();
      // Cerca "ARRIVATA AL BRT-fermopoint" e data scadenza nel formato "fino al DD.MM.YYYY"
      const at_fermopoint = /FERMOPOINT|FERMO.?POINT|PUNTO DI RITIRO/i.test(html);
      let scadenza_ritiro = "";
      const scadMatch = html.match(/fino al\s+(\d{2}[.\/-]\d{2}[.\/-]\d{4})/i) 
        || html.match(/DISPONIBILE[^<]*?(\d{2}[.\/-]\d{2}[.\/-]\d{4})/i)
        || html.match(/scadenza[^<]*?(\d{2}[.\/-]\d{2}[.\/-]\d{4})/i);
      if (scadMatch) scadenza_ritiro = scadMatch[1];
      // Cerca indirizzo punto ritiro
      let punto_info = "";
      const pudoMatch = html.match(/BRT-fermopoint<\/[^>]+>\s*<[^>]+>([^<]{5,80})</i)
        || html.match(/Punto di ritiro[^:]*:\s*<[^>]*>([^<]{5,100})</i);
      if (pudoMatch) punto_info = pudoMatch[1].trim();
      // Log porzione HTML intorno a "fermopoint" per debug punto_info
      const fpIdx = html.toLowerCase().indexOf("fermopoint");
      if(fpIdx > 0) console.log("[BRT FERMOPOINT WEB HTML]", html.substring(Math.max(0,fpIdx-100), fpIdx+500).replace(/\s+/g,' '));
      console.log("[BRT FERMOPOINT WEB] at_fermopoint:", at_fermopoint, "scadenza:", scadenza_ritiro, "punto:", punto_info);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, at_fermopoint, scadenza_ritiro, punto_info }));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  // BRT check fermopoint LEGACY (API REST - lasciato per riferimento)
  if (req.url.startsWith("/brt/check-fermopoint-api")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const nspediz = params.get("nspediz") || "";
    if (!nspediz) { res.writeHead(400); res.end(JSON.stringify({ error: "nspediz required" })); return; }
    try {
      const data = await brtRestGet("/parcelID/" + encodeURIComponent(nspediz));
      const result = data.ttParcelIdResponse || data;
      // La struttura BRT: bolla.dati_spedizione + lista_eventi (array diretto)
      const spedizione = (result.bolla && result.bolla.dati_spedizione) || result.spedizione || {};
      const bolla = result.bolla || {};
      // Gli eventi sono in lista_eventi (array diretto nel ttParcelIdResponse)
      const listaEventi = result.lista_eventi || [];
      const eventiArr = Array.isArray(listaEventi) ? listaEventi : (listaEventi ? [listaEventi] : []);
      console.log("[BRT FERMOPOINT] lista_eventi count:", eventiArr.length);
      if(eventiArr.length) console.log("[BRT FERMOPOINT] primo evento keys:", Object.keys(eventiArr[0]).join(","));
      if(eventiArr.length) console.log("[BRT FERMOPOINT] ultimi 2 eventi:", JSON.stringify(eventiArr.slice(-2)));
      const ultimoEvento = eventiArr[eventiArr.length - 1] || {};
      const descEvento = (ultimoEvento.descrizione_evento || ultimoEvento.des_evento || "").toUpperCase();
      const at_fermopoint = descEvento.includes("FERMO") || descEvento.includes("PUNTO DI RITIRO") || descEvento.includes("FERMOPOINT");
      // Cerca data scadenza ritiro in vari campi possibili della risposta BRT
      let scadenza_ritiro = "";
      try {
        scadenza_ritiro = spedizione.data_scadenza_giacenza
          || spedizione.scadenza_giacenza
          || spedizione.data_giacenza
          || spedizione.data_limite_ritiro
          || spedizione.giacenza_fino_al
          || spedizione.data_scadenza
          || bolla.data_scadenza_giacenza
          || bolla.scadenza_giacenza
          || bolla.data_giacenza
          || "";
        if (!scadenza_ritiro) {
          const evGiac = eventiArr.find(function(e){
            const d = (e.descrizione_evento||e.des_evento||"").toUpperCase();
            return d.includes("GIACENZ") || d.includes("SCADENZ") || d.includes("DISPONIBILE");
          });
          if (evGiac) scadenza_ritiro = evGiac.data_evento || evGiac.data || "";
        }
        console.log("[BRT FERMOPOINT] result keys:", Object.keys(result).join(","));
        console.log("[BRT FERMOPOINT] spedizione keys:", Object.keys(spedizione).join(","));
        console.log("[BRT FERMOPOINT] stato_sped_parte1:", spedizione.stato_sped_parte1, "| parte2:", spedizione.stato_sped_parte2);
        console.log("[BRT FERMOPOINT] desc_stato_parte1:", spedizione.descrizione_stato_sped_parte1, "| parte2:", spedizione.descrizione_stato_sped_parte2);
        console.log("[BRT FERMOPOINT] filiale_arrivo:", spedizione.filiale_arrivo, "| URL:", spedizione.filiale_arrivo_URL);
        console.log("[BRT FERMOPOINT] dati_consegna:", JSON.stringify(bolla.dati_consegna||{}));
        console.log("[BRT FERMOPOINT] bolla keys:", Object.keys(bolla).join(","));
        console.log("[BRT FERMOPOINT] eventi count:", eventiArr.length, "at_fermopoint:", at_fermopoint);
        console.log("[BRT FERMOPOINT] scadenza trovata:", scadenza_ritiro);
        console.log("[BRT FERMOPOINT] ultimoEvento:", JSON.stringify(ultimoEvento).substring(0,300));
      } catch(se) { scadenza_ritiro = ultimoEvento.data_evento || ""; }
      
      // Estrai indirizzo punto di ritiro dalla struttura BRT
      let punto_info = "";
      try {
        // Prova filiale_arrivo da dati_spedizione
        const filArrivo = spedizione.filiale_arrivo || spedizione.filiale_destinazione || spedizione.filiale || {};
        const ragSoc = filArrivo.ragione_sociale || filArrivo.descrizione || spedizione.filiale_arrivo || "";
        const via = filArrivo.indirizzo || filArrivo.via || "";
        const cap = filArrivo.cap || "";
        const citta = filArrivo.localita || filArrivo.citta || "";
        const prov = filArrivo.provincia || "";
        if(ragSoc || via) {
          punto_info = [ragSoc, via, [cap, citta, prov?'('+prov+')':''].filter(Boolean).join(' ')].filter(Boolean).join(", ").trim();
        }
        // Fallback: usa filiale_arrivo stringa da dati_spedizione
        if(!punto_info && spedizione.filiale_arrivo) {
          punto_info = spedizione.filiale_arrivo;
        }
        // Fallback: cerca nell'ultimo evento
        if(!punto_info && ultimoEvento) {
          const fe = ultimoEvento.filiale || ultimoEvento.filiale_evento || {};
          if(fe && Object.keys(fe).length) {
            punto_info = [fe.ragione_sociale||fe.descrizione, fe.indirizzo, (fe.cap||'')+' '+(fe.localita||fe.citta||'')].filter(Boolean).join(", ").trim();
          }
          if(!punto_info) punto_info = ultimoEvento.filiale_string || ultimoEvento.sede || "";
        }
        console.log("[BRT FERMOPOINT] punto_info:", punto_info);
        console.log("[BRT FERMOPOINT] dati_spedizione keys:", Object.keys(spedizione).join(","));
      } catch(pe) { console.log("[BRT FERMOPOINT] punto_info error:", pe.message); }
      
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

  // ── ARCHIVIO BOLLE ──────────────────────────────────────────────────────
  const CORS_BOLLE = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS'};
  const GH_BOLLE_INDEX = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/bolle-index.json';
  const GH_BOLLE_FILES_BASE = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/bolle/';

  async function ghBolleIndexGet() {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return { data: [], sha: null };
    const r = await fetch(GH_BOLLE_INDEX, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
    if (r.status === 404) return { data: [], sha: null };
    const j = await r.json();
    return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g,''),'base64').toString('utf8')), sha: j.sha };
  }

  async function ghBolleIndexSave(data, sha) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    const body = { message: 'update bolle-index', content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    const r = await fetch(GH_BOLLE_INDEX, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text(); throw new Error('GitHub index save error: '+t); }
  }

  async function ghBollePdfSave(filename, base64data) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) throw new Error('GH_TOKEN non configurato');
    // Check if file exists to get SHA
    let sha = null;
    const chk = await fetch(GH_BOLLE_FILES_BASE+filename, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
    if (chk.ok) { const j = await chk.json(); sha = j.sha; }
    const body = { message: 'add bolla pdf '+filename, content: base64data };
    if (sha) body.sha = sha;
    const r = await fetch(GH_BOLLE_FILES_BASE+filename, { method: 'PUT', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text(); throw new Error('GitHub pdf save error: '+t.substring(0,200)); }
    const j = await r.json();
    return j.content ? j.content.download_url : null;
  }

  async function ghBollePdfDelete(filename) {
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return;
    const chk = await fetch(GH_BOLLE_FILES_BASE+filename, { headers: { 'Authorization': 'token '+ghToken, 'Accept': 'application/vnd.github.v3+json' } });
    if (!chk.ok) return;
    const j = await chk.json();
    await fetch(GH_BOLLE_FILES_BASE+filename, { method: 'DELETE', headers: { 'Authorization': 'token '+ghToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'delete bolla '+filename, sha: j.sha }) });
  }

  if (req.url === '/bolle-index' && req.method === 'OPTIONS') { res.writeHead(200, CORS_BOLLE); res.end(); return; }
  if (req.url === '/bolle-index' && req.method === 'GET') {
    try { const { data } = await ghBolleIndexGet(); res.writeHead(200, CORS_BOLLE); res.end(JSON.stringify(data)); }
    catch(e) { console.error('[BOLLE GET]', e.message); res.writeHead(200, CORS_BOLLE); res.end('[]'); }
    return;
  }
  if (req.url === '/bolle-index' && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      // payload: { bolle: [...array completo aggiornato] }
      const { sha } = await ghBolleIndexGet();
      await ghBolleIndexSave(payload.bolle, sha);
      res.writeHead(200, CORS_BOLLE); res.end(JSON.stringify({ ok: true }));
    } catch(e) { console.error('[BOLLE POST]', e.message); res.writeHead(500, CORS_BOLLE); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }
  if (req.url.startsWith('/bolle-pdf') && req.method === 'OPTIONS') { res.writeHead(200, CORS_BOLLE); res.end(); return; }
  if (req.url.startsWith('/bolle-pdf') && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      // payload: { filename: 'bolla_xxx.pdf', base64: '...' }
      const downloadUrl = await ghBollePdfSave(payload.filename, payload.base64);
      res.writeHead(200, CORS_BOLLE); res.end(JSON.stringify({ ok: true, url: downloadUrl }));
    } catch(e) { console.error('[BOLLE PDF POST]', e.message); res.writeHead(500, CORS_BOLLE); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }
  if (req.url.startsWith('/bolle-pdf/') && req.method === 'DELETE') {
    const filename = decodeURIComponent(req.url.replace('/bolle-pdf/', ''));
    try {
      await ghBollePdfDelete(filename);
      // Rimuovi anche dall'indice
      const { data, sha } = await ghBolleIndexGet();
      const updated = data.filter(b => b.filename !== filename);
      await ghBolleIndexSave(updated, sha);
      res.writeHead(200, CORS_BOLLE); res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500, CORS_BOLLE); res.end(JSON.stringify({ ok: false, error: e.message })); }
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


     // ── ESTENSIONE TEMU V3: Ricerca ordine Shopify da numero Temu ────
  // Replica esatta della logica del HelpDesk (fetchShopifyOrder + findInNoteAttributes + scanAllOrders)
  if (req.url.startsWith('/find-shopify-by-temu')) {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
      res.end(); return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, CORS);
      res.end(JSON.stringify({error:'Method not allowed'}));
      return;
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const orderTemu = (url.searchParams.get('orderTemu') || '').trim();
 
      if (!orderTemu) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({error:'Param orderTemu richiesto'}));
        return;
      }
      if (!/^PO-\d{3}-\d+/.test(orderTemu)) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({error:'orderTemu non valido. Atteso formato: PO-098-...'}));
        return;
      }
 
      console.log('[find-shopify-by-temu] Cerco ordine Temu:', orderTemu);
 
      const shopifyToken = await getShopifyToken();
      if (!shopifyToken || !SHOPIFY_SHOP) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({error:'SHOPIFY_SHOP o SHOPIFY_TOKEN non configurati'}));
        return;
      }
 
      // ─── Replica esatta della logica HelpDesk ───────────────────
      const temuKeys = ["PARENT_ORDER_SN", "Temu Order Id", "temu_order_id", "order_id", "Marketplace Order Id"];
 
      // Helper: cerca match esatto in note_attributes (come fa HelpDesk)
      function findInNoteAttributes(orders, keys, value) {
        if (!orders) return null;
        const val = (value || "").trim().toLowerCase();
        if (!val) return null;
        return orders.find(o => (o.note_attributes || []).some(a => {
          const aval = String(a.value || "").trim().toLowerCase();
          const aname = String(a.name || "").trim().toLowerCase();
          return (keys.some(k => aname === k.toLowerCase())) && (aval === val);
        })) || null;
      }
 
      // Helper: shopifyGet con token cached
      async function shopifyGet(qs) {
        const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/${qs}`, {
          headers: {'X-Shopify-Access-Token': shopifyToken}
        });
        if (!r.ok) {
          console.warn('[find-shopify-by-temu] Shopify error', r.status, qs.substring(0, 100));
          return null;
        }
        const d = await r.json();
        // Estrai page_info da Link header se presente
        const linkHeader = r.headers.get('link') || '';
        const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>; rel="next"/);
        if (nextMatch) d._nextPageInfo = nextMatch[1];
        return d;
      }
 
      // Step 2a — Full-text search (come HelpDesk)
      let order = null;
      console.log('[find-shopify-by-temu] Step 2a: full-text search');
      const dFt = await shopifyGet('orders.json?status=any&limit=10&query=' + encodeURIComponent(orderTemu));
      if (dFt && dFt.orders && dFt.orders.length) {
        order = findInNoteAttributes(dFt.orders, temuKeys, orderTemu);
        if (order) console.log('[find-shopify-by-temu] ✅ Trovato via full-text');
      }
 
      // Step 2b — Scan paginato completo (come HelpDesk, max 40 pagine = 10000 ordini)
      if (!order) {
        console.log('[find-shopify-by-temu] Step 2b: scan paginato completo');
        let page_info = null;
        for (let page = 0; page < 40; page++) {
          const qs = 'orders.json?status=any&limit=250' + (page_info ? '&page_info=' + page_info : '');
          const d = await shopifyGet(qs);
          if (!d || !d.orders || !d.orders.length) {
            console.log('[find-shopify-by-temu] Fine ordini a pagina', page+1);
            break;
          }
          console.log('[find-shopify-by-temu] Scan pagina', page+1, '— ordini:', d.orders.length);
          const found = findInNoteAttributes(d.orders, temuKeys, orderTemu);
          if (found) {
            order = found;
            console.log('[find-shopify-by-temu] ✅ Trovato a pagina', page+1);
            break;
          }
          page_info = d._nextPageInfo || null;
          if (!page_info) {
            console.log('[find-shopify-by-temu] Nessuna pagina successiva dopo', page+1);
            break;
          }
        }
      }
 
      if (!order) {
        console.log('[find-shopify-by-temu] ❌ Ordine non trovato');
        res.writeHead(404, CORS);
        res.end(JSON.stringify({error:'Ordine non trovato in Shopify', orderTemu: orderTemu}));
        return;
      }
 
      // ─── Estrazione dati ─────────────────────────────────────────
      const result = {
        orderTemu: orderTemu,
        orderShopify: {
          id: order.id,
          name: order.name || '',
          created_at: order.created_at || '',
          currency: order.currency || 'EUR'
        },
        customer: { name: '', email: '', phone: '' },
        items: [],
        total: parseFloat(order.total_price || 0).toFixed(2),
        shipping: {
          address: '', city: '', zip: '', country: '',
          tracking_number: '', tracking_company: '',
          shipment_status: null,
          ready_for_pickup: false,
          delivered: false
        }
      };
 
      if (order.customer) {
        const fn = order.customer.first_name || '';
        const ln = order.customer.last_name || '';
        result.customer.name = (fn + ' ' + ln).trim();
        result.customer.email = order.customer.email || '';
        result.customer.phone = order.customer.phone || '';
      }
      if (!result.customer.name && order.shipping_address) {
        const sn = (order.shipping_address.first_name || '') + ' ' + (order.shipping_address.last_name || '');
        result.customer.name = sn.trim();
      }
 
      for (const item of (order.line_items || [])) {
        result.items.push({
          title: item.title || item.name || 'Prodotto',
          sku: item.sku || '',
          quantity: item.quantity || 1,
          price: parseFloat(item.price || 0).toFixed(2)
        });
      }
 
      if (order.shipping_address) {
        const a = order.shipping_address;
        result.shipping.address = [a.address1, a.address2].filter(Boolean).join(' ');
        result.shipping.city = a.city || '';
        result.shipping.zip = a.zip || '';
        result.shipping.country = a.country || '';
      }
 
      if (order.fulfillments && order.fulfillments.length > 0) {
        const f = order.fulfillments[0];
        result.shipping.tracking_number = f.tracking_number || '';
        result.shipping.tracking_company = f.tracking_company || 'BRT';
        result.shipping.shipment_status = f.shipment_status || null;
        if (f.shipment_status === 'ready_for_pickup') result.shipping.ready_for_pickup = true;
        if (f.shipment_status === 'delivered') result.shipping.delivered = true;
      }
 
      if (!result.shipping.tracking_number) {
        for (const attr of (order.note_attributes || [])) {
          if (/tracking|spedizione|nspediz/i.test(attr.name) && attr.value) {
            result.shipping.tracking_number = String(attr.value);
            break;
          }
        }
      }
 
      console.log('[find-shopify-by-temu] OK:', result.orderShopify.name, 'cliente:', result.customer.name, 'status:', result.shipping.shipment_status);
 
      res.writeHead(200, Object.assign({}, CORS, {'Cache-Control':'private, max-age=60'}));
      res.end(JSON.stringify(result));
      return;
 
    } catch(e) {
      console.error('[find-shopify-by-temu] errore:', e.message);
      res.writeHead(500, {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message}));
      return;
    }
  }
  // ── FINE ESTENSIONE TEMU V3 ──────────────────────────────────────

    // ── ESTENSIONE TEMU V3: Genera risposta AI per chat acquirente ────
  // Endpoint pubblico (non richiede x-app-token) che internamente chiama Anthropic.
  // Riceve: { system: string, userMsg: string }
  // Restituisce: { reply: string } oppure { error: string }
  if (req.url === '/temu-generate-reply') {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
      res.end(); return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, CORS);
      res.end(JSON.stringify({error:'Method not allowed'}));
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async function(){
      try {
        if (!ANTHROPIC_KEY) {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({error:'ANTHROPIC_KEY non configurata'}));
          return;
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const { system, userMsg, max_tokens, model } = payload;
        if (!system || !userMsg) {
          res.writeHead(400, CORS);
          res.end(JSON.stringify({error:'Campi obbligatori: system, userMsg'}));
          return;
        }
        console.log('[temu-generate-reply] system:', system.length, 'char | userMsg:', userMsg.length, 'char');
 
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': ANTHROPIC_KEY
          },
          body: JSON.stringify({
            model: model || 'claude-sonnet-4-5',
            max_tokens: max_tokens || 1000,
            system: system,
            messages: [{ role: 'user', content: userMsg }]
          })
        });
 
        if (!aiRes.ok) {
          const errText = await aiRes.text();
          console.error('[temu-generate-reply] Anthropic error', aiRes.status, errText.substring(0, 200));
          res.writeHead(aiRes.status, CORS);
          res.end(JSON.stringify({error: 'Anthropic ' + aiRes.status, detail: errText.substring(0, 300)}));
          return;
        }
 
        const aiData = await aiRes.json();
        const reply = aiData.content && aiData.content[0] && aiData.content[0].text;
        if (!reply || !reply.trim()) {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({error:'Risposta AI vuota'}));
          return;
        }
 
        console.log('[temu-generate-reply] OK:', reply.length, 'char');
        res.writeHead(200, CORS);
        res.end(JSON.stringify({
          reply: reply.trim(),
          usage: aiData.usage || null
        }));
      } catch(e) {
        console.error('[temu-generate-reply] errore:', e.message);
        res.writeHead(500, {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'});
        res.end(JSON.stringify({error: e.message}));
      }
    });
    req.on('error', function(err){
      console.error('[temu-generate-reply] req error:', err.message);
      try {
        res.writeHead(500, {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'});
        res.end(JSON.stringify({error: err.message}));
      } catch(_) {}
    });
    return;
  }
  // ── FINE TEMU V3 GENERATE ────────────────────────────────────────

    // ── ESTENSIONE TEMU V3: Wrapper Shopify pubblico per estensione ────
  // Endpoint pubblico (no x-app-token) per chiamate Shopify dall'estensione.
  // Path: /temu-shopify/<resource>?<query>
  // Es: /temu-shopify/orders/12345.json?fields=id,name
  if (req.url.startsWith('/temu-shopify/')) {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
      res.end(); return;
    }
    try {
      const shopifyPath = req.url.replace('/temu-shopify/', '');
      const shopifyToken = await getShopifyToken();
      if (!shopifyToken || !SHOPIFY_SHOP) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({error:'SHOPIFY_SHOP o SHOPIFY_TOKEN non configurati'}));
        return;
      }
      const targetUrl = 'https://' + SHOPIFY_SHOP + '/admin/api/2024-01/' + shopifyPath;
      console.log('[temu-shopify]', req.method, targetUrl.substring(0, 200));
 
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async function(){
        try {
          const bodyBuffer = Buffer.concat(chunks);
          const fetchOpts = {
            method: req.method,
            headers: {
              'X-Shopify-Access-Token': shopifyToken,
              'Content-Type': 'application/json'
            }
          };
          if (bodyBuffer.length > 0 && req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOpts.body = bodyBuffer.toString();
          }
          const sr = await fetch(targetUrl, fetchOpts);
          const text = await sr.text();
          // Forza CORS
          const headers = Object.assign({}, CORS);
          if (sr.status === 401) {
            console.error('[temu-shopify] 401 — Shopify token invalido');
          }
          res.writeHead(sr.status, headers);
          res.end(text);
        } catch(e2) {
          console.error('[temu-shopify] errore:', e2.message);
          res.writeHead(500, CORS);
          res.end(JSON.stringify({error: e2.message}));
        }
      });
      req.on('error', function(err){
        console.error('[temu-shopify] req error:', err.message);
        try {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({error: err.message}));
        } catch(_) {}
      });
    } catch(e) {
      console.error('[temu-shopify] errore:', e.message);
      res.writeHead(500, CORS);
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }
  // ── FINE TEMU V3 SHOPIFY WRAPPER ──────────────────────────────────
 
 
  // ── ESTENSIONE TEMU V3: Wrapper BRT ORM pubblico per estensione ────
  // Endpoint pubblico (no x-app-token) per prenotazione ritiri BRT.
  if (req.url.startsWith('/temu-brt-orm/')) {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
      res.end(); return;
    }
    try {
      const brtPath = req.url.replace('/temu-brt-orm/', '');
      const targetUrl = 'https://api.brt.it/orm/' + brtPath;
      const brtApiKey = process.env.BRT_API_KEY || 'f393e3d3-8402-4614-a90e-8d111fa73ced';
      console.log('[temu-brt-orm]', req.method, targetUrl.substring(0, 200));
 
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async function(){
        try {
          const bodyBuffer = Buffer.concat(chunks);
          const fetchOpts = {
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Key': brtApiKey
            }
          };
          if (bodyBuffer.length > 0 && req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOpts.body = bodyBuffer.toString();
          }
          const br = await fetch(targetUrl, fetchOpts);
          const text = await br.text();
          res.writeHead(br.status, CORS);
          res.end(text);
        } catch(e2) {
          console.error('[temu-brt-orm] errore:', e2.message);
          res.writeHead(500, CORS);
          res.end(JSON.stringify({error: e2.message}));
        }
      });
      req.on('error', function(err){
        console.error('[temu-brt-orm] req error:', err.message);
        try {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({error: err.message}));
        } catch(_) {}
      });
    } catch(e) {
      console.error('[temu-brt-orm] errore:', e.message);
      res.writeHead(500, CORS);
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }
  // ── FINE TEMU V3 BRT ORM WRAPPER ──────────────────────────────────
 
  
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
  if (req.url.startsWith('/filippo-data')) {
    const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    if (req.method === 'OPTIONS') { res.writeHead(200,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,x-app-token'}); res.end(); return; }
    if (req.method === 'GET') {
      try {
        const { data } = await ghFilippoGet();
        const qs = req.url.split('?')[1] || '';
        const params = new URLSearchParams(qs);
        const key = params.get('key');
        if (key && data && data[key] !== undefined) {
          res.writeHead(200,CORS); res.end(JSON.stringify({value: data[key]}));
        } else {
          res.writeHead(200,CORS); res.end(JSON.stringify(data||{}));
        }
      }
      catch(e) { res.writeHead(200,CORS); res.end(JSON.stringify({})); }
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; req.on('data',c=>chunks.push(c));
      req.on('end', async function(){
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          // Se ha key+value salva come chiave specifica nell'oggetto filippo-data
          if (parsed.key && parsed.value !== undefined) {
            let retries = 3;
            while (retries-- > 0) {
              try {
                const { data: existing, sha } = await ghFilippoGet();
                const updated = Object.assign({}, existing||{});
                updated[parsed.key] = parsed.value;
                await ghFilippoSave(updated, sha);
                break;
              } catch(e2) { if (retries === 0) throw e2; await new Promise(r => setTimeout(r, 300)); }
            }
          } else {
            // Salva intero oggetto (backward compat)
            let retries = 3;
            while (retries-- > 0) {
              try { const { sha } = await ghFilippoGet(); await ghFilippoSave(parsed, sha); break; }
              catch(e2) { if (retries === 0) throw e2; await new Promise(r => setTimeout(r, 300)); }
            }
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
    // Se riceviamo 401 su Shopify, forza rinnovo token al prossimo tentativo
    const origShopifyPath = p;
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
        if (proxyRes.statusCode === 401) { _shopifyToken = null; _shopifyTokenExpiresAt = 0; console.log('[SHOPIFY] 401 → token resettato per rinnovo'); }
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


// ════════════════════════════════════════════════════════════════════
// ── SMTP IONOS — invio email ordini fornitori ──────────────────────
// ════════════════════════════════════════════════════════════════════
let _smtpTransporter = null;
function getSmtpTransporter() {
  if (_smtpTransporter) return _smtpTransporter;
  try {
    const nodemailer = require('nodemailer');
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    if (!smtpUser || !smtpPass) {
      console.log('[SMTP] SMTP_USER o SMTP_PASS non configurate');
      return null;
    }
    _smtpTransporter = nodemailer.createTransport({
      host: 'smtp.ionos.it',
      port: 465,
      secure: true,
      auth: { user: smtpUser, pass: smtpPass }
    });
    _smtpTransporter.verify(function(err){
      if (err) console.error('[SMTP] Verifica fallita:', err.message);
      else console.log('[SMTP] Pronto per inviare email da', smtpUser);
    });
    return _smtpTransporter;
  } catch(e) {
    console.error('[SMTP] nodemailer non disponibile:', e.message);
    return null;
  }
}
setTimeout(() => { getSmtpTransporter(); }, 5000);

// Intercetta richieste /send-email PRIMA del proxy generico.
// Uso un "wrapper" su server.emit che controlla solo /send-email
// e lascia passare tutto il resto invariato.
const _originalEmit = server.emit.bind(server);
server.emit = function(eventName, req, res) {
  if (eventName !== 'request' || !req || !req.url) {
    return _originalEmit.apply(server, arguments);
  }
  if (req.url !== '/send-email') {
    return _originalEmit.apply(server, arguments);
  }
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-app-token'
    });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'});
    res.end(JSON.stringify({ok:false, error:'Method not allowed'}));
    return;
  }
  const CORS_SE = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  const transporter = getSmtpTransporter();
  if (!transporter) {
    res.writeHead(500, CORS_SE);
    res.end(JSON.stringify({ok:false, error:'SMTP non configurato. Verifica SMTP_USER e SMTP_PASS nelle env variables di Render.'}));
    return;
  }
  const chunksSE = [];
  req.on('data', c => chunksSE.push(c));
  req.on('end', async function(){
    try {
      const payload = JSON.parse(Buffer.concat(chunksSE).toString() || '{}');
      const { to, cc, subject, body, orderId, fornitore, attachments } = payload;
      if (!to || !subject || !body) {
        res.writeHead(400, CORS_SE);
        res.end(JSON.stringify({ok:false, error:'Campi obbligatori: to, subject, body'}));
        return;
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(to)) {
        res.writeHead(400, CORS_SE);
        res.end(JSON.stringify({ok:false, error:'Indirizzo "to" non valido'}));
        return;
      }
      let ccList = [];
      if (cc) {
        ccList = String(cc).split(/[,;]/).map(s => s.trim()).filter(Boolean);
        for (const addr of ccList) {
          if (!emailRegex.test(addr)) {
            res.writeHead(400, CORS_SE);
            res.end(JSON.stringify({ok:false, error:'Indirizzo CC non valido: '+addr}));
            return;
          }
        }
      }
      const smtpUser = process.env.SMTP_USER;
      const smtpFromName = process.env.SMTP_FROM_NAME || 'Yespresso';
      const info = await transporter.sendMail({
        from: `"${smtpFromName}" <${smtpUser}>`,
        to: to,
        cc: ccList.length ? ccList.join(', ') : undefined,
        subject: subject,
        text: body,
      attachments: Array.isArray(attachments) ? attachments.map(function(a){
        return {
          filename: a.filename || 'allegato',
          content: a.content || '',
          encoding: a.encoding || 'base64',
          contentType: a.contentType || 'application/octet-stream'
        };
      }) : undefined
    });
      console.log(`[send-email] OK a ${to}${cc?' cc:'+cc:''} — ord:${orderId||'?'} — forn:${fornitore||'?'} — msgId:${info.messageId}`);
      res.writeHead(200, CORS_SE);
      res.end(JSON.stringify({
        ok: true,
        messageId: info.messageId,
        to: to,
        cc: ccList.join(', ') || null,
        sentAt: new Date().toISOString()
      }));
    } catch(err) {
      console.error('[send-email] Errore:', err.message);
      res.writeHead(500, CORS_SE);
      res.end(JSON.stringify({ok:false, error: err.message}));
    }
  });
  req.on('error', function(err){
    console.error('[send-email] Errore request:', err.message);
    try {
      res.writeHead(500, CORS_SE);
      res.end(JSON.stringify({ok:false, error: err.message}));
    } catch(e2) {}
  });
};
console.log('[SMTP] Endpoint /send-email registrato');
// ════════════════════════════════════════════════════════════════════════
// CONTESTAZIONI PRODOTTO — endpoint /contestazioni GET / POST
// ════════════════════════════════════════════════════════════════════════

const GH_CONTEST_URL = 'https://api.github.com/repos/yespresso80/yespresso-proxy/contents/contestazioni-data.json';

async function ghContestGet() {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return { data: [], sha: null };
  const r = await fetch(GH_CONTEST_URL, {
    headers: {
      'Authorization': 'token ' + ghToken,
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  if (r.status === 404) return { data: [], sha: null };
  const j = await r.json();
  return {
    data: JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8')),
    sha: j.sha
  };
}

async function ghContestSave(data, sha) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN non configurato');
  const body = {
    message: 'update contestazioni',
    content: Buffer.from(JSON.stringify(data)).toString('base64')
  };
  if (sha) body.sha = sha;
  const r = await fetch(GH_CONTEST_URL, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + ghToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error('GitHub PUT contestazioni: ' + (err.message || r.status));
  }
}

const _origEmitContest = server.emit.bind(server);
server.emit = function(eventName, req, res) {
  if (eventName !== 'request' || !req || !req.url) {
    return _origEmitContest.apply(server, arguments);
  }
  if (req.url !== '/contestazioni') {
    return _origEmitContest.apply(server, arguments);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-app-token'
    });
    res.end();
    return;
  }
  const CORS_CT = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'GET') {
    (async function() {
      try {
        const { data } = await ghContestGet();
        res.writeHead(200, CORS_CT);
        res.end(JSON.stringify(data));
      } catch(e) {
        console.error('[CONTEST GET]', e.message);
        res.writeHead(200, CORS_CT);
        res.end('[]');
      }
    })();
    return;
  }
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async function() {
      try {
        const newData = JSON.parse(Buffer.concat(chunks).toString() || '[]');
        const { sha } = await ghContestGet();
        await ghContestSave(Array.isArray(newData) ? newData : [], sha);
        res.writeHead(200, CORS_CT);
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[CONTEST POST]', e.message);
        res.writeHead(500, CORS_CT);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    req.on('error', function(err) {
      console.error('[CONTEST POST] req error:', err.message);
      try {
        res.writeHead(500, CORS_CT);
        res.end(JSON.stringify({ ok: false, error: err.message }));
      } catch(_) {}
    });
    return;
  }
  res.writeHead(405, CORS_CT);
  res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
};

console.log('[CONTEST] Endpoint /contestazioni registrato');
