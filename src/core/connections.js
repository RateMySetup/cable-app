'use strict';
// Verbindungen mit einheitlicher Schnittstelle:
//   Ereignisse 'ready', 'data' (Buffer), 'error' (Error), 'close'; Methoden write, resize, close, sendBreak?
// Arten: ssh (Passwort, Schlüssel, Agent, keyboard-interactive, Jump-Host, Tunnel), telnet, raw (TCP),
// serial, local (Shell über node-pty). Rückfragen (Host-Schlüssel, Passwort) laufen über `ask`.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { TelnetConnection } = require('./telnet');
const { createSocksServer } = require('./socks');
const { fingerprint, keyType } = require('./hostkeys');

// Für alte Cisco-/HP-Geräte, nur wenn in der Sitzung eingeschaltet.
const LEGACY = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'],
  serverHostKey: ['ssh-rsa', 'ssh-dss'],
  cipher: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'],
  hmac: ['hmac-sha1'],
};

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * @typedef {object} Ask
 * @property {(info:{host:string,port:number,fingerprint:string,type:string,state:'new'|'changed',old?:object}) => Promise<boolean>} hostKey
 * @property {(prompt:string) => Promise<string|null>} secret  Passwort/Passphrase abfragen (null = Abbruch)
 * @property {(name:string, prompts:{prompt:string,echo:boolean}[]) => Promise<string[]|null>} keyboard
 */

class SshConnection extends EventEmitter {
  /**
   * @param {object} s Sitzung
   * @param {{ask: Ask, hostKeys: import('./hostkeys').HostKeyStore, password?: string|null, passphrase?: string|null,
   *          jumpSession?: object|null, jumpPassword?: string|null, cols:number, rows:number}} ctx
   */
  constructor(s, ctx) {
    super();
    this.s = s;
    this.ctx = ctx;
    this.clients = [];
    this.servers = [];
    this.forwards = [];
    const { Client } = require('ssh2');
    this.Client = Client;
    this.start().catch((e) => { this.emit('error', e); this.close(); });
  }

  connectOptions(s, password, passphrase) {
    const o = {
      host: s.host, port: s.port || 22, username: s.username || os.userInfo().username,
      readyTimeout: 120000, keepaliveInterval: (s.keepalive ?? 30) * 1000,
    };
    if (s.auth === 'key' && s.keyPath) {
      o.privateKey = fs.readFileSync(expandHome(s.keyPath));
      if (passphrase) o.passphrase = passphrase;
    }
    if (s.auth === 'agent' || s.auth === undefined || s.auth === 'auto') {
      if (process.env.SSH_AUTH_SOCK) o.agent = process.env.SSH_AUTH_SOCK;
    }
    if (password) o.password = password;
    o.authHandler = this.authHandler(s, o);
    if (s.legacy) o.algorithms = Object.fromEntries(Object.entries(LEGACY).map(([k, v]) => [k, { append: v }]));
    o.hostVerifier = (key, verify) => {
      const store = this.ctx.hostKeys;
      const state = store.check(o.host, o.port, key);
      if (state === 'known') return verify(true);
      this.ctx.ask.hostKey({ host: o.host, port: o.port, fingerprint: fingerprint(key), type: keyType(key), state, old: store.known(o.host, o.port) })
        .then((ok) => { if (ok) store.remember(o.host, o.port, key); verify(Boolean(ok)); })
        .catch(() => verify(false));
    };
    return o;
  }

  /**
   * Anmelde-Reihenfolge: Agent → Schlüssel → Passwort (gemerkt oder per Dialog) → keyboard-interactive.
   * Der Passwort-Dialog kommt nur, wenn der Server Passwörter überhaupt anbietet.
   */
  authHandler(s, o) {
    const queue = [];
    if (o.agent) queue.push({ type: 'agent', agent: o.agent });
    if (o.privateKey) queue.push({ type: 'publickey', key: o.privateKey, passphrase: o.passphrase });
    if (s.auth !== 'agent') queue.push({ type: 'password' }, { type: 'keyboard-interactive' });
    let asked = false;
    return (methodsLeft, _partial, next) => {
      const left = methodsLeft || ['publickey', 'password', 'keyboard-interactive'];
      for (;;) {
        const m = queue.shift();
        if (!m) { next(false); return undefined; }
        if (m.type === 'agent' && left.includes('publickey')) { next({ type: 'agent', username: o.username, agent: m.agent }); return undefined; }
        if (m.type === 'publickey' && left.includes('publickey')) { next({ type: 'publickey', username: o.username, key: m.key, passphrase: m.passphrase }); return undefined; }
        if (m.type === 'password' && left.includes('password')) {
          if (o.password) { next({ type: 'password', username: o.username, password: o.password }); return undefined; }
          if (asked) continue;
          asked = true;
          // Nichts zurückgeben: ssh2 wertet einen Rückgabewert als Anmeldemethode.
          this.ctx.ask.secret(`Passwort für ${o.username}@${o.host}`).then((pw) => {
            if (pw == null) return next(false);
            o.password = pw;
            this.usedPassword = pw;
            next({ type: 'password', username: o.username, password: pw });
          }, () => next(false));
          return undefined;
        }
        if (m.type === 'keyboard-interactive' && left.includes('keyboard-interactive')) {
          next({ type: 'keyboard-interactive', username: o.username, prompt: (name, instr, lang, prompts, finish) => {
            if (prompts.length === 1 && !prompts[0].echo && o.password) return finish([o.password]);
            this.ctx.ask.keyboard(name || instr || `${o.username}@${o.host}`, prompts).then((a) => finish(a || []), () => finish([]));
          } });
          return undefined;
        }
      }
    };
  }

