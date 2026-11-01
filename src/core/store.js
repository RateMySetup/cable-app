'use strict';
// Profile (gespeicherte Sitzungen), Gruppen, Befehlsbausteine, Hervorhebungsregeln und Einstellungen als
// JSON im App-Ordner. Passwörter liegen getrennt in secrets.json, verschlüsselt über den macOS-Schlüsselbund
// (Electron safeStorage); ohne Schlüsselbund werden keine Passwörter gespeichert.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrateRules } = require('./highlight');

const PROTOCOLS = ['ssh', 'telnet', 'raw', 'serial', 'local'];
const AUTH = ['auto', 'password', 'key', 'agent'];

// Bausteine nach dem Vorbild der Button-Bar von SecureCRT und der Snippets von Termius: nach Gruppen,
// mit Platzhaltern {{Name}} oder {{Name|Vorgabe}}, mehrzeilig für Konfigurationsblöcke.
const DEFAULT_SNIPPETS = [
  { id: 'cisco-nopage', group: 'Cisco · Start', name: 'Kein Blättern', text: 'terminal length 0\n' },
  { id: 'cisco-width', group: 'Cisco · Start', name: 'Breite 0', text: 'terminal width 0\n' },
  { id: 'cisco-ver', group: 'Cisco · Start', name: 'Version', text: 'show version | include uptime|Version|System image|Model\n' },
  { id: 'cisco-inv', group: 'Cisco · Start', name: 'Inventar', text: 'show inventory\n' },
  { id: 'cisco-env', group: 'Cisco · Start', name: 'Umgebung', text: 'show environment all\n' },
  { id: 'cisco-stack', group: 'Cisco · Start', name: 'Stack', text: 'show switch\n' },
  { id: 'cisco-brief', group: 'Cisco · Interfaces', name: 'Interfaces kurz', text: 'show ip interface brief\n' },
  { id: 'cisco-status', group: 'Cisco · Interfaces', name: 'Port-Status', text: 'show interfaces status\n' },
  { id: 'cisco-errdis', group: 'Cisco · Interfaces', name: 'err-disabled', text: 'show interfaces status err-disabled\n' },
  { id: 'cisco-int', group: 'Cisco · Interfaces', name: 'Interface …', text: 'show interfaces {{Interface|Gi1/0/1}}\n' },
  { id: 'cisco-intcfg', group: 'Cisco · Interfaces', name: 'Interface-Config …', text: 'show running-config interface {{Interface|Gi1/0/1}}\n' },
  { id: 'cisco-counters', group: 'Cisco · Interfaces', name: 'Fehlerzähler', text: 'show interfaces counters errors\n' },
  { id: 'cisco-poe', group: 'Cisco · Interfaces', name: 'PoE', text: 'show power inline\n' },
  { id: 'cisco-trans', group: 'Cisco · Interfaces', name: 'SFP-Werte', text: 'show interfaces transceiver\n' },
  { id: 'cisco-vlan', group: 'Cisco · Layer 2', name: 'VLANs', text: 'show vlan brief\n' },
  { id: 'cisco-trunk', group: 'Cisco · Layer 2', name: 'Trunks', text: 'show interfaces trunk\n' },
  { id: 'cisco-mac', group: 'Cisco · Layer 2', name: 'MAC suchen …', text: 'show mac address-table address {{MAC}}\n' },
  { id: 'cisco-macint', group: 'Cisco · Layer 2', name: 'MACs am Port …', text: 'show mac address-table interface {{Interface|Gi1/0/1}}\n' },
  { id: 'cisco-stp', group: 'Cisco · Layer 2', name: 'Spanning Tree', text: 'show spanning-tree summary\n' },
  { id: 'cisco-cdp', group: 'Cisco · Layer 2', name: 'Nachbarn (CDP)', text: 'show cdp neighbors\n' },
  { id: 'cisco-lldp', group: 'Cisco · Layer 2', name: 'Nachbarn (LLDP)', text: 'show lldp neighbors\n' },
  { id: 'cisco-etherch', group: 'Cisco · Layer 2', name: 'Port-Channel', text: 'show etherchannel summary\n' },
  { id: 'cisco-route', group: 'Cisco · Layer 3', name: 'Routing-Tabelle', text: 'show ip route\n' },
  { id: 'cisco-arp', group: 'Cisco · Layer 3', name: 'ARP', text: 'show ip arp\n' },
  { id: 'cisco-ospf', group: 'Cisco · Layer 3', name: 'OSPF-Nachbarn', text: 'show ip ospf neighbor\n' },
  { id: 'cisco-bgp', group: 'Cisco · Layer 3', name: 'BGP', text: 'show ip bgp summary\n' },
  { id: 'cisco-ping', group: 'Cisco · Layer 3', name: 'Ping …', text: 'ping {{Ziel}}\n' },
  { id: 'cisco-log', group: 'Cisco · Fehlersuche', name: 'Log', text: 'show logging | last 50\n' },
  { id: 'cisco-cpu', group: 'Cisco · Fehlersuche', name: 'CPU', text: 'show processes cpu sorted | exclude 0.00%\n' },
  { id: 'cisco-auth', group: 'Cisco · Fehlersuche', name: '802.1X-Sitzungen', text: 'show access-session\n' },
  { id: 'cisco-authint', group: 'Cisco · Fehlersuche', name: '802.1X am Port …', text: 'show access-session interface {{Interface|Gi1/0/1}} details\n' },
  { id: 'cisco-ntp', group: 'Cisco · Fehlersuche', name: 'NTP', text: 'show ntp associations\n' },
  { id: 'cisco-runinc', group: 'Cisco · Fehlersuche', name: 'Config durchsuchen …', text: 'show running-config | include {{Suchbegriff}}\n' },
  { id: 'cisco-wr', group: 'Cisco · Konfiguration', name: 'Speichern', text: 'copy running-config startup-config\n\n' },
  { id: 'cisco-accport', group: 'Cisco · Konfiguration', name: 'Access-Port …', text: 'configure terminal\ninterface {{Interface|Gi1/0/1}}\n description {{Beschreibung}}\n switchport mode access\n switchport access vlan {{VLAN}}\n spanning-tree portfast\n no shutdown\nend\n' },
  { id: 'cisco-shutnoshut', group: 'Cisco · Konfiguration', name: 'Port neu starten …', text: 'configure terminal\ninterface {{Interface|Gi1/0/1}}\n shutdown\n no shutdown\nend\n' },
  { id: 'cisco-vlanadd', group: 'Cisco · Konfiguration', name: 'VLAN anlegen …', text: 'configure terminal\nvlan {{VLAN}}\n name {{Name}}\nend\n' },
  { id: 'cisco-errrec', group: 'Cisco · Fehlersuche', name: 'err-disable-Gründe', text: 'show errdisable recovery\n' },
  { id: 'cisco-dir', group: 'Cisco · Dateien & TFTP', name: 'Flash anzeigen', text: 'dir flash:\n' },
  { id: 'cisco-tftpget', group: 'Cisco · Dateien & TFTP', name: 'Datei vom TFTP laden …', text: 'copy tftp://{{TFTP-Server}}/{{Datei}} flash:\n\n' },
  { id: 'cisco-tftpput', group: 'Cisco · Dateien & TFTP', name: 'Config auf TFTP sichern …', text: 'copy running-config tftp://{{TFTP-Server}}/{{Dateiname|switch-confg.txt}}\n\n\n' },
  { id: 'cisco-install', group: 'Cisco · Dateien & TFTP', name: 'Image installieren …', text: 'install add file flash:{{Image}} activate commit\n' },
  { id: 'nxos-brief', group: 'Cisco NX-OS', name: 'Interfaces kurz', text: 'show interface brief\n' },
  { id: 'nxos-vpc', group: 'Cisco NX-OS', name: 'vPC', text: 'show vpc brief\n' },
  { id: 'nxos-pc', group: 'Cisco NX-OS', name: 'Port-Channel', text: 'show port-channel summary\n' },
  { id: 'asa-int', group: 'Cisco ASA / FTD', name: 'Interfaces', text: 'show interface ip brief\n' },
  { id: 'asa-conn', group: 'Cisco ASA / FTD', name: 'Verbindungen zu …', text: 'show conn address {{IP}}\n' },
  { id: 'asa-tracer', group: 'Cisco ASA / FTD', name: 'Packet Tracer …', text: 'packet-tracer input {{Interface|inside}} tcp {{Quelle}} 12345 {{Ziel}} {{Port|443}}\n' },
  { id: 'asa-vpn', group: 'Cisco ASA / FTD', name: 'VPN-Sitzungen', text: 'show vpn-sessiondb summary\n' },
  { id: 'linux-df', group: 'Linux', name: 'Plattenplatz', text: 'df -h\n' },
  { id: 'linux-ip', group: 'Linux', name: 'Adressen', text: 'ip -br addr\n' },
  { id: 'linux-route', group: 'Linux', name: 'Routen', text: 'ip route\n' },
  { id: 'linux-ports', group: 'Linux', name: 'Offene Ports', text: 'ss -tulpn\n' },
];
// Bei neuen Vorgaben die Zahl erhöhen: fehlende Bausteine werden dann ergänzt, eigene bleiben unberührt.
const SNIPPETS_VERSION = 2;

