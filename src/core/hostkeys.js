'use strict';
// Host-Schlüssel prüfen (Trust on first use): beim ersten Verbinden Fingerabdruck zeigen und merken,
// bei Abweichung Verbindung abbrechen und deutlich warnen (möglicher Man-in-the-Middle).

const crypto = require('node:crypto');
const fs = require('node:fs');

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

/** Schlüsseltyp aus dem SSH-Wire-Format („ssh-ed25519“, „ssh-rsa“ …). */
function keyType(keyBuf) {
  try {
    const len = keyBuf.readUInt32BE(0);
    if (len > 0 && len < 64) return keyBuf.subarray(4, 4 + len).toString('ascii');
  } catch { /* zu kurz */ }
  return 'unbekannt';
}

class HostKeyStore {
  constructor(file) {
    this.file = file;
    try { this.keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.keys = {}; }
  }

  id(host, port) { return `${host}:${port}`; }

  /** @returns {'known'|'new'|'changed'} */
  check(host, port, keyBuf) {
    const known = this.keys[this.id(host, port)];
    if (!known) return 'new';
    return known.fingerprint === fingerprint(keyBuf) ? 'known' : 'changed';
  }

  known(host, port) { return this.keys[this.id(host, port)] || null; }

  remember(host, port, keyBuf) {
    this.keys[this.id(host, port)] = { fingerprint: fingerprint(keyBuf), type: keyType(keyBuf), added: new Date().toISOString() };
    fs.writeFileSync(this.file, JSON.stringify(this.keys, null, 1), { mode: 0o600 });
  }

  forget(host, port) {
    delete this.keys[this.id(host, port)];
    fs.writeFileSync(this.file, JSON.stringify(this.keys, null, 1), { mode: 0o600 });
  }
}

module.exports = { HostKeyStore, fingerprint, keyType };
