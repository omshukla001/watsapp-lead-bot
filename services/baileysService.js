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
const { processMessage } = require('../controllers/chatController');

const AUTH_DIR = path.join(__dirname, '..', 'auth');
const SILENT_LOGGER = pino({ level: 'silent' });

let sock = null;

function jidToPhone(jid) {
  const local = (jid || '').split('@')[0].split(':')[0];
  return local ? `+${local}` : '';
}

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

async function sendReply(jid, reply, options) {
  if (!sock) return;
  const text = buildOptionText(reply, options);
  await sock.sendMessage(jid, { text });
}

async function startBaileys() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info(`Baileys starting (WA version ${version.join('.')})`);

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

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n========================================');
      console.log('  Scan this QR with WhatsApp on your phone');
      console.log('  WhatsApp -> Settings -> Linked Devices -> Link a Device');
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
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;
        if (jid === 'status@broadcast') continue;
        if (jid.endsWith('@g.us')) continue;
        if (jid.endsWith('@newsletter')) continue;

        const text = extractText(msg.message);
        if (!text) continue;

        const phone = jidToPhone(jid);
        if (!phone) continue;

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

module.exports = { startBaileys, getSocket, sendReply };