const LIMITS = { name: 120, host: 255, folder: 120, note: 500, text: 4000 };

function clip(v, n) { return typeof v === 'string' ? v.slice(0, n) : undefined; }

/** Sitzung aus der Oberfläche prüfen und auf erlaubte Felder kürzen. */
function sanitizeSession(raw) {
  const s = raw || {};
  if (!PROTOCOLS.includes(s.protocol)) throw new Error('Protokoll fehlt');
  const out = {
    id: typeof s.id === 'string' && /^[a-z0-9-]{6,40}$/.test(s.id) ? s.id : crypto.randomUUID(),
    name: clip(s.name, LIMITS.name) || clip(s.host, LIMITS.name) || clip(s.path, LIMITS.name) || 'Sitzung',
    protocol: s.protocol,
    folder: clip(s.folder, LIMITS.folder) || '',
    note: clip(s.note, LIMITS.note) || '',
    color: /^#[0-9a-fA-F]{6}$/.test(s.color || '') ? s.color : '',
    log: Boolean(s.log),
    highlight: s.highlight !== false,
  };
  if (['ssh', 'telnet', 'raw'].includes(s.protocol)) {
    out.host = clip(s.host, LIMITS.host) || '';
    if (!out.host) throw new Error('Host fehlt');
    const port = Number(s.port || { ssh: 22, telnet: 23, raw: 23 }[s.protocol]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port ungültig');
    out.port = port;
  }
  // Benutzer und Passwort: SSH meldet sich damit an, Telnet und Serial antworten auf „Username:“/„Password:“.
  if (['ssh', 'telnet', 'serial'].includes(s.protocol)) {
    out.username = clip(s.username, 64) || '';
    out.savePassword = Boolean(s.savePassword);
  }
  if (s.protocol === 'ssh') {
    out.auth = AUTH.includes(s.auth) ? s.auth : 'auto';
    out.keyPath = clip(s.keyPath, 500) || '';
    out.jump = clip(s.jump, LIMITS.name) || '';
    out.legacy = Boolean(s.legacy);
    out.keepalive = Math.max(0, Math.min(Number(s.keepalive ?? 30) || 0, 600));
    out.forwards = (Array.isArray(s.forwards) ? s.forwards : []).slice(0, 20).map(sanitizeForward).filter(Boolean);
  }
  if (s.protocol === 'serial') {
    out.path = clip(s.path, 200) || '';
    if (!/^\/dev\/[A-Za-z0-9._-]+$|^COM\d+$/.test(out.path)) throw new Error('Serieller Anschluss ungültig');
    out.baudRate = Number(s.baudRate) || 9600;
    out.dataBits = [5, 6, 7, 8].includes(Number(s.dataBits)) ? Number(s.dataBits) : 8;
    out.stopBits = [1, 2].includes(Number(s.stopBits)) ? Number(s.stopBits) : 1;
    out.parity = ['none', 'even', 'odd', 'mark', 'space'].includes(s.parity) ? s.parity : 'none';
    out.flow = ['none', 'rtscts', 'xonxoff'].includes(s.flow) ? s.flow : 'none';
  }
  if (s.protocol === 'local') out.shell = clip(s.shell, 200) || '';
  return out;
}

function sanitizeForward(f) {
  if (!f || !['L', 'R', 'D'].includes(f.type)) return null;
  const bindPort = Number(f.bindPort);
  if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) return null;
  if (f.type === 'D') return { type: 'D', bindPort };
  const port = Number(f.port);
  const host = clip(f.host, 255);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { type: f.type, bindPort, host, port };
}

