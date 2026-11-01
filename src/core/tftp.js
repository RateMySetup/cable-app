'use strict';
// Eingebauter TFTP-Server (RFC 1350, Optionen blksize/tsize/timeout nach RFC 2347–2349) für Image-
// und Config-Transfer von und zu Switches auf der Werkbank.
// Standard: nur lesen (Mac → Gerät). Uploads (Gerät → Mac, z. B. „copy run tftp:“) nur, wenn eingeschaltet,
// und nie über bestehende Dateien. Alles bleibt im freigegebenen Ordner (kein „..“, keine absoluten Pfade).

const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 };
const ERR = { NOT_DEFINED: 0, NOT_FOUND: 1, ACCESS: 2, DISK_FULL: 3, ILLEGAL: 4, EXISTS: 6 };
const MAX_RETRIES = 5;

/** Anfrage (RRQ/WRQ) zerlegen: Dateiname, Modus, Optionen. null bei kaputtem Paket. */
function parseRequest(buf) {
  if (buf.length < 4) return null;
  const op = buf.readUInt16BE(0);
  if (op !== OP.RRQ && op !== OP.WRQ) return null;
  const parts = buf.subarray(2).toString('latin1').split('\0');
  if (parts.length < 3) return null;
  const [file, mode, ...rest] = parts;
  if (!file || !mode) return null;
  const options = {};
  for (let i = 0; i + 1 < rest.length; i += 2) if (rest[i]) options[rest[i].toLowerCase()] = rest[i + 1];
  return { op, file, mode: mode.toLowerCase(), options };
}

/**
 * Dateinamen aus der Anfrage sicher in den Ordner auflösen. Geräte schicken oft „/datei“ oder
 * „ordner/datei“; „..“, Laufwerksbuchstaben und Steuerzeichen sind verboten.
 */
function resolveInRoot(root, name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.length > 255 || /[\0-\x1f]/.test(clean) || /^[a-zA-Z]:/.test(clean)) return null;
  if (clean.split('/').some((p) => p === '..' || p === '')) return null;
  const full = path.resolve(root, clean);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/** Optionen aushandeln (RFC 2347): nur bekannte, gültige Werte kommen ins OACK. */
function negotiate(options, size) {
  const out = {};
  const blk = Number(options.blksize);
  if (Number.isInteger(blk) && blk >= 8) out.blksize = Math.min(blk, 65464);
  const to = Number(options.timeout);
  if (Number.isInteger(to) && to >= 1 && to <= 255) out.timeout = to;
  if ('tsize' in options) {
    if (size != null) out.tsize = size;
    else if (/^\d+$/.test(options.tsize)) out.tsize = Number(options.tsize);
  }
  return out;
}

function packet(op, ...parts) {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(op);
  return Buffer.concat([head, ...parts]);
}
const ack = (block) => { const b = Buffer.alloc(4); b.writeUInt16BE(OP.ACK, 0); b.writeUInt16BE(block & 0xffff, 2); return b; };
const errorPacket = (code, msg) => { const b = Buffer.alloc(4); b.writeUInt16BE(OP.ERROR, 0); b.writeUInt16BE(code, 2); return Buffer.concat([b, Buffer.from(String(msg).slice(0, 200) + '\0', 'latin1')]); };
const oack = (opts) => packet(OP.OACK, Buffer.from(Object.entries(opts).map(([k, v]) => `${k}\0${v}\0`).join(''), 'latin1'));

