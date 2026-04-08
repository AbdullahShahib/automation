const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../data/app.log');

function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
    // Keep log under 5MB
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(-500).join('\n'));
    }
  } catch {}

  if (global.broadcast) {
    global.broadcast('log', { level, message, ts: new Date().toISOString() });
  }
}

module.exports = { log };