function sanitizeSnippet(raw) {
  const s = raw || {};
  const text = clip(s.text, LIMITS.text);
  if (!text) throw new Error('Text fehlt');
  return {
    id: typeof s.id === 'string' && /^[a-z0-9-]{3,40}$/.test(s.id) ? s.id : crypto.randomUUID(),
    group: clip(s.group, 60) || 'Eigene', name: clip(s.name, 80) || text.split('\n')[0].slice(0, 40), text,
  };
}

const MAX_GROUP = 50;

/** Gruppe: Name und bis zu 50 Profile (IDs), z. B. alle Switches einer Etage für „An mehrere“. */
function sanitizeGroup(raw, sessions) {
  const g = raw || {};
  const name = clip(g.name, 80);
  if (!name || !name.trim()) throw new Error('Name fehlt');
  const known = new Set(sessions.map((x) => x.id));
  const ids = [...new Set((Array.isArray(g.sessionIds) ? g.sessionIds : []).filter((id) => typeof id === 'string' && known.has(id)))];
  if (!ids.length) throw new Error('Gruppe ist leer');
  if (ids.length > MAX_GROUP) throw new Error(`Höchstens ${MAX_GROUP} Profile je Gruppe`);
  return { id: typeof g.id === 'string' && /^[a-z0-9-]{6,40}$/.test(g.id) ? g.id : crypto.randomUUID(), name: name.trim(), sessionIds: ids };
}

