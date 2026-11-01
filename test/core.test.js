'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TelnetParser, negotiate, naws, escapeOut, IAC, DO, WILL, WONT, NAWS, ECHO } = require('../src/core/telnet');
const { compile, apply, stripAnsi, splitTail, migrateRules, DEFAULT_RULES } = require('../src/core/highlight');
const { parseSshConfig, parsePuttyReg, decodeReg } = require('../src/core/importers');
const { parseCableUrl, parseQuick } = require('../src/core/cableurl');
const { parseRequest } = require('../src/core/socks');
const { Store, sanitizeSession } = require('../src/core/store');
const { HostKeyStore } = require('../src/core/hostkeys');
const { SessionLog } = require('../src/core/logger');

test('Telnet: Befehle über Paketgrenzen, IAC IAC als Datenbyte', () => {
  const p = new TelnetParser();
  const a = p.feed(Buffer.from([65, IAC]));
  const b = p.feed(Buffer.from([DO, NAWS, 66, IAC, IAC, 67]));
  assert.equal(Buffer.concat([a.data, b.data]).toString('latin1'), 'AB\xffC');
  assert.deepEqual(b.commands, [{ verb: DO, option: NAWS }]);
});

test('Telnet: Verhandlung nimmt Echo und NAWS an, lehnt Unbekanntes ab', () => {
  const opts = { cols: 120, rows: 40, term: 'xterm' };
  assert.deepEqual([...negotiate({ verb: WILL, option: ECHO }, opts)], [IAC, DO, ECHO]);
  assert.deepEqual([...negotiate({ verb: DO, option: 99 }, opts)], [IAC, WONT, 99]);
  const r = negotiate({ verb: DO, option: NAWS }, opts);
  assert.deepEqual([...r.subarray(0, 3)], [IAC, WILL, NAWS]);
  assert.deepEqual([...naws(255, 24)], [IAC, 250, NAWS, 0, IAC, IAC, 0, 24, IAC, 240]);
  assert.deepEqual([...escapeOut(Buffer.from([1, 255, 2]))], [1, 255, 255, 2]);
});

