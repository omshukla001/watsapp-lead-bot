const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const logger = require('../utils/logger');
const { processMessage, markHumanHandoff } = require('../controllers/chatController');

const AUTH_DIR = path.join(__dirname, '..', 'auth');
const SILENT_LOGGER = pino({ level: 'silent' });

let sock = null;

// Strip a JID like "919876543210@s.whatsapp.net" or "919876543210:5@s.whatsapp.net"
// down to "+919876543210". Returns "" if the input doesn't end in s.whatsapp.net
// (so @lid identifiers don't get treated as phone numbers).
function jidToPhone(jid) {
  if (!jid || typeof jid !== 'string') return '';
  if (!jid.endsWith('@s.whatsapp.net')) return '';
  const local = jid.split('@')[0].split(':')[0];
  return local ? `+${local}` : '';
}

// Extract the REAL E.164 phone number from a Baileys message.
// Handles both legacy @s.whatsapp.net JIDs and the new @lid (Linked Identifier)
// format that WhatsApp now uses for some users. With LIDs, the phone is in a
// secondary field — try several known field names in order.
function extractRealPhone(msg) {
  if (!msg || !msg.key) return '';
  const k = msg.key;

  // 1. Direct remoteJid is a phone JID (most common case)
  let phone = jidToPhone(k.remoteJid);
  if (phone) return phone;

  // 2. Newer Baileys: remoteJidAlt carries the phone JID when remoteJid is @lid
  phone = jidToPhone(k.remoteJidAlt);
  if (phone) return phone;

  // 3. Sender phone JID (newer)
  phone = jidToPhone(k.senderPn || msg.senderPn);
  if (phone) return phone;

  // 4. Participant phone JID (newer, for LID-based 1-on-1 chats)
  phone = jidToPhone(k.participantPn || msg.participantPn);
  if (phone) return phone;

  // 5. Plain participant (common in groups, also sometimes in LID 1-on-1)
  phone = jidToPhone(k.participant || msg.participant);
  if (phone) return phone;

  return '';
}

const { isValidWhatsAppPhone } = require('../utils/phone');

function extractText(message) {
  if (!message) return '';
  // Tappable replies come back through different fields depending on type
  const buttonsResp = message.buttonsResponseMessage?.selectedDisplayText
    || message.buttonsResponseMessage?.selectedButtonId;
  const listResp = message.listResponseMessage?.title
    || message.listResponseMessage?.singleSelectReply?.selectedRowId;
  const interactiveResp = message.templateButtonReplyMessage?.selectedDisplayText
    || message.interactiveResponseMessage?.body?.text;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    buttonsResp ||
    listResp ||
    interactiveResp ||
    ''
  ).trim();
}

const EMOJI_DIGITS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function numberPrefix(i) {
  return EMOJI_DIGITS[i] || `${i + 1}.`;
}

function buildOptionText(reply, options) {
  if (!options || options.length === 0) return reply;
  const numbered = options.map((o, i) => `${numberPrefix(i)}  ${o}`).join('\n');
  return `${reply}\n\n${numbered}\n\n_Reply with a number or type your own answer_`;
}

// Last 200 message IDs the bot sent — used to distinguish bot's own outbound
// messages (echoed back via fromMe) from messages a human typed in WhatsApp.
const BOT_SENT_IDS = new Set();
const BOT_SENT_MAX = 200;

function rememberSentId(id) {
  if (!id) return;
  BOT_SENT_IDS.add(id);
  if (BOT_SENT_IDS.size > BOT_SENT_MAX) {
    // delete oldest insertion (Sets preserve insertion order)
    const first = BOT_SENT_IDS.values().next().value;
    BOT_SENT_IDS.delete(first);
  }
}

async function sendReply(jid, reply, options) {
  if (!sock) return;
  const text = buildOptionText(reply, options);
  const sent = await sock.sendMessage(jid, { text });
  rememberSentId(sent?.key?.id);
}