/** netascii: auf dem Draht CR LF, auf dem Mac LF. */
const toNetascii = (buf) => Buffer.from(buf.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
const fromNetascii = (buf) => Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n').replace(/\r\0/g, '\r'), 'latin1');

/** IPv4-Adressen dieses Macs, die ein Gerät als TFTP-Server eintragen kann. */
function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

class TftpServer extends EventEmitter {
  /**
   * @param {{root:string, port?:number, host?:string, allowWrite?:boolean, timeoutMs?:number}} o
   * Ereignisse: 'event' ({ts, text, kind}) für die Anzeige.
   */
  constructor(o) {
    super();
    this.root = fs.realpathSync(path.resolve(o.root));
    if (!fs.statSync(this.root).isDirectory()) throw new Error('Kein Ordner');
    this.port = o.port ?? 69;
    this.host = o.host || '0.0.0.0';
    this.allowWrite = Boolean(o.allowWrite);
    this.timeoutMs = o.timeoutMs || 3000;
    this.transfers = new Set();
    this.socket = null;
  }

  log(text, kind = 'info') { this.emit('event', { ts: Date.now(), text, kind }); }

  start() {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.once('error', (e) => {
        if (e.code === 'EADDRINUSE') reject(new Error(`Port ${this.port} ist belegt – läuft schon ein anderer TFTP-Server?`));
        else if (e.code === 'EACCES') reject(new Error(`Port ${this.port} nicht erlaubt – anderen Port (z. B. 6969) wählen`));
        else reject(e);
      });
      s.on('message', (msg, rinfo) => this.onRequest(msg, rinfo));
      s.bind(this.port, this.host, () => {
        this.socket = s;
        this.port = s.address().port;
        s.removeAllListeners('error');
        s.on('error', (e) => this.log(`Fehler: ${e.message}`, 'error'));
        this.log(`Server gestartet – ${this.root} (${this.allowWrite ? 'lesen und hochladen' : 'nur lesen'})`);
        resolve(this);
      });
    });
  }

  stop() {
    for (const t of this.transfers) t.finish();
    this.transfers.clear();
    if (this.socket) { try { this.socket.close(); } catch { /* schon zu */ } }
    this.socket = null;
    this.log('Server gestoppt');
  }

  onRequest(msg, rinfo) {
    const req = parseRequest(msg);
    const who = `${rinfo.address}`;
    const reply = (buf) => { const s = dgram.createSocket('udp4'); s.send(buf, rinfo.port, rinfo.address, () => s.close()); };
    if (!req) { reply(errorPacket(ERR.ILLEGAL, 'Illegal TFTP operation')); return; }
    if (!['octet', 'netascii'].includes(req.mode)) { reply(errorPacket(ERR.ILLEGAL, 'Mode not supported')); return; }
    const file = resolveInRoot(this.root, req.file);
    if (!file) { this.log(`${who}: Dateiname abgelehnt „${req.file.slice(0, 80)}“`, 'error'); reply(errorPacket(ERR.ACCESS, 'Access violation')); return; }
    const rel = path.relative(this.root, file);
    if (req.op === OP.RRQ) this.startRead(file, rel, req, rinfo, reply);
    else this.startWrite(file, rel, req, rinfo, reply);
  }

  startRead(file, rel, req, rinfo, reply) {
    let data;
    try {
      // Auch Symlinks dürfen nicht aus dem Ordner herausführen.
      const real = fs.realpathSync(file);
      if (path.relative(this.root, real).startsWith('..')) throw Object.assign(new Error('außerhalb'), { code: 'EACCES' });
      if (!fs.statSync(real).isFile()) throw Object.assign(new Error('kein File'), { code: 'ENOENT' });
      data = fs.readFileSync(real);
    } catch (e) {
      const nf = e.code === 'ENOENT';
      this.log(`${rinfo.address} wollte ${rel} laden – ${nf ? 'nicht gefunden' : 'kein Zugriff'}`, 'error');
      reply(errorPacket(nf ? ERR.NOT_FOUND : ERR.ACCESS, nf ? 'File not found' : 'Access violation'));
      return;
    }
    if (req.mode === 'netascii') data = toNetascii(data);
    this.log(`${rinfo.address} lädt ${rel} (${fmtSize(data.length)})`);
    new Transfer(this, rinfo, 'read', file, rel, data, negotiate(req.options, data.length)).begin();
  }

  startWrite(file, rel, req, rinfo, reply) {
    if (!this.allowWrite) {
      this.log(`${rinfo.address} wollte ${rel} hochladen – Uploads sind aus`, 'error');
      reply(errorPacket(ERR.ACCESS, 'Uploads disabled'));
      return;
    }
    if (fs.existsSync(file)) {
      this.log(`${rinfo.address} wollte ${rel} hochladen – Datei existiert schon`, 'error');
      reply(errorPacket(ERR.EXISTS, 'File already exists'));
      return;
    }
    if (!fs.existsSync(path.dirname(file))) {
      reply(errorPacket(ERR.NOT_FOUND, 'Directory not found'));
      return;
    }
    this.log(`${rinfo.address} lädt ${rel} hoch …`);
    new Transfer(this, rinfo, 'write', file, rel, null, negotiate(req.options, null), req.mode === 'netascii').begin();
  }
}

