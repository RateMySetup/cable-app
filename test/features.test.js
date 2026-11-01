'use strict';
// Neu in 0.2: TFTP-Server (echte UDP-Übertragungen), Auto-Anmeldung für Telnet/Serial, Gruppen,
// Passwörter aus dem Profil-Formular, Ergänzen neuer Bausteine, Übernahme der Daten aus „Kabel“.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TftpServer, parseRequest, resolveInRoot, negotiate, OP } = require('../src/core/tftp');
const { AutoLogin } = require('../src/core/autologin');
const { Store, DEFAULT_SNIPPETS } = require('../src/core/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cable-'));
const crypt = { available: () => true, encrypt: (t) => Buffer.from([...Buffer.from(t)].map((b) => b ^ 0x5a)), decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString() };

function request(op, file, options = {}, mode = 'octet') {
  const parts = [file, mode, ...Object.entries(options).flatMap(([k, v]) => [k, String(v)])];
  const head = Buffer.alloc(2);
  head.writeUInt16BE(op);
  return Buffer.concat([head, Buffer.from(parts.map((p) => p + '\0').join(''), 'latin1')]);
}
const ackPkt = (n) => { const b = Buffer.alloc(4); b.writeUInt16BE(OP.ACK, 0); b.writeUInt16BE(n & 0xffff, 2); return b; };

/** Minimaler TFTP-Client: lädt eine Datei, beantwortet OACK und DATA, liefert Inhalt oder Fehler. */
function download(port, file, options = {}) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const chunks = [];
    const blk = Number(options.blksize) || 512;
    let oackSeen = null;
    const t = setTimeout(() => { s.close(); reject(new Error('Zeitüberschreitung')); }, 5000);
    s.on('message', (m, r) => {
      const op = m.readUInt16BE(0);
      if (op === OP.ERROR) { clearTimeout(t); s.close(); resolve({ error: m.readUInt16BE(2) }); return; }
      if (op === OP.OACK) { oackSeen = m.subarray(2).toString('latin1'); s.send(ackPkt(0), r.port, r.address); return; }
      if (op === OP.DATA) {
        const n = m.readUInt16BE(2);
        chunks.push(m.subarray(4));
        s.send(ackPkt(n), r.port, r.address);
        if (m.length - 4 < blk) { clearTimeout(t); setTimeout(() => s.close(), 20); resolve({ data: Buffer.concat(chunks), oack: oackSeen, blocks: chunks.length }); }
      }
    });
    s.bind(0, () => s.send(request(OP.RRQ, file, options), port, '127.0.0.1'));
  });
}

/** Minimaler TFTP-Client zum Hochladen. */
function upload(port, file, data, blk = 512) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { s.close(); reject(new Error('Zeitüberschreitung')); }, 5000);
    const total = Math.floor(data.length / blk) + 1;
    s.on('message', (m, r) => {
      const op = m.readUInt16BE(0);
      if (op === OP.ERROR) { clearTimeout(t); s.close(); resolve({ error: m.readUInt16BE(2) }); return; }
      if (op !== OP.ACK) return;
      const n = m.readUInt16BE(2);
      if (n >= total) { clearTimeout(t); s.close(); resolve({ ok: true }); return; }
      const b = Buffer.alloc(4);
      b.writeUInt16BE(OP.DATA, 0);
      b.writeUInt16BE(n + 1, 2);
      s.send(Buffer.concat([b, data.subarray(n * blk, (n + 1) * blk)]), r.port, r.address);
    });
    s.bind(0, () => s.send(request(OP.WRQ, file), port, '127.0.0.1'));
  });
}

async function server(opts = {}) {
  const root = tmp();
  const srv = new TftpServer({ root, port: 0, host: '127.0.0.1', timeoutMs: 300, ...opts });
  const events = [];
  srv.on('event', (e) => events.push(e));
  await srv.start();
  return { srv, root, events };
}

test('TFTP: Anfragen zerlegen, Pfade nur im Ordner, Optionen aushandeln', () => {
  const r = parseRequest(request(OP.RRQ, 'image.bin', { blksize: 1428, tsize: 0 }));
  assert.deepEqual(r, { op: OP.RRQ, file: 'image.bin', mode: 'octet', options: { blksize: '1428', tsize: '0' } });
  assert.equal(parseRequest(Buffer.from([0, 3, 0, 1])), null);
  const root = tmp();
  assert.equal(resolveInRoot(root, '/c9300.bin'), path.join(root, 'c9300.bin'));
  assert.equal(resolveInRoot(root, 'configs/sw1.txt'), path.join(root, 'configs/sw1.txt'));
  for (const bad of ['../etc/passwd', 'a/../../x', 'C:\\boot.ini', '', 'a//b', 'x\0y']) assert.equal(resolveInRoot(root, bad), null, bad);
  assert.deepEqual(negotiate({ blksize: '99999', tsize: '0', timeout: '3', foo: '1' }, 4000), { blksize: 65464, tsize: 4000, timeout: 3 });
  assert.deepEqual(negotiate({ blksize: '4' }, 10), {});
});

test('TFTP: Datei laden – ohne Optionen, mit blksize/tsize, genau volle Blöcke', async () => {
  const { srv, root, events } = await server();
  try {
    const data = crypto.randomBytes(1300);
    fs.writeFileSync(path.join(root, 'img.bin'), data);
    const a = await download(srv.port, 'img.bin');
    assert.ok(a.data.equals(data));
    assert.equal(a.blocks, 3);
    const b = await download(srv.port, '/img.bin', { blksize: 1024, tsize: 0 });
    assert.ok(b.data.equals(data));
    assert.match(b.oack, /blksize\0001024\0tsize\0001300\0/);
    fs.writeFileSync(path.join(root, 'voll.bin'), crypto.randomBytes(1024));
    const c = await download(srv.port, 'voll.bin');
    assert.equal(c.data.length, 1024);
    assert.equal(c.blocks, 3); // 512 + 512 + leerer Abschlussblock
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(events.some((e) => e.kind === 'ok' && /img\.bin/.test(e.text)));
  } finally { srv.stop(); }
});