test('Hervorhebung färbt Treffer, lässt Escape-Sequenzen und vorgefärbte Ausgabe in Ruhe', () => {
  const c = compile(DEFAULT_RULES);
  const out = apply('Gi1/0/1 is down, line protocol is up\r\n', c);
  assert.match(out, /\x1b\[31mdown\x1b\[22;24;39m/);
  assert.match(out, /\x1b\[32mup\x1b\[22;24;39m/);
  assert.equal(stripAnsi(out), 'Gi1/0/1 is down, line protocol is up\n');
  const cursor = '\x1b[2J\x1b[Hdown';
  assert.ok(apply(cursor, c).startsWith('\x1b[2J\x1b[H'));
  const colored = '\x1b[32mup\x1b[0m down';
  assert.equal(apply(colored, c), colored);
  assert.match(apply('% Invalid input detected at ^ marker.\r\n', c), /^\x1b\[31m% Invalid/);
  assert.equal(compile([{ pattern: '(', color: 'red' }, { pattern: 'x', color: 'pink' }]).errors.length, 2);
});

test('Hervorhebung: IP, Hardwaremodell und Seriennummer in eigenen, fetten Farben', () => {
  const c = compile(DEFAULT_RULES);
  const colorOf = (line, word) => {
    const m = apply(line, c).match(new RegExp(`\\x1b\\[([0-9;]+)m${word.replace(/[.+/]/g, '\\$&')}\\x1b`));
    return m && m[1];
  };
  const inv = 'PID: WS-C3850-48P-S  , VID: V07  , SN: FOC1234X0AB';
  assert.equal(colorOf(inv, 'WS-C3850-48P-S'), '94;1');
  assert.equal(colorOf(inv, 'FOC1234X0AB'), '38;5;208;1');
  assert.equal(colorOf('System Serial Number            : FOC2135X0AB', 'FOC2135X0AB'), '38;5;208;1');
  assert.equal(colorOf('MS225-48LP Q2XX-ABCD-1234', 'Q2XX-ABCD-1234'), '38;5;208;1');
  assert.equal(colorOf('cisco C9300-48UXM (X86) processor', 'C9300-48UXM'), '94;1');
  assert.equal(colorOf('ip address 10.1.2.3/24', '10.1.2.3/24'), '96;1');
  assert.equal(colorOf('ipv6 address 2001:db8::5/64', '2001:db8::5/64'), '96;1');
  assert.equal(colorOf('%LINK-3-UPDOWN: x', '%LINK-3-UPDOWN'), '31');
  // Keine Fehltreffer: Wort „Number“, Interface Serial0/0/0, Uhrzeit
  assert.equal(stripAnsi(apply('Serial Number : x', c)), 'Serial Number : x');
  assert.equal(apply('Serial0/0/0 at 00:01:02', c), 'Serial0/0/0 at 00:01:02');
});

test('Hervorhebung: alte Standardregeln werden ersetzt, eigene bleiben; Wortrest wird zurückgehalten', () => {
  const own = { pattern: 'core-sw\\d+', color: 'green' };
  const old = [{ pattern: '\\b(up|connected|established|success|ok|FULL)\\b', color: 'green' }, own];
  assert.deepEqual(migrateRules(old), [...DEFAULT_RULES, own]);
  assert.deepEqual(migrateRules(undefined), DEFAULT_RULES);
  assert.deepEqual(splitTail('IP 10.1.'), ['IP ', '10.1.']);
  assert.deepEqual(splitTail('Switch#\r\n'), ['Switch#\r\n', '']);
  assert.deepEqual(splitTail('\x1b[2J'), ['\x1b[2J', '']);
  assert.equal(compile([{ pattern: 'x', color: 'orange+bold' }, { pattern: 'x', color: 'cyan+blink' }]).errors.length, 1);
});

test('Import: ~/.ssh/config ohne Wildcards, mit Port, Schlüssel, Jump', () => {
  const s = parseSshConfig(`Host *\n  ServerAliveInterval 30\nHost core sw1\n  HostName 10.0.0.1\n  User admin\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\n  ProxyJump bastion\nHost bastion\n  HostName bastion.example.org\n`);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { name: 'core', protocol: 'ssh', host: '10.0.0.1', port: 2222, folder: 'SSH-Config', username: 'admin', keyPath: '~/.ssh/id_ed25519', jump: 'bastion' });
});

test('Import: PuTTY-Registry (UTF-16) mit SSH-, Telnet- und Serial-Sitzung', () => {
  const reg = 'Windows Registry Editor Version 5.00\r\n\r\n'
    + '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]\r\n"HostName"=""\r\n\r\n'
    + '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Core%20Switch]\r\n"HostName"="10.1.1.1"\r\n"Protocol"="ssh"\r\n"PortNumber"=dword:00000016\r\n"UserName"="admin"\r\n\r\n'
    + '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Konsole]\r\n"HostName"="term1"\r\n"Protocol"="telnet"\r\n"PortNumber"=dword:000007d1\r\n\r\n'
    + '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\COM3]\r\n"Protocol"="serial"\r\n"SerialLine"="COM3"\r\n"SerialSpeed"=dword:00002580\r\n';
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(reg, 'utf16le')]);
  const s = parsePuttyReg(decodeReg(buf));
  assert.deepEqual(s.map((x) => [x.name, x.protocol, x.host || x.path, x.port || x.baudRate]), [
    ['Core Switch', 'ssh', '10.1.1.1', 22], ['Konsole', 'telnet', 'term1', 2001], ['COM3', 'serial', 'COM3', 9600]]);
  assert.equal(s[0].username, 'admin');
});

test('cable://- und alte kabel://-Links und Schnellverbindung werden streng geprüft', () => {
  assert.deepEqual(parseCableUrl('kabel://ssh/admin@10.0.0.1:2222'), { protocol: 'ssh', name: '10.0.0.1', host: '10.0.0.1', port: 2222, username: 'admin' });
  assert.equal(parseCableUrl('cable://telnet/10.0.0.9:2001').port, 2001);
  assert.equal(parseCableUrl('kabel://telnet/term1').port, 23);
  assert.equal(parseCableUrl('kabel://serial/cu.usbserial-1410?baud=115200').path, '/dev/cu.usbserial-1410');
  assert.deepEqual(parseCableUrl('kabel://session/Core'), { open: 'Core' });
  for (const bad of ['http://x', 'kabel://ssh/a;rm -rf@host', 'kabel://ssh/host:99999', 'kabel://serial/../etc/passwd', 'kabel://exec/ls', 'kabel://serial/cu.x?baud=1234']) {
    assert.equal(parseCableUrl(bad), null, bad);
  }
  assert.equal(parseQuick('telnet 10.0.0.5 2001').port, 2001);
  assert.equal(parseQuick('/dev/cu.usbserial-1 9600').baudRate, 9600);
  assert.equal(parseQuick('root@host').username, 'root');
  assert.equal(parseQuick('ls -la /'), null);
});

test('SOCKS5: Begrüßung und CONNECT mit Domain, IPv4, Fehler', () => {
  assert.deepEqual(parseRequest(Buffer.from([5, 1, 0])), { need: true });
  const dom = Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, 11]), Buffer.from('example.org'), Buffer.from([1, 187])]);
  const r = parseRequest(dom);
  assert.equal(r.host, 'example.org');
  assert.equal(r.port, 443);
  assert.equal(parseRequest(Buffer.from([5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 1, 0, 22])).host, '10.0.0.1');
  assert.ok(parseRequest(Buffer.from([4, 1])).error);
  assert.ok(parseRequest(Buffer.from([5, 1, 0, 5, 2, 0, 1, 1, 1, 1, 1, 0, 1])).error); // BIND
});