function sanitizeTftp(v) {
  const t = v || {};
  const port = Number(t.port);
  return {
    root: clip(t.root, 500) || '',
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 69,
    allowWrite: Boolean(t.allowWrite),
  };
}

class Store {
  /**
   * @param {string} dir App-Datenordner
   * @param {{encrypt:(s:string)=>Buffer, decrypt:(b:Buffer)=>string, available:()=>boolean}} crypt
   */
  constructor(dir, crypt) {
    this.dir = dir;
    this.crypt = crypt;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'cable.json');
    this.secretFile = path.join(dir, 'secrets.json');
    // Bis 0.1 hieß die App „Kabel“ und die Datei kabel.json.
    this.data = this.read(this.file, null) || this.read(path.join(dir, 'kabel.json'), null) || {};
    this.data.sessions ??= [];
    this.data.groups ??= [];
    this.data.snippets ??= DEFAULT_SNIPPETS;
    this.data.rules = migrateRules(this.data.rules);
    this.data.settings ??= { fontSize: 13, theme: 'auto', logDir: '', scrollback: 10000 };
    this.data.tftp = sanitizeTftp(this.data.tftp);
    if ((this.data.snippetsVersion || 1) < SNIPPETS_VERSION) {
      const have = new Set(this.data.snippets.map((x) => x.id));
      this.data.snippets.push(...DEFAULT_SNIPPETS.filter((x) => !have.has(x.id)));
      this.data.snippetsVersion = SNIPPETS_VERSION;
    }
    this.secrets = this.read(this.secretFile, {});
  }

  read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  write(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  save() { this.write(this.file, this.data); }

  all() {
    return { sessions: this.data.sessions, groups: this.data.groups, snippets: this.data.snippets, rules: this.data.rules, settings: this.data.settings, tftp: this.data.tftp, canStoreSecrets: this.crypt.available() };
  }

  /** Profil speichern; `raw.password` landet nur verschlüsselt in secrets.json und nur mit „merken“. */
  upsertSession(raw) {
    const s = sanitizeSession(raw);
    const i = this.data.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) this.data.sessions[i] = s; else this.data.sessions.push(s);
    if (!s.savePassword) this.setSecret(s.id, null);
    else if (typeof raw.password === 'string' && raw.password) this.setSecret(s.id, raw.password.slice(0, 500));
    this.save();
    return s;
  }

  hasSecret(id) { return Boolean(this.secrets[id]); }

  saveGroup(raw) {
    const g = sanitizeGroup(raw, this.data.sessions);
    const i = this.data.groups.findIndex((x) => x.id === g.id);
    if (i >= 0) this.data.groups[i] = g; else this.data.groups.push(g);
    this.save();
    return g;
  }

  deleteGroup(id) {
    this.data.groups = this.data.groups.filter((x) => x.id !== id);
    this.save();
  }

  setTftp(v) { this.data.tftp = sanitizeTftp(v); this.save(); return this.data.tftp; }

  importSessions(list) {
    let added = 0;
    for (const raw of list) {
      const dup = this.data.sessions.some((x) => x.protocol === raw.protocol && x.name === raw.name && (x.host || x.path) === (raw.host || raw.path));
      if (dup) continue;
      try { this.data.sessions.push(sanitizeSession(raw)); added++; } catch { /* ungültig → auslassen */ }
    }
    this.save();
    return added;
  }

  deleteSession(id) {
    this.data.sessions = this.data.sessions.filter((x) => x.id !== id);
    for (const g of this.data.groups) g.sessionIds = g.sessionIds.filter((x) => x !== id);
    this.data.groups = this.data.groups.filter((g) => g.sessionIds.length);
    this.setSecret(id, null);
    this.save();
  }

  session(idOrName) {
    return this.data.sessions.find((x) => x.id === idOrName) || this.data.sessions.find((x) => x.name === idOrName) || null;
  }

  setSnippets(list) { this.data.snippets = (list || []).slice(0, 300).map(sanitizeSnippet); this.save(); return this.data.snippets; }

  setRules(list) {
    this.data.rules = (list || []).slice(0, 50).map((r) => ({ pattern: clip(r.pattern, 500) || '', color: r.color, flags: clip(r.flags, 4) || '' })).filter((r) => r.pattern);
    this.save();
    return this.data.rules;
  }

  setSettings(v) {
    const s = this.data.settings;
    if (Number.isInteger(v.fontSize) && v.fontSize >= 9 && v.fontSize <= 28) s.fontSize = v.fontSize;
    if (['auto', 'dark', 'light'].includes(v.theme)) s.theme = v.theme;
    if (typeof v.logDir === 'string') s.logDir = v.logDir.slice(0, 500);
    if (Number.isInteger(v.scrollback) && v.scrollback >= 1000 && v.scrollback <= 200000) s.scrollback = v.scrollback;
    this.save();
    return s;
  }

  getSecret(id) {
    const v = this.secrets[id];
    if (!v || !this.crypt.available()) return null;
    try { return this.crypt.decrypt(Buffer.from(v, 'base64')); } catch { return null; }
  }

  setSecret(id, value) {
    if (value == null) { if (id in this.secrets) { delete this.secrets[id]; this.write(this.secretFile, this.secrets); } return; }
    if (!this.crypt.available()) return;
    this.secrets[id] = this.crypt.encrypt(String(value)).toString('base64');
    this.write(this.secretFile, this.secrets);
  }
}

module.exports = { Store, sanitizeSession, sanitizeSnippet, sanitizeForward, sanitizeGroup, DEFAULT_SNIPPETS, PROTOCOLS, MAX_GROUP };