test('TFTP: fehlende Datei, Pfad nach außen und Uploads ohne Freigabe werden abgelehnt', async () => {
  const { srv } = await server();
  try {
    assert.equal((await download(srv.port, 'fehlt.bin')).error, 1);
    assert.equal((await download(srv.port, '../../etc/passwd')).error, 2);
    assert.equal((await upload(srv.port, 'sw1-confg', Buffer.from('hostname sw1\n'))).error, 2);
  } finally { srv.stop(); }
});

test('TFTP: Hochladen mit Freigabe, nie über bestehende Dateien', async () => {
  const { srv, root } = await server({ allowWrite: true });
  try {
    const cfg = Buffer.from('hostname sw1\n!\n'.repeat(80));
    assert.deepEqual(await upload(srv.port, 'sw1-confg.txt', cfg), { ok: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.readFileSync(path.join(root, 'sw1-confg.txt')).equals(cfg));
    assert.equal((await upload(srv.port, 'sw1-confg.txt', Buffer.from('x'))).error, 6);
  } finally { srv.stop(); }
});

test('TFTP: belegter Port gibt verständliche Meldung', async () => {
  const { srv, root } = await server();
  try {
    const second = new TftpServer({ root, port: srv.port, host: '127.0.0.1' });
    await assert.rejects(second.start(), /belegt/);
  } finally { srv.stop(); }
});

test('Auto-Anmeldung: je einmal Benutzer und Passwort, über Paketgrenzen, danach nicht mehr', () => {
  const sent = [];
  const a = new AutoLogin({ username: 'admin', password: 'geheim' }, (t) => sent.push(t));
  a.feed('\r\nUser Access Verification\r\n\r\nUser');
  a.feed('name: ');
  a.feed('\r\nPass');
  a.feed('word: ');
  a.feed('\r\n% Authentication failed\r\n\r\nPassword: ');
  assert.deepEqual(sent, ['admin\r', 'geheim\r']);
  const b = [];
  const only = new AutoLogin({ username: '', password: 'pw' }, (t) => b.push(t));
  only.feed('Username: ');
  only.feed('\x1b[1mPassword:\x1b[0m ');
  assert.deepEqual(b, ['pw\r']);
});

test('Profile: Passwort aus dem Formular nur mit „speichern“, Telnet mit Benutzer', () => {
  const st = new Store(tmp(), crypt);
  const a = st.upsertSession({ protocol: 'telnet', host: '10.0.0.5', port: 23, username: 'admin', password: 'pw1', savePassword: true });
  assert.equal(a.username, 'admin');
  assert.equal(a.password, undefined);
  assert.equal(st.getSecret(a.id), 'pw1');
  st.upsertSession({ ...a, password: '' });
  assert.equal(st.getSecret(a.id), 'pw1', 'leeres Feld behält das gespeicherte Passwort');
  st.upsertSession({ ...a, savePassword: false, password: 'pw2' });
  assert.equal(st.getSecret(a.id), null);
  assert.ok(!fs.readFileSync(st.file, 'utf8').includes('pw1'));
});

test('Gruppen: höchstens 50, nur bekannte Profile, Löschen eines Profils räumt auf', () => {
  const st = new Store(tmp(), crypt);
  const ids = Array.from({ length: 51 }, (_, i) => st.upsertSession({ protocol: 'ssh', host: `10.0.0.${i + 1}`, name: `SW${i + 1}` }).id);
  assert.throws(() => st.saveGroup({ name: 'Zu viele', sessionIds: ids }), /50/);
  assert.throws(() => st.saveGroup({ name: '', sessionIds: ids.slice(0, 2) }), /Name/);
  assert.throws(() => st.saveGroup({ name: 'Leer', sessionIds: ['gibt-es-nicht'] }), /leer/);
  const g = st.saveGroup({ name: 'Etage 2', sessionIds: [...ids.slice(0, 50), ids[0], 'fremd'] });
  assert.equal(g.sessionIds.length, 50);
  st.deleteSession(ids[0]);
  assert.equal(st.data.groups[0].sessionIds.length, 49);
  st.deleteGroup(g.id);
  assert.equal(st.data.groups.length, 0);
});

test('Bausteine: neue Vorgaben werden ergänzt, eigene bleiben; Daten aus kabel.json werden gelesen', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'kabel.json'), JSON.stringify({ sessions: [{ id: 'abcdef12', name: 'Alt', protocol: 'ssh', host: 'h', port: 22 }], snippets: [{ id: 'mein', group: 'Eigene', name: 'X', text: 'x\n' }, DEFAULT_SNIPPETS.find((s) => s.id === 'cisco-vlan')] }));
  const st = new Store(dir, crypt);
  assert.equal(st.data.sessions[0].name, 'Alt');
  assert.ok(st.data.snippets.some((s) => s.id === 'mein'));
  assert.equal(st.data.snippets.length, DEFAULT_SNIPPETS.length + 1);
  assert.equal(st.data.snippets.filter((s) => s.id === 'cisco-vlan').length, 1);
  st.save();
  assert.ok(fs.existsSync(path.join(dir, 'cable.json')));
  assert.equal(new Store(dir, crypt).data.snippets.length, DEFAULT_SNIPPETS.length + 1);
});