test('Sitzungen: Prüfung, Passwort nur verschlüsselt, Löschen entfernt Passwort', () => {
  assert.throws(() => sanitizeSession({ protocol: 'ssh' }), /Host/);
  assert.throws(() => sanitizeSession({ protocol: 'serial', path: '/etc/passwd/../x' }), /Anschluss/);
  assert.throws(() => sanitizeSession({ protocol: 'ftp', host: 'x' }), /Protokoll/);
  const s = sanitizeSession({ protocol: 'ssh', host: 'h', port: '2200', forwards: [{ type: 'L', bindPort: 8080, host: 'web', port: 80 }, { type: 'X' }], evil: 1 });
  assert.equal(s.port, 2200);
  assert.equal(s.forwards.length, 1);
  assert.equal(s.evil, undefined);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kabel-'));
  const crypt = { available: () => true, encrypt: (t) => Buffer.from([...Buffer.from(t)].map((b) => b ^ 0x5a)), decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString() };
  const st = new Store(dir, crypt);
  const saved = st.upsertSession({ protocol: 'ssh', host: '10.0.0.1', name: 'Core', savePassword: true });
  st.setSecret(saved.id, 'geheim');
  assert.equal(st.getSecret(saved.id), 'geheim');
  assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('geheim'));
  assert.equal(st.importSessions([{ protocol: 'ssh', name: 'Core', host: '10.0.0.1' }, { protocol: 'ssh', name: 'Neu', host: 'n' }]), 1);
  st.deleteSession(saved.id);
  assert.equal(st.getSecret(saved.id), null);
  const st2 = new Store(dir, { ...crypt, available: () => false });
  st2.setSecret('x', 'y');
  assert.equal(st2.getSecret('x'), null);
});

test('Host-Schlüssel: neu, bekannt, geändert', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kabel-')), 'hk.json');
  const hk = new HostKeyStore(file);
  const k1 = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from('a')]);
  const k2 = Buffer.concat([k1, Buffer.from('b')]);
  assert.equal(hk.check('h', 22, k1), 'new');
  hk.remember('h', 22, k1);
  assert.equal(new HostKeyStore(file).check('h', 22, k1), 'known');
  assert.equal(hk.check('h', 22, k2), 'changed');
  assert.equal(hk.known('h', 22).type, 'ssh-ed25519');
});

test('Protokoll: Zeitstempel je Zeile, ohne Farbcodes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kabel-'));
  const log = new SessionLog(dir, 'Core Switch/1');
  log.write(Buffer.from('\x1b[31mzeile1\x1b[0m\r\nzei'));
  log.write('le2\n');
  log.close();
  await new Promise((r) => log.out.on('finish', r));
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(path.basename(log.file), /^Core_Switch_1-\d{8}-\d{6}\.log$/);
  assert.match(text, /\[\d\d:\d\d:\d\d\] zeile1\n\[\d\d:\d\d:\d\d\] zeile2\n/);
  assert.ok(!text.includes('\x1b'));
});

test('Staging: nur aus staging.json, Beispieldatei mit 3 Servern und 16 Telnet-Konsolen ab 10001', () => {
  const { parseStaging, stagingPorts, stagingSession } = require('../src/core/staging');
  const cfg = parseStaging(fs.readFileSync(path.join(__dirname, '../docs/staging.example.json'), 'utf8'));
  assert.deepEqual(cfg.servers.map((p) => p.host), ['192.0.2.21', '192.0.2.22', '192.0.2.36']);
  assert.equal(cfg.title, 'Staging');
  const ports = stagingPorts(cfg);
  assert.equal(ports.length, 16);
  assert.equal(ports[15], 10016);
  const s = stagingSession(cfg, cfg.servers[2], 3);
  assert.equal(s.protocol, 'telnet');
  assert.equal(s.port, 10003);
  assert.equal(s.host, '192.0.2.36');
  assert.doesNotThrow(() => require('../src/core/store').sanitizeSession(s));
  assert.throws(() => stagingSession(cfg, cfg.servers[0], 17));
  // Vorgaben, Grenzen und kaputte Dateien
  assert.deepEqual(stagingPorts(parseStaging({ servers: [{ host: 'ts1' }], firstPort: 2001, consoles: 4 })), [2001, 2002, 2003, 2004]);
  assert.equal(parseStaging({ servers: [{ host: 'ts1' }] }).servers[0].name, 'ts1');
  assert.throws(() => parseStaging('{}'), /servers/);
  assert.throws(() => parseStaging('kein json'));
  assert.throws(() => parseStaging({ servers: [{ host: 'a b; rm -rf' }] }), /Host/);
  assert.throws(() => parseStaging({ servers: [{ host: 'ts1' }], consoles: 65 }), /consoles/);
  assert.throws(() => parseStaging({ servers: [{ host: 'ts1' }], firstPort: 65530, consoles: 16 }), /65535/);
});
