'use strict';
// SCP für Images und Configs: Client (Mac → Gerät per „scp -t“, Gerät → Mac per „scp -f“) und
// eingebauter SCP-Server, von dem Switches laden („copy scp://user@mac/datei flash:“).
// Server wie beim TFTP: Standard nur lesen, Hochladen (Gerät → Mac) nur mit Häkchen, nie über bestehende
// Dateien, alles bleibt im freigegebenen Ordner. Anmeldung nur mit Benutzer und Passwort aus dem Dialog.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { resolveInRoot } = require('./tftp');
const { fingerprint, keyType } = require('./hostkeys');

// Wie LEGACY in connections.js, angehängt: ältere IOS-Versionen können nur SHA1-KEX, ssh-rsa und CBC.
const LEGACY = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'],
  serverHostKey: ['ssh-rsa'],
  cipher: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'],
  hmac: ['hmac-sha1'],
};
const withLegacy = () => Object.fromEntries(Object.entries(LEGACY).map(([k, v]) => [k, { append: v }]));
const PROGRESS_MS = 250;

/** Zeile „C0644 <Größe> <Name>“ zerlegen; null, wenn es keine Datei-Kopfzeile ist. */
function parseHeader(line) {
  const m = /^C([0-7]{4}) (\d{1,15}) ([^/\0\n]+)$/.exec(line);
  if (!m) return null;
  return { mode: parseInt(m[1], 8), size: Number(m[2]), name: m[3] };
}

/** „scp [-v] [-p] [-d] -t|-f <Pfad>“ vom Gerät zerlegen. Rekursiv (-r) wird nicht unterstützt. */
function parseScpCommand(cmd) {
  const parts = String(cmd).trim().split(/\s+/);
  if (parts[0] !== 'scp') return null;
  let dir = null;
  const rest = [];
  for (const p of parts.slice(1)) {
    if (/^-[a-zA-Z]+$/.test(p)) {
      if (p.includes('r')) return { error: 'Ordner (-r) werden nicht unterstützt' };
      if (p.includes('t')) dir = 'sink';
      if (p.includes('f')) dir = 'source';
    } else rest.push(p);
  }
  if (!dir || !rest.length) return null;
  return { dir, path: rest.join(' ').replace(/^['"]|['"]$/g, '') };
}

/** Byte-Leser über einen Stream: ein Byte, eine Zeile oder eine feste Länge. */
class Reader {
  constructor(stream) {
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.ended = false;
    stream.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.wake(); });
    stream.on('end', () => { this.ended = true; this.wake(); });
    stream.on('close', () => { this.ended = true; this.wake(); });
  }
  wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  wait() { return new Promise((r) => this.waiters.push(r)); }
  async byte() {
    while (!this.buf.length) { if (this.ended) throw new Error('Verbindung beendet'); await this.wait(); }
    const b = this.buf[0];
    this.buf = this.buf.subarray(1);
    return b;
  }
  async line(max = 1024) {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) { const l = this.buf.subarray(0, i).toString('utf8'); this.buf = this.buf.subarray(i + 1); return l; }
      if (this.buf.length > max) throw new Error('Kopfzeile zu lang');
      if (this.ended) throw new Error('Verbindung beendet');
      await this.wait();
    }
  }
  /** Bis zu n Bytes, sobald welche da sind. */
  async chunk(n) {
    while (!this.buf.length) { if (this.ended) throw new Error('Verbindung beendet'); await this.wait(); }
    const c = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(c.length);
    return c;
  }
}

/** Antwort der Gegenseite: 0 = ok, 1/2 + Text = Fehler. */
async function expectOk(rd) {
  const b = await rd.byte();
  if (b === 0) return;
  const msg = b === 1 || b === 2 ? (await rd.line()).trim() : `unerwartete Antwort (${b})`;
  throw new Error(msg || 'Gegenseite meldet einen Fehler');
}

function writeAsync(stream, data) {
  return new Promise((resolve) => { if (stream.write(data)) resolve(); else stream.once('drain', resolve); });
}

