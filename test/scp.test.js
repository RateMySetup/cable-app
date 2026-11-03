'use strict';
// SCP: eingebauter Server (laden, hochladen, Schutz des Ordners, Anmeldung) und Client (Mac → Gerät,
// Gerät → Mac). Dazu das echte OpenSSH-„scp -O“ (klassisches Protokoll wie bei Cisco) gegen den Server.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ScpServer, transfer, parseHeader, parseScpCommand, quoteRemote } = require('../src/core/scp');
const { HostKeyStore } = require('../src/core/hostkeys');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cable-scp-'));

async function server(o = {}) {
  const root = tmp();
  const srv = new ScpServer({ root, port: 0, host: '127.0.0.1', username: 'cable', password: 'geheim', hostKeyFile: path.join(tmp(), 'hostkey'), ...o });
  const events = [];
  srv.on('event', (e) => events.push(e));
  await srv.start();
  return { srv, root, events };
}

function client(srv, extra = {}) {
  const asked = [];
  const ctx = {
    hostKeys: new HostKeyStore(path.join(tmp(), 'known.json')),
    askHostKey: async (info) => { asked.push(info); return true; },
    ...extra,
  };
  return { ctx, asked, base: { host: '127.0.0.1', port: srv.port, username: 'cable', password: 'geheim' } };
}

test('Kopfzeilen und Befehle zerlegen', () => {
  assert.deepEqual(parseHeader('C0644 12 cat9k.bin'), { mode: 0o644, size: 12, name: 'cat9k.bin' });
  assert.equal(parseHeader('D0755 0 ordner'), null);
  assert.equal(parseHeader('C0644 12 ../x'), null);
  assert.deepEqual(parseScpCommand('scp -f /cat9k.bin'), { dir: 'source', path: '/cat9k.bin' });
  assert.deepEqual(parseScpCommand('scp -v -t flash:'), { dir: 'sink', path: 'flash:' });
  assert.ok(parseScpCommand('scp -r -t /').error);
  assert.equal(parseScpCommand('ls -la'), null);
  assert.equal(quoteRemote('flash:/cat9k_iosxe.17.15.03.SPA.bin'), 'flash:/cat9k_iosxe.17.15.03.SPA.bin');
  assert.equal(quoteRemote("a b'c"), "'a b'\\''c'");
});

test('Client lädt hoch und holt zurück, mit Fortschritt und Host-Schlüssel', async () => {
  const { srv, root, events } = await server({ allowWrite: true });
  try {
    const src = path.join(tmp(), 'image.bin');
    const data = crypto.randomBytes(3 * 1024 * 1024 + 17);
    fs.writeFileSync(src, data);
    const { ctx, asked, base } = client(srv);
    const prog = [];
    const put = await transfer({ ...base, direction: 'put', local: src, remote: 'image.bin' }, { ...ctx, onProgress: (p) => prog.push(p) });
    assert.equal(put.size, data.length);
    assert.ok(fs.readFileSync(path.join(root, 'image.bin')).equals(data));
    assert.equal(prog.at(-1).done, data.length);
    assert.equal(asked.length, 1, 'neuer Host-Schlüssel wird einmal gezeigt');
    assert.ok(events.some((e) => e.kind === 'ok' && /hochgeladen/.test(e.text)));

    const back = path.join(tmp(), 'zurueck.bin');
    const get = await transfer({ ...base, direction: 'get', local: back, remote: 'image.bin' }, ctx);
    assert.equal(get.size, data.length);
    assert.ok(fs.readFileSync(back).equals(data));
    assert.equal(asked.length, 1, 'bekannter Host-Schlüssel ohne Rückfrage');
    assert.equal(fs.readdirSync(path.dirname(back)).filter((f) => f.endsWith('.part')).length, 0);
  } finally { srv.stop(); }
});

test('Server: nur lesen, nie überschreiben, nicht aus dem Ordner heraus, falsches Passwort', async () => {
  const { srv, root } = await server({ allowWrite: false });
  try {
    const src = path.join(tmp(), 'x.cfg');
    fs.writeFileSync(src, 'hostname sw1\n');
    const { ctx, base } = client(srv);
    await assert.rejects(transfer({ ...base, direction: 'put', local: src, remote: 'x.cfg' }, ctx), /ausgeschaltet/);
    assert.equal(fs.existsSync(path.join(root, 'x.cfg')), false);
    await assert.rejects(transfer({ ...base, direction: 'get', local: path.join(tmp(), 'p'), remote: '../../etc/passwd' }, ctx), /nicht gefunden/);
    await assert.rejects(transfer({ ...base, password: 'falsch', direction: 'get', local: path.join(tmp(), 'q'), remote: 'x' }, ctx), /authentication/i);
  } finally { srv.stop(); }

  const w = await server({ allowWrite: true });
  try {
    fs.writeFileSync(path.join(w.root, 'da.cfg'), 'alt');
    const src = path.join(tmp(), 'da.cfg');
    fs.writeFileSync(src, 'neu');
    const { ctx, base } = client(w.srv);
    await assert.rejects(transfer({ ...base, direction: 'put', local: src, remote: 'da.cfg' }, ctx), /überschrieben|gibt es schon/);
    assert.equal(fs.readFileSync(path.join(w.root, 'da.cfg'), 'utf8'), 'alt');
    // Ziel als Ordner: Name aus der Kopfzeile
    fs.mkdirSync(path.join(w.root, 'cfg'));
    await transfer({ ...base, direction: 'put', local: src, remote: 'cfg/' }, ctx);
    assert.equal(fs.readFileSync(path.join(w.root, 'cfg', 'da.cfg'), 'utf8'), 'neu');
  } finally { w.srv.stop(); }
});

test('Server: Port belegt gibt verständlichen Fehler', async () => {
  const a = await server();
  try {
    const b = new ScpServer({ root: tmp(), port: a.srv.port, host: '127.0.0.1', username: 'u', password: 'p', hostKeyFile: path.join(tmp(), 'k') });
    await assert.rejects(b.start(), /belegt/);
  } finally { a.srv.stop(); }
});

test('OpenSSH scp -O (klassisches Protokoll wie Cisco) gegen den Server', { skip: process.platform === 'win32' }, async () => {
  const { srv, root } = await server({ allowWrite: true });
  try {
    fs.writeFileSync(path.join(root, 'c9300.bin'), 'IMAGE'.repeat(5000));
    const dir = tmp();
    const askpass = path.join(dir, 'askpass.sh');
    fs.writeFileSync(askpass, '#!/bin/sh\necho geheim\n', { mode: 0o700 });
    const scp = (args) => new Promise((resolve, reject) => execFile('scp', ['-O', '-P', String(srv.port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', ...args],
    { env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' }, timeout: 20000 }, (e, _o, err) => (e ? reject(new Error(err || e.message)) : resolve())));
    await scp(['cable@127.0.0.1:/c9300.bin', path.join(dir, 'geladen.bin')]);
    assert.equal(fs.readFileSync(path.join(dir, 'geladen.bin'), 'utf8'), 'IMAGE'.repeat(5000));
    fs.writeFileSync(path.join(dir, 'sw1-confg.txt'), 'hostname sw1\n');
    await scp([path.join(dir, 'sw1-confg.txt'), 'cable@127.0.0.1:/']);
    assert.equal(fs.readFileSync(path.join(root, 'sw1-confg.txt'), 'utf8'), 'hostname sw1\n');
  } finally { srv.stop(); }
});
