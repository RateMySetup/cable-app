'use strict';
// Echte Verbindungen gegen Test-Server im selben Prozess: SSH (ssh2-Server), Telnet, Raw, Tunnel.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Server, utils } = require('ssh2');
const { open } = require('../src/core/connections');
const { HostKeyStore } = require('../src/core/hostkeys');
const { IAC, DO, NAWS } = require('../src/core/telnet');

const hostKey = utils.generateKeyPairSync('ed25519').private;

function sshServer(onTcpip) {
  return new Promise((resolve) => {
    const srv = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === 'admin' && ctx.password === 'pw') ctx.accept();
        else ctx.reject(['password']);
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (a) => a && a());
          session.on('window-change', (a) => a && a());
          session.on('shell', (a) => {
            const st = a();
            st.write('Switch>');
            st.on('data', (d) => { st.write(d); if (String(d).includes('exit')) { st.exit(0); st.end(); } });
          });
        });
        client.on('tcpip', (accept, reject, info) => onTcpip ? onTcpip(accept, reject, info) : reject());
      });
      client.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function collect(conn) {
  const chunks = [];
  conn.on('data', (d) => chunks.push(d));
  return () => Buffer.concat(chunks).toString();
}

function once(em, ev) { return new Promise((res, rej) => { em.once(ev, res); if (ev !== 'error') em.once('error', rej); }); }
async function until(fn, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('Zeitüberschreitung'); await new Promise((r) => setTimeout(r, 20)); } }

function ctx(hk, answers = {}) {
  const asked = [];
  return {
    asked, cols: 80, rows: 24, hostKeys: hk,
    ask: {
      hostKey: async (i) => { asked.push(['hostKey', i.state]); return answers.hostKey ?? true; },
      secret: async (p) => { asked.push(['secret', p]); return answers.secret ?? 'pw'; },
      keyboard: async () => { asked.push(['keyboard']); return []; },
    },
  };
}

test('SSH: Passwort abfragen, Host-Schlüssel merken, Shell-Ein-/Ausgabe, Größe ändern', async () => {
  const srv = await sshServer();
  const port = srv.address().port;
  const hk = new HostKeyStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kabel-')), 'hk.json'));
  const s = { protocol: 'ssh', host: '127.0.0.1', port, username: 'admin', auth: 'password' };
  const c1 = ctx(hk);
  const conn = open(s, c1);
  const out = collect(conn);
  await once(conn, 'ready');
  conn.resize(100, 30);
  conn.write('show ver\r');
  await until(() => out().includes('show ver'));
  assert.ok(out().startsWith('Switch>'));
  assert.deepEqual(c1.asked.map((a) => a[0]), ['hostKey', 'secret']);
  conn.close();

  // Zweites Mal: Schlüssel bekannt → keine Rückfrage zum Host.
  const c2 = ctx(hk);
  const conn2 = open(s, { ...c2, password: 'pw' });
  await once(conn2, 'ready');
  assert.deepEqual(c2.asked, []);
  conn2.close();
  srv.close();
});

test('SSH: geänderter Host-Schlüssel und Ablehnen bricht ab', async () => {
  const srv = await sshServer();
  const port = srv.address().port;
  const hk = new HostKeyStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kabel-')), 'hk.json'));
  hk.remember('127.0.0.1', port, Buffer.from('anderer-schluessel'));
  const c = ctx(hk, { hostKey: false });
  const conn = open({ protocol: 'ssh', host: '127.0.0.1', port, username: 'admin', auth: 'password' }, { ...c, password: 'pw' });
  const err = await once(conn, 'error');
  assert.match(String(err.message), /verif|Host/i);
  assert.deepEqual(c.asked, [['hostKey', 'changed']]);
  srv.close();
});

test('SSH: falsches Passwort meldet Fehler', async () => {
  const srv = await sshServer();
  const hk = new HostKeyStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kabel-')), 'hk.json'));
  const conn = open({ protocol: 'ssh', host: '127.0.0.1', port: srv.address().port, username: 'admin', auth: 'password' }, { ...ctx(hk), password: 'falsch' });
  const err = await once(conn, 'error');
  assert.match(err.message, /authentication/i);
  srv.close();
});

test('SSH: lokale Weiterleitung und SOCKS über den Tunnel', async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;
  const srv = await sshServer((accept, reject, info) => {
    const st = accept();
    const sock = net.connect(info.destPort, info.destIP);
    st.pipe(sock).pipe(st);
  });
  const hk = new HostKeyStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kabel-')), 'hk.json'));
  const lport = 20000 + crypto.randomInt(20000);
  const conn = open({ protocol: 'ssh', host: '127.0.0.1', port: srv.address().port, username: 'admin', auth: 'password',
    forwards: [{ type: 'L', bindPort: lport, host: '127.0.0.1', port: echoPort }, { type: 'D', bindPort: lport + 1 }] }, { ...ctx(hk), password: 'pw' });
  const notices = [];
  conn.on('notice', (n) => notices.push(n));
  await once(conn, 'ready');
  assert.equal(notices.filter((n) => n.startsWith('Weiterleitung aktiv')).length, 2);

  const viaL = await roundTrip(net.connect(lport, '127.0.0.1'), 'hallo');
  assert.equal(viaL, 'hallo');

  const sock = net.connect(lport + 1, '127.0.0.1');
  await once(sock, 'connect');
  sock.write(Buffer.from([5, 1, 0]));
  await once(sock, 'data');
  sock.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, echoPort >> 8, echoPort & 255]));
  const reply = await once(sock, 'data');
  assert.equal(reply[1], 0);
  assert.equal(await roundTrip(sock, 'socks'), 'socks');
  conn.close();
  srv.close();
  echo.close();
});

async function roundTrip(sock, text) {
  if (sock.connecting) await once(sock, 'connect');
  sock.write(text);
  const d = await once(sock, 'data');
  sock.destroy();
  return d.toString();
}

test('Telnet: NAWS-Verhandlung und Daten', async () => {
  let got = Buffer.alloc(0);
  const srv = net.createServer((s) => {
    s.write(Buffer.concat([Buffer.from([IAC, DO, NAWS]), Buffer.from('Username: ')]));
    s.on('data', (d) => { got = Buffer.concat([got, d]); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const conn = open({ protocol: 'telnet', host: '127.0.0.1', port: srv.address().port }, { cols: 132, rows: 50 });
  const out = collect(conn);
  await until(() => out().includes('Username: '));
  conn.write('admin\r');
  await until(() => got.includes(Buffer.from('admin')));
  assert.ok(got.includes(Buffer.from([IAC, 250, NAWS, 0, 132, 0, 50])), 'Fenstergröße gesendet');
  conn.resize(100, 40);
  await until(() => got.includes(Buffer.from([0, 100, 0, 40])));
  conn.close();
  srv.close();
});

test('Raw TCP und Fehlermeldung bei geschlossenem Port', async () => {
  const srv = net.createServer((s) => s.end('banner\r\n'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const conn = open({ protocol: 'raw', host: '127.0.0.1', port: srv.address().port }, {});
  const out = collect(conn);
  await once(conn, 'close');
  assert.equal(out(), 'banner\r\n');
  const port = srv.address().port;
  srv.close();
  await new Promise((r) => setTimeout(r, 50));
  const bad = open({ protocol: 'raw', host: '127.0.0.1', port }, {});
  const err = await once(bad, 'error');
  assert.match(err.code, /ECONNREFUSED/);
});