function progress(onProgress, total) {
  let done = 0;
  let last = 0;
  const t0 = Date.now();
  return {
    add(n) {
      done += n;
      const now = Date.now();
      if (now - last >= PROGRESS_MS || done === total) { last = now; onProgress({ done, total, rate: done / Math.max(0.001, (now - t0) / 1000) }); }
    },
  };
}

/** Als Quelle senden (Gegenseite wartet mit „scp -t“). */
async function sendFile(stream, rd, file, name, onProgress = () => {}) {
  const st = fs.statSync(file);
  await expectOk(rd);
  stream.write(`C0644 ${st.size} ${name}\n`);
  await expectOk(rd);
  const p = progress(onProgress, st.size);
  if (!st.size) p.add(0);
  for await (const c of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
    await writeAsync(stream, c);
    p.add(c.length);
  }
  stream.write(Buffer.from([0]));
  await expectOk(rd);
  return st.size;
}

/**
 * Als Ziel empfangen (Gegenseite sendet mit „scp -f“ bzw. als Quelle). `target(header)` liefert den Zielpfad
 * oder wirft (Fehlertext geht an die Gegenseite). Geschrieben wird erst in eine .part-Datei.
 */
async function receiveFile(stream, rd, target, onProgress = () => {}) {
  stream.write(Buffer.from([0]));
  let line = await rd.line();
  while (line.startsWith('T')) { stream.write(Buffer.from([0])); line = await rd.line(); } // Zeitstempel (-p)
  if (line.charCodeAt(0) === 1 || line.charCodeAt(0) === 2) throw new Error(line.slice(1).trim() || 'Gegenseite meldet einen Fehler');
  const h = parseHeader(line);
  if (!h) { stream.write(Buffer.from('\x02Nur einzelne Dateien\n')); throw new Error(`Unerwartete Kopfzeile: ${line.slice(0, 80)}`); }
  let file;
  try { file = target(h); } catch (e) { stream.write(Buffer.from(`\x02${e.message}\n`)); throw e; }
  const part = `${file}.part`;
  const fd = fs.openSync(part, 'wx', 0o644);
  try {
    stream.write(Buffer.from([0]));
    const p = progress(onProgress, h.size);
    if (!h.size) p.add(0);
    let left = h.size;
    while (left > 0) {
      const c = await rd.chunk(Math.min(left, 256 * 1024));
      fs.writeSync(fd, c);
      left -= c.length;
      p.add(c.length);
    }
    fs.closeSync(fd);
    await expectOk(rd);
    // link statt rename: schlägt fehl, wenn die Datei inzwischen existiert – nie überschreiben.
    try { fs.linkSync(part, file); } catch (e) { throw new Error(e.code === 'EEXIST' ? `${path.basename(file)} gibt es schon` : e.message); }
    fs.rmSync(part, { force: true });
    stream.write(Buffer.from([0]));
    return { file, size: h.size, name: h.name };
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* schon zu */ }
    fs.rmSync(part, { force: true });
    throw e;
  }
}

/** Name in der Kopfzeile: Ziel „flash:“ oder „ordner/“ → Name der lokalen Datei, sonst letzter Teil des Ziels. */
function headerName(remote, local) {
  const r = String(remote).replace(/^[a-z0-9-]+:/i, '');
  return !r || r.endsWith('/') ? path.basename(local) : path.basename(r);
}