  connectClient(opts, s) {
    return new Promise((resolve, reject) => {
      const c = new this.Client();
      this.clients.push(c);
      c.once('ready', () => resolve(c));
      c.once('error', (e) => reject(e));
      c.on('close', () => this.close());
      c.connect(opts);
    });
  }

  async start() {
    const { s, ctx } = this;
    let sock;
    if (ctx.jumpSession) {
      const j = ctx.jumpSession;
      const jumpClient = await this.connectClient(this.connectOptions(j, ctx.jumpPassword), j);
      sock = await new Promise((res, rej) => jumpClient.forwardOut('127.0.0.1', 0, s.host, s.port || 22, (e, st) => (e ? rej(e) : res(st))));
    }
    const password = ctx.password;
    let passphrase = ctx.passphrase;
    if (s.auth === 'key' && s.keyPath && !passphrase && isEncryptedKey(expandHome(s.keyPath))) {
      passphrase = await ctx.ask.secret(`Passphrase für ${s.keyPath}`);
      if (passphrase === null) throw new Error('Abgebrochen');
    }
    if (!sock) sock = await tcpConnect(s.host, s.port || 22, 10000);
    const opts = this.connectOptions(s, password, passphrase);
    if (sock) opts.sock = sock;
    const conn = await this.connectClient(opts, s);
    this.conn = conn;
    this.stream = await new Promise((res, rej) => conn.shell({ term: 'xterm-256color', cols: ctx.cols, rows: ctx.rows }, (e, st) => (e ? rej(e) : res(st))));
    this.stream.on('data', (d) => this.emit('data', d));
    this.stream.stderr.on('data', (d) => this.emit('data', d));
    this.stream.on('close', () => this.close());
    for (const f of s.forwards || []) {
      try { await this.addForward(f); } catch (e) { this.emit('notice', `Weiterleitung ${describeForward(f)} fehlgeschlagen: ${e.message}`); }
    }
    this.emit('ready');
  }

  async addForward(f) {
    const conn = this.conn;
    const open = (host, port) => new Promise((res, rej) => conn.forwardOut('127.0.0.1', 0, host, port, (e, st) => (e ? rej(e) : res(st))));
    if (f.type === 'L') {
      const server = net.createServer((sock) => {
        open(f.host, f.port).then((st) => { sock.pipe(st).pipe(sock); st.on('error', () => sock.destroy()); }).catch(() => sock.destroy());
        sock.on('error', () => {});
      });
      await listen(server, f.bindPort);
      this.servers.push(server);
    } else if (f.type === 'D') {
      const server = createSocksServer(f.bindPort, open);
      await new Promise((res, rej) => { server.once('listening', res); server.once('error', rej); });
      this.servers.push(server);
    } else if (f.type === 'R') {
      await new Promise((res, rej) => conn.forwardIn('127.0.0.1', f.bindPort, (e) => (e ? rej(e) : res())));
      conn.on('tcp connection', (info, accept) => {
        if (info.destPort !== f.bindPort) return;
        const st = accept();
        const sock = net.connect(f.port, f.host);
        st.pipe(sock).pipe(st);
        sock.on('error', () => st.destroy());
      });
    } else throw new Error('Art unbekannt');
    this.forwards.push(f);
    this.emit('notice', `Weiterleitung aktiv: ${describeForward(f)}`);
  }

  write(d) { if (this.stream) this.stream.write(d); }
  resize(cols, rows) { if (this.stream) this.stream.setWindow(rows, cols, 0, 0); }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const sv of this.servers) sv.close();
    for (const c of this.clients) c.end();
    this.emit('close');
  }
}

