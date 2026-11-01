'use strict';
// Import von Sitzungen aus ~/.ssh/config und aus PuTTY (Registry-Export .reg von Windows).
// Ergebnis sind Sitzungs-Entwürfe; Passwörter werden nie importiert.

/** ~/.ssh/config → Sitzungen. Wildcard-Hosts („*“, „?“) werden übersprungen. */
function parseSshConfig(text) {
  const sessions = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s*(?:=\s*|\s+)(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      cur = null;
      for (const alias of value.split(/\s+/)) {
        if (/[*?!]/.test(alias)) continue;
        cur = { name: alias, protocol: 'ssh', host: alias, port: 22, folder: 'SSH-Config' };
        sessions.push(cur);
        break; // erster Alias genügt
      }
      continue;
    }
    if (key === 'match') { cur = null; continue; }
    if (!cur) continue;
    if (key === 'hostname') cur.host = value;
    else if (key === 'user') cur.username = value;
    else if (key === 'port' && /^\d+$/.test(value)) cur.port = Number(value);
    else if (key === 'identityfile') cur.keyPath = value;
    else if (key === 'proxyjump' && value !== 'none') cur.jump = value.split(',')[0];
  }
  return sessions;
}

const PUTTY_KEY = /^\[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\([^\]]+)\]$/i;

function unescapePutty(name) {
  return decodeURIComponent(name.replace(/%(?![0-9a-f]{2})/gi, '%25'));
}

/** PuTTY-Registry-Export (regedit „Exportieren“) → Sitzungen. Datei ist oft UTF-16 – vorher dekodieren. */
function parsePuttyReg(text) {
  const sessions = [];
  let cur = null;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(PUTTY_KEY);
    if (head) {
      const name = unescapePutty(head[1]);
      cur = name === 'Default Settings' ? null : { name, folder: 'PuTTY', _v: {} };
      if (cur) sessions.push(cur);
      continue;
    }
    if (line.startsWith('[')) { cur = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^"([^"]+)"=(?:"((?:[^"\\]|\\.)*)"|dword:([0-9a-f]{8}))$/i);
    if (kv) cur._v[kv[1]] = kv[3] !== undefined ? parseInt(kv[3], 16) : kv[2].replace(/\\(.)/g, '$1');
  }
  return sessions.map(({ _v, ...s }) => {
    const proto = String(_v.Protocol || 'ssh').toLowerCase();
    if (proto === 'serial') {
      return { ...s, protocol: 'serial', path: _v.SerialLine || '', baudRate: _v.SerialSpeed || 9600,
        dataBits: _v.SerialDataBits || 8, stopBits: _v.SerialStopHalfbits === 4 ? 2 : 1,
        parity: ['none', 'odd', 'even', 'mark', 'space'][_v.SerialParity || 0] || 'none' };
    }
    const protocol = { ssh: 'ssh', telnet: 'telnet', raw: 'raw', rlogin: 'telnet' }[proto] || 'ssh';
    const out = { ...s, protocol, host: _v.HostName || '', port: _v.PortNumber || (protocol === 'telnet' ? 23 : 22) };
    if (_v.UserName) out.username = _v.UserName;
    if (_v.PublicKeyFile) out.note = `PuTTY-Schlüssel: ${_v.PublicKeyFile} (als OpenSSH-Schlüssel exportieren)`;
    return out;
  }).filter((s) => s.protocol === 'serial' || s.host);
}

/** .reg-Datei als Text: UTF-16LE (mit BOM) oder UTF-8. */
function decodeReg(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  return buf.toString('utf8');
}

module.exports = { parseSshConfig, parsePuttyReg, decodeReg };