/** Pfad auf dem Gerät für die Shell quoten (Cisco: „flash:/x.bin“, Linux: beliebig). */
function quoteRemote(p) {
  return /^[A-Za-z0-9_./:@+-]+$/.test(p) ? p : `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/**
 * Einmalige Übertragung als Client.
 * @param {{host:string, port?:number, username:string, password:string, legacy?:boolean,
 *          direction:'put'|'get', local:string, remote:string}} o
 *   put: local = Datei auf dem Mac, remote = Ziel auf dem Gerät (z. B. „flash:/cat9k.bin“)
 *   get: remote = Datei auf dem Gerät, local = Zieldatei auf dem Mac (darf nicht existieren)
 * @param {{hostKeys:import('./hostkeys').HostKeyStore, askHostKey:(info:object)=>Promise<boolean>,
 *          onProgress?:(p:{done:number,total:number,rate:number})=>void, signal?:AbortSignal}} ctx
 */
function transfer(o, ctx) {
  const { Client } = require('ssh2');
  return new Promise((resolve, reject) => {
    const c = new Client();
    let settled = false;
    const finish = (err, v) => {
      if (settled) return;
      settled = true;
      c.end();
      if (err) reject(err); else resolve(v);
    };
    if (ctx.signal) ctx.signal.addEventListener('abort', () => { finish(new Error('Abgebrochen')); c.destroy(); }, { once: true });
    const port = o.port || 22;
    c.on('error', (e) => finish(e));
    c.on('close', () => finish(new Error('Verbindung beendet')));
    c.on('ready', () => {
      const cmd = o.direction === 'put' ? `scp -t ${quoteRemote(o.remote)}` : `scp -f ${quoteRemote(o.remote)}`;
      c.exec(cmd, (err, stream) => {
        if (err) return finish(err);
        let stderr = '';
        stream.stderr.on('data', (d) => { stderr += d; });
        const rd = new Reader(stream);
        const run = o.direction === 'put'
          ? sendFile(stream, rd, o.local, headerName(o.remote, o.local), ctx.onProgress)
          : receiveFile(stream, rd, () => o.local, ctx.onProgress).then((r) => r.size);
        run.then((size) => { stream.end(); finish(null, { size }); },
          (e) => finish(new Error(stderr.trim() ? `${e.message} – ${stderr.trim().slice(0, 200)}` : e.message)));
      });
    });
    c.connect({
      host: o.host, port, username: o.username, password: o.password, readyTimeout: 30000, keepaliveInterval: 15000,
      tryKeyboard: true, ...(o.legacy ? { algorithms: withLegacy() } : {}),
      hostVerifier: (key, verify) => {
        const store = ctx.hostKeys;
        const state = store.check(o.host, port, key);
        if (state === 'known') return verify(true);
        ctx.askHostKey({ host: o.host, port, fingerprint: fingerprint(key), type: keyType(key), state, old: store.known(o.host, port) })
          .then((ok) => { if (ok) store.remember(o.host, port, key); verify(Boolean(ok)); }, () => verify(false));
        return undefined;
      },
    });
    c.on('keyboard-interactive', (_n, _i, _l, prompts, done) => done(prompts.map(() => o.password)));
  });
}

/** Host-Schlüssel des eingebauten Servers: einmal erzeugen (RSA, das kennt jedes IOS), dann behalten. */
function loadHostKey(file) {
  try { return fs.readFileSync(file); } catch { /* neu erzeugen */ }
  const { utils } = require('ssh2');
  const key = utils.generateKeyPairSync('rsa', { bits: 3072 }).private;
  fs.writeFileSync(file, key, { mode: 0o600 });
  return Buffer.from(key);
}

function sameSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

class ScpServer extends EventEmitter {
  /**
   * @param {{root:string, port?:number, host?:string, allowWrite?:boolean, username:string, password:string, hostKeyFile:string}} o
   * Ereignisse: 'event' ({ts, text, kind}) wie beim TFTP-Server.
   */
  constructor(o) {
    super();
    this.root = path.resolve(o.root);
    this.port = o.port ?? 22;
    this.host = o.host || '0.0.0.0';
    this.allowWrite = Boolean(o.allowWrite);
    this.username = o.username;
    this.password = o.password;
    this.hostKey = loadHostKey(o.hostKeyFile);
    this.server = null;
    this.clients = new Set();
  }

  log(text, kind = 'info') { this.emit('event', { ts: Date.now(), text, kind }); }

  start() {
    const { Server } = require('ssh2');
    return new Promise((resolve, reject) => {
      this.server = new Server({ hostKeys: [this.hostKey], algorithms: withLegacy() }, (client, info) => this.onClient(client, info));
      this.server.on('error', (e) => {
        if (!this.listening) {
          if (e.code === 'EADDRINUSE') reject(new Error(`Port ${this.port} ist belegt${this.port === 22 ? ' (Entfernte Anmeldung in den macOS-Einstellungen an?)' : ''} – anderen Port wählen`));
          else if (e.code === 'EACCES') reject(new Error(`Port ${this.port} darf nicht geöffnet werden – Port über 1024 wählen, z. B. 2222`));
          else reject(e);
        } else this.log(e.message, 'err');
      });
      this.server.listen(this.port, this.host, () => {
        this.listening = true;
        this.port = this.server.address().port;
        this.log(`SCP-Server läuft auf Port ${this.port} (${this.allowWrite ? 'laden und hochladen' : 'nur laden'})`);
        resolve();
      });
    });
  }

  stop() {
    for (const c of this.clients) c.end();
    this.clients.clear();
    if (this.server) this.server.close();
    this.server = null;
    this.listening = false;
  }

  onClient(client, info) {
    const who = info.ip;
    this.clients.add(client);
    client.on('close', () => this.clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      const ok = ctx.username === this.username && (
        (ctx.method === 'password' && sameSecret(ctx.password, this.password)));
      if (ok) return ctx.accept();
      if (ctx.method === 'keyboard-interactive' && ctx.username === this.username) {
        ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => (answers && sameSecret(answers[0], this.password) ? ctx.accept() : ctx.reject()));
        return undefined;
      }
      if (ctx.method !== 'none') this.log(`${who}: Anmeldung abgelehnt (${ctx.username})`, 'err');
      return ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (a) => a && a());
      session.on('shell', (_a, rej) => rej && rej());
      session.on('exec', (acc, _rej, i) => {
        const stream = acc();
        this.handleExec(stream, i.command, who).catch((e) => this.log(`${who}: ${e.message}`, 'err')).finally(() => {
          stream.exit(0);
          stream.end();
        });
      });
    }));
  }

  async handleExec(stream, command, who) {
    const cmd = parseScpCommand(command);
    const fail = (msg) => { stream.write(Buffer.from(`\x02${msg}\n`)); throw new Error(msg); };
    if (!cmd) return fail('Nur scp wird unterstützt');
    if (cmd.error) return fail(cmd.error);
    const rel = cmd.path.replace(/^\.\//, '');
    const rd = new Reader(stream);
    const t0 = Date.now();
    if (cmd.dir === 'source') {
      const file = resolveInRoot(this.root, rel);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(`${rel}: Datei nicht gefunden`);
      this.log(`${who} lädt ${rel} …`);
      const size = await sendFile(stream, rd, file, path.basename(file)); // das Gerät beginnt mit einem OK-Byte
      this.log(`${who} hat ${rel} geladen (${fmtSize(size)} in ${((Date.now() - t0) / 1000).toFixed(1)} s)`, 'ok');
      return undefined;
    }
    if (!this.allowWrite) return fail('Hochladen ist an diesem Server ausgeschaltet');
    const r = await receiveFile(stream, rd, (h) => {
      const asDir = resolveInRoot(this.root, rel.replace(/\/+$/, ''));
      const isDir = !rel || rel === '.' || rel.endsWith('/') || Boolean(asDir && fs.existsSync(asDir) && fs.statSync(asDir).isDirectory());
      const name = isDir ? `${rel}${rel && !rel.endsWith('/') ? '/' : ''}${h.name}` : rel;
      const file = resolveInRoot(this.root, name);
      if (!file) throw new Error(`${name}: Pfad nicht erlaubt`);
      if (fs.existsSync(file)) throw new Error(`${name} gibt es schon – wird nicht überschrieben`);
      this.log(`${who} lädt ${name} hoch …`);
      return file;
    });
    this.log(`${who} hat ${path.relative(this.root, r.file)} hochgeladen (${fmtSize(r.size)} in ${((Date.now() - t0) / 1000).toFixed(1)} s)`, 'ok');
    return undefined;
  }
}

function fmtSize(n) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

module.exports = { ScpServer, transfer, parseHeader, parseScpCommand, quoteRemote, fmtSize, sendFile, receiveFile, Reader };