/** TCP-Verbindung mit eigener Zeitgrenze (ssh2-readyTimeout deckt auch die Passworteingabe ab). */
function tcpConnect(host, port, ms) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error(`Zeitüberschreitung bei ${host}:${port}`)); }, ms);
    sock.once('connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function listen(server, port) {
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => res());
  });
}

function describeForward(f) {
  if (f.type === 'D') return `SOCKS 127.0.0.1:${f.bindPort}`;
  if (f.type === 'L') return `127.0.0.1:${f.bindPort} → ${f.host}:${f.port}`;
  return `Server:${f.bindPort} → ${f.host}:${f.port}`;
}

function isEncryptedKey(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    if (/ENCRYPTED/.test(t)) return true;
    const m = t.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END/);
    if (m) return !Buffer.from(m[1].replace(/\s+/g, ''), 'base64').subarray(15, 40).toString('latin1').includes('none');
  } catch { /* fehlt → ssh2 meldet den Fehler */ }
  return false;
}

class RawConnection extends EventEmitter {
  constructor(s) {
    super();
    this.socket = net.connect({ host: s.host, port: s.port });
    this.socket.on('connect', () => this.emit('ready'));
    this.socket.on('data', (d) => this.emit('data', d));
    this.socket.on('error', (e) => this.emit('error', e));
    this.socket.on('close', () => this.emit('close'));
  }
  write(d) { this.socket.write(d); }
  resize() {}
  close() { this.socket.destroy(); }
}

class SerialConnection extends EventEmitter {
  constructor(s) {
    super();
    const { SerialPort } = require('serialport');
    this.port = new SerialPort({
      path: s.path, baudRate: Number(s.baudRate) || 9600, dataBits: Number(s.dataBits) || 8,
      stopBits: Number(s.stopBits) || 1, parity: s.parity || 'none',
      rtscts: s.flow === 'rtscts', xon: s.flow === 'xonxoff', xoff: s.flow === 'xonxoff', autoOpen: false,
    });
    this.port.on('data', (d) => this.emit('data', d));
    this.port.on('error', (e) => this.emit('error', e));
    this.port.on('close', () => this.emit('close'));
    this.port.open((e) => (e ? this.emit('error', e) : this.emit('ready')));
  }
  write(d) { this.port.write(d); }
  resize() {}
  /** Break-Signal (z. B. Cisco ROMMON / Passwort-Wiederherstellung). */
  sendBreak() {
    this.port.set({ brk: true }, () => setTimeout(() => this.port.set({ brk: false }, () => {}), 500));
  }
  close() { if (this.port.isOpen) this.port.close(); else this.emit('close'); }
}

class LocalConnection extends EventEmitter {
  constructor(s, { cols, rows }) {
    super();
    const pty = require('node-pty');
    const shell = s.shell || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
    this.p = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color' } });
    this.p.onData((d) => this.emit('data', Buffer.from(d, 'utf8')));
    this.p.onExit(() => this.emit('close'));
    setImmediate(() => this.emit('ready'));
  }
  write(d) { this.p.write(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')); }
  resize(cols, rows) { try { this.p.resize(cols, rows); } catch { /* beendet */ } }
  close() { try { this.p.kill(); } catch { /* schon beendet */ } }
}

function open(s, ctx) {
  switch (s.protocol) {
    case 'ssh': return new SshConnection(s, ctx);
    case 'telnet': return new TelnetConnection({ host: s.host, port: s.port || 23, cols: ctx.cols, rows: ctx.rows });
    case 'raw': return new RawConnection(s);
    case 'serial': return new SerialConnection(s);
    case 'local': return new LocalConnection(s, ctx);
    default: throw new Error(`Protokoll ${s.protocol} unbekannt`);
  }
}

async function listSerialPorts() {
  const { SerialPort } = require('serialport');
  const ports = await SerialPort.list();
  // Auf dem Mac sind /dev/cu.* die richtigen Geräte zum Öffnen (tty.* wartet auf Carrier).
  return ports
    .map((p) => ({ ...p, path: p.path.replace('/dev/tty.', '/dev/cu.') }))
    .filter((p) => !/Bluetooth|debug-console|wlan-debug/i.test(p.path))
    // Linux meldet viele virtuelle ttyS*; echte Kabel haben Hersteller- oder USB-Kennung.
    .filter((p) => !/^\/dev\/ttyS\d+$/.test(p.path) || p.manufacturer || p.vendorId);
}

module.exports = { open, listSerialPorts, SshConnection, RawConnection, describeForward, isEncryptedKey, LEGACY };
