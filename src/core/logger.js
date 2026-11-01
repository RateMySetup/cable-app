'use strict';
// Sitzungsprotokoll als Textdatei ohne Farbcodes: „<Ordner>/<Sitzung>-JJJJMMTT-hhmmss.log“.
// Jede Zeile beginnt mit Zeitstempel, damit sich Ausgaben später zuordnen lassen.

const fs = require('node:fs');
const path = require('node:path');
const { stripAnsi } = require('./highlight');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'sitzung';
}

class SessionLog {
  constructor(dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${safeName(name)}-${stamp()}.log`);
    this.out = fs.createWriteStream(this.file, { flags: 'a', mode: 0o600 });
    this.atLineStart = true;
    this.out.write(`# Cable-Protokoll ${name} – ${new Date().toISOString()}\n`);
  }

  write(buf) {
    const text = stripAnsi(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf));
    if (!text) return;
    const time = new Date().toTimeString().slice(0, 8);
    let out = '';
    for (const ch of text) {
      if (this.atLineStart) { out += `[${time}] `; this.atLineStart = false; }
      out += ch;
      if (ch === '\n') this.atLineStart = true;
    }
    this.out.write(out);
  }

  close() { this.out.end(`\n# Ende ${new Date().toISOString()}\n`); }
}

module.exports = { SessionLog, stamp, safeName };