async function startBaileys() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info(`Baileys starting (WA version ${version.join('.')})`);

  // PAIR_PHONE_NUMBER set → use pairing-code flow (better on Termux than QR)
  const pairPhone = (process.env.PAIR_PHONE_NUMBER || '').replace(/\D/g, '');
  const usePairingCode = !!pairPhone && !state.creds.registered;

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['WhatsApp Lead Bot', 'Chrome', '1.0.0'],
    logger: SILENT_LOGGER,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Request pairing code right after socket init if PAIR_PHONE_NUMBER is set
  if (usePairingCode) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairPhone);
        const formatted = code.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n========================================');
        console.log('  PAIRING CODE METHOD (no QR needed)');
        console.log('========================================');
        console.log('  1. Open WhatsApp on phone ' + pairPhone);
        console.log('  2. Settings → Linked Devices → Link a Device');
        console.log('  3. Tap "Link with phone number instead"');
        console.log('  4. Enter this code:');
        console.log('');
        console.log('         ' + formatted);
        console.log('');
        console.log('  (Code expires in ~60 seconds)');
        console.log('========================================\n');
      } catch (e) {
        logger.error(`Pairing code request failed: ${e.message}. Falling back to QR.`);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      console.log('\n========================================');
      console.log('  Scan this QR with WhatsApp on your phone');
      console.log('  WhatsApp -> Settings -> Linked Devices -> Link a Device');
      console.log('  (Or use pairing code: set PAIR_PHONE_NUMBER in .env)');
      console.log('========================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('Baileys connected to WhatsApp');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      logger.warn(`Baileys disconnected (code=${code}). loggedOut=${loggedOut}`);
      if (loggedOut) {
        logger.error('Session logged out. Delete the "auth" folder and restart to re-link.');
        return;
      }
      setTimeout(() => {
        startBaileys().catch((e) => logger.error(`Reconnect failed: ${e.message}`));
      }, 3000);
    }
  });

  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return;

    for (const msg of event.messages || []) {
      try {
        if (!msg.message) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;
        if (jid === 'status@broadcast') continue;
        if (jid.endsWith('@g.us')) continue;
        if (jid.endsWith('@newsletter')) continue;

        // fromMe = either the bot's own outbound (echo) OR a human typed in WhatsApp
        if (msg.key.fromMe) {
          if (BOT_SENT_IDS.has(msg.key.id)) {
            // Bot's own message coming back through the upsert stream — ignore
            continue;
          }
          // Human typed this message in WhatsApp directly — mark handoff for this jid
          const phone = extractRealPhone(msg);
          if (!phone) {
            logger.warn(`Could not extract phone for human-handoff message. key=${JSON.stringify(msg.key)}`);
            continue;
          }
          const text = extractText(msg.message);
          logger.info(`👤 Human took over [${phone}]: ${text.slice(0, 80)}`);
          try {
            await markHumanHandoff(phone, text);
          } catch (e) {
            logger.error(`markHumanHandoff failed for ${phone}: ${e.message}`);
          }
          continue;
        }

        const text = extractText(msg.message);
        if (!text) continue;

        const phone = extractRealPhone(msg);
        if (!phone) {
          // Couldn't find a real phone in any field — log details once and skip
          logger.warn(
            `Could not extract real phone from incoming message. ` +
            `remoteJid=${jid} key=${JSON.stringify(msg.key)}`
          );
          continue;
        }

        logger.info(`WA IN [${phone}]: ${text}`);

        try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}

        let result = null;
        try {
          result = await processMessage(phone, text);
        } catch (procErr) {
          logger.error(`processMessage failed for ${phone}: ${procErr.message}`);
          result = { reply: 'Sorry, something went wrong on my side. Could you try again?', options: [] };
        }

        try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}

        const reply = result?.reply || '';
        const options = result?.options || [];
        if (reply) {
          await sendReply(jid, reply, options);
          logger.info(`WA OUT [${phone}]: ${reply.replace(/\n/g, ' | ')}`);
        }
      } catch (err) {
        logger.error(`Baileys message handler error: ${err.stack || err.message}`);
      }
    }
  });

  return sock;
}

function getSocket() {
  return sock;
}

module.exports = { startBaileys, getSocket, sendReply, isValidWhatsAppPhone };