function fmtSize(n) {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1).replace('.', ',')} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} Bytes`;
}

/** Eine Übertragung auf eigenem UDP-Port (TID). Blocknummern laufen über 65535 hinaus wieder bei 0 los. */
class Transfer {
  constructor(server, rinfo, kind, file, rel, data, opts, netascii = false) {
    Object.assign(this, { server, rinfo, kind, file, rel, data, opts, netascii });
    this.blksize = opts.blksize || 512;
    this.timeoutMs = opts.timeout ? opts.timeout * 1000 : server.timeoutMs;
    this.block = 0;
    this.retries = 0;
    this.chunks = [];
    this.received = 0;
    this.started = Date.now();
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, r) => this.onMessage(m, r));
    this.sock.on('error', () => this.finish());
    server.transfers.add(this);
  }

  begin() {
    this.sock.bind(0, () => {
      if (Object.keys(this.opts).length) { this.last = oack(this.opts); this.waitingOack = true; } else if (this.kind === 'read') { this.last = this.dataPacket(1); this.block = 1; } else { this.last = ack(0); }
      this.send(this.last);
    });
  }

  send(buf) {
    clearTimeout(this.timer);
    this.sock.send(buf, this.rinfo.port, this.rinfo.address);
    this.timer = setTimeout(() => this.onTimeout(), this.timeoutMs);
  }

  onTimeout() {
    if (++this.retries > MAX_RETRIES) { this.fail('Zeitüberschreitung'); return; }
    this.send(this.last);
  }

  dataPacket(n) {
    const start = (n - 1) * this.blksize;
    const b = Buffer.alloc(4);
    b.writeUInt16BE(OP.DATA, 0);
    b.writeUInt16BE(n & 0xffff, 2);
    return Buffer.concat([b, this.data.subarray(start, start + this.blksize)]);
  }

  onMessage(msg, r) {
    if (r.address !== this.rinfo.address || r.port !== this.rinfo.port) {
      // Fremder Absender (RFC 1350: falsche TID) – nur ihm antworten, Übertragung läuft weiter.
      const s = dgram.createSocket('udp4'); s.send(errorPacket(5, 'Unknown transfer ID'), r.port, r.address, () => s.close());
      return;
    }
    if (msg.length < 4) return;
    const op = msg.readUInt16BE(0);
    const n = msg.readUInt16BE(2);
    if (op === OP.ERROR) { this.fail(`Gerät meldet Fehler: ${msg.subarray(4).toString('latin1').replace(/\0.*$/, '')}`); return; }
    if (this.kind === 'read' && op === OP.ACK) this.onAck(n);
    else if (this.kind === 'write' && op === OP.DATA) this.onData(n, msg.subarray(4));
  }

  onAck(n) {
    const expected = this.waitingOack ? 0 : this.block & 0xffff;
    if (n !== expected) return; // altes ACK: ignorieren (Sorcerer's Apprentice vermeiden)
    this.waitingOack = false;
    this.retries = 0;
    const total = Math.floor(this.data.length / this.blksize) + 1; // letzter Block ist immer < blksize
    if (this.block >= total) { this.done(this.data.length); return; }
    this.block += 1;
    this.last = this.dataPacket(this.block);
    this.send(this.last);
  }

  onData(n, payload) {
    const expected = (this.block + 1) & 0xffff;
    if (n !== expected) { if (n === (this.block & 0xffff)) this.send(this.last); return; }
    this.waitingOack = false;
    this.retries = 0;
    this.block += 1;
    this.chunks.push(Buffer.from(payload));
    this.received += payload.length;
    if (this.received > 4 * 1024 ** 3) { this.sock.send(errorPacket(ERR.DISK_FULL, 'Too large'), this.rinfo.port, this.rinfo.address); this.fail('zu groß'); return; }
    this.last = ack(this.block);
    if (payload.length < this.blksize) {
      clearTimeout(this.timer);
      // Erst schließen, wenn das letzte ACK wirklich draußen ist (send ist asynchron).
      this.closing = true;
      this.sock.send(this.last, this.rinfo.port, this.rinfo.address, () => this.finish(true));
      let data = Buffer.concat(this.chunks);
      if (this.netascii) data = fromNetascii(data);
      try {
        // Exklusiv anlegen: nie eine Datei überschreiben, auch wenn sie inzwischen entstanden ist.
        fs.writeFileSync(this.file, data, { flag: 'wx', mode: 0o644 });
        this.done(data.length);
      } catch (e) { this.fail(e.code === 'EEXIST' ? 'Datei existiert schon' : e.message); }
      return;
    }
    this.send(this.last);
  }

  done(bytes) {
    const secs = Math.max(0.001, (Date.now() - this.started) / 1000);
    const verb = this.kind === 'read' ? 'hat geladen' : 'hat hochgeladen';
    this.server.log(`${this.rinfo.address} ${verb}: ${this.rel} (${fmtSize(bytes)}, ${secs.toFixed(1).replace('.', ',')} s)`, 'ok');
    this.finish();
  }

  fail(why) {
    this.server.log(`${this.rinfo.address}: ${this.rel} abgebrochen – ${why}`, 'error');
    this.finish();
  }

  finish(force = false) {
    clearTimeout(this.timer);
    this.server.transfers.delete(this);
    if (this.closing && !force) return;
    try { this.sock.close(); } catch { /* schon zu */ }
  }
}

module.exports = { TftpServer, parseRequest, resolveInRoot, negotiate, localAddresses, OP, ERR, toNetascii, fromNetascii };
