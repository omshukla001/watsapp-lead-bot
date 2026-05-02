const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'app.log');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function write(level, msg) {
  if (LEVELS[level] < CURRENT) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  // eslint-disable-next-line no-console
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
}

module.exports = {
  debug: (m) => write('debug', m),
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
};
