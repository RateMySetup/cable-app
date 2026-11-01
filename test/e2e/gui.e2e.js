'use strict';
// Oberflächen-Test mit echtem Electron: Verbinden mit getrennten Feldern, langer Befehl bleibt im Fenster,
// Profil, Bereiche im Raster, einzeln schließen, An mehrere (Auswahl/Tab), Fokus mit Fehlerliste,
// Aufzeichnen, Verlauf speichern, Gruppe, TFTP-Server, dunkel.
// Aufruf: node test/e2e/gui.e2e.js [screenshot-dir]   (Linux: xvfb-run -a …)
const { _electron: electron } = require('playwright-core');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Server, utils } = require('ssh2');

const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'cable-shots-'));
fs.mkdirSync(shots, { recursive: true });
const received = []; // je Shell-Sitzung: {n, data}
let sessionNo = 0;

function sshServer() {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  return new Promise((resolve) => {
    const srv = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'pw' ? ctx.accept() : ctx.reject(['password'])));
      client.on('ready', () => client.on('session', (accept) => {
        const s = accept();
        s.on('pty', (a) => a && a());
        s.on('window-change', (a) => a && a());
        s.on('shell', (a) => {
          const st = a();
          const n = ++sessionNo;
          const name = `SW${n}`;
          st.write(`\r\n${name}#`);
          let line = '';
          st.on('data', (d) => {
            received.push({ n, data: String(d) });
            st.write(d);
            line += String(d);
            if (!line.includes('\r')) return;
            const cmd = line.trim();
            line = '';
            if (/bogus/.test(cmd)) st.write('\r\n% Invalid input detected at \'^\' marker.\r\n');
            else if (cmd) st.write('\r\nGigabitEthernet1/0/1   10.0.0.1   YES manual up   up\r\nGigabitEthernet1/0/2   unassigned YES unset  down  down\r\n\r\nPID: C9300-48UXM       , VID: V02  , SN: FOC2213X0AB\r\n');
            st.write(`\r\n${name}#`);
          });
        });
      }));
      client.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const screenText = (page) => page.evaluate(() => [...document.querySelectorAll('.tabview:not([hidden]) .pane:not(.off) .xterm-rows')].map((r) => r.innerText).join('\n---\n'));
async function waitText(page, needle, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if ((await screenText(page)).includes(needle)) return; await page.waitForTimeout(100); }
  throw new Error(`Text nicht gefunden: ${needle}\n${await screenText(page)}`);
}
const visiblePanes = (page) => page.evaluate(() => document.querySelectorAll('.tabview:not([hidden]) .pane:not(.off)').length);

/** Kein Terminal ragt über seinen Bereich oder das Fenster hinaus. */
async function assertInside(page, what) {
  const bad = await page.evaluate(() => {
    const out = [];
    for (const pane of document.querySelectorAll('.tabview:not([hidden]) .pane:not(.off)')) {
      const p = pane.getBoundingClientRect();
      const scr = pane.querySelector('.xterm-screen').getBoundingClientRect();
      const snip = document.querySelector('#snippets:not([hidden])');
      const limit = snip ? snip.getBoundingClientRect().left : window.innerWidth;
      if (scr.right > p.right + 1 || p.right > limit + 1) out.push({ pane: p.right, screen: scr.right, limit });
    }
    if (document.body.scrollWidth > window.innerWidth + 1) out.push({ seite: document.body.scrollWidth, fenster: window.innerWidth });
    return out;
  });
  assert.deepEqual(bad, [], `${what}: Terminal oder Leiste ragt hinaus`);
}

function tftpGet(port, file) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const chunks = [];
    const t = setTimeout(() => { s.close(); reject(new Error('TFTP-Zeitüberschreitung')); }, 4000);
    s.on('message', (m, r) => {
      if (m.readUInt16BE(0) === 5) { clearTimeout(t); s.close(); reject(new Error('TFTP-Fehler ' + m.readUInt16BE(2))); return; }
      const n = m.readUInt16BE(2);
      chunks.push(m.subarray(4));
      const a = Buffer.alloc(4); a.writeUInt16BE(4, 0); a.writeUInt16BE(n, 2);
      s.send(a, r.port, r.address);
      if (m.length - 4 < 512) { clearTimeout(t); setTimeout(() => s.close(), 20); resolve(Buffer.concat(chunks)); }
    });
    s.bind(0, () => s.send(Buffer.concat([Buffer.from([0, 1]), Buffer.from(`${file}\0octet\0`)]), port, '127.0.0.1'));
  });
}

(async () => {
  const srv = await sshServer();
  const port = srv.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cable-data-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cable-logs-'));
  const tftpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cable-tftp-'));
  fs.writeFileSync(path.join(tftpDir, 'c9300.bin'), 'IMAGE'.repeat(300));
  fs.writeFileSync(path.join(dataDir, 'cable.json'), JSON.stringify({ settings: { fontSize: 13, theme: 'light', logDir, scrollback: 10000 } }));
  const app = await electron.launch({ args: ['--no-sandbox', '.'], cwd: path.join(__dirname, '../..'), env: { ...process.env, CABLE_DATA_DIR: dataDir, SSH_AUTH_SOCK: '', SHELL: '/bin/bash' } });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { console.error('Seitenfehler:', e.message); process.exitCode = 1; });
  await page.waitForSelector('#q-host');
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '01-start.png') });

  // 0) Staging: ohne staging.json ausgeblendet; mit Beispieldatei 3 Server, aufgeklappt 16 Konsolen-Knöpfe
  if (await page.isVisible('#staging-box')) throw new Error('Staging ohne staging.json sichtbar');
  fs.copyFileSync(path.join(__dirname, '../../docs/staging.example.json'), path.join(dataDir, 'staging.json'));
  await page.reload();
  await page.waitForSelector('#staging-list .perle');
  const perlen = await page.$$eval('#staging-list .perle .ip', (n) => n.map((x) => x.textContent));
  if (perlen.length !== 3 || perlen[0] !== '192.0.2.21' || perlen[2] !== '192.0.2.36') throw new Error('Staging-Server fehlen: ' + perlen);
  await page.click('#staging-list .perle .phd');
  const cports = await page.$$eval('#staging-list .perle .cport', (n) => n.length);
  if (cports !== 16) throw new Error(`Staging: ${cports} statt 16 Konsolen`);
  await page.screenshot({ path: path.join(shots, '01b-staging.png') });
  await page.click('#staging-list .perle .phd');
  const names = await page.$$eval('#staging-list .perle .name', (n) => n.map((x) => x.textContent));
  if (names[0] !== 'Konsolenserver 1' || names[2] !== 'USB-Konsolenserver') throw new Error('Staging-Namen: ' + names);
  if ((await page.textContent('#staging-ports')) !== 'Telnet · 10001–10016') throw new Error('Staging-Ports im Kopf falsch');
  await page.click('#staging-head');
  if (await page.isVisible('#staging-list')) throw new Error('Staging lässt sich nicht einklappen');
  await page.click('#staging-head');
  if (!(await page.isVisible('#staging-list'))) throw new Error('Staging lässt sich nicht aufklappen');

  // 1) Lokale Shell
  await page.click('#btn-local');
  await page.waitForSelector('.xterm-helper-textarea');
  await page.waitForTimeout(800);
  await page.keyboard.type('echo cable-$((40+2))\r');
  await waitText(page, 'cable-42');
  console.log('ok lokale Shell');

  // 2) SSH über getrennte Felder: IP, Port, Benutzer, Passwort – kein Passwort-Dialog
  await page.fill('#q-host', '127.0.0.1');
  await page.fill('#q-port', String(port));
  await page.fill('#q-user', 'admin');
  await page.fill('#q-pass', 'pw');
  await page.click('#q-go');
  await page.waitForSelector('.dialog >> text=Neuer Host');
  await page.click('.dialog button.primary');
  await waitText(page, 'SW1#');
  assert.equal(await page.inputValue('#q-pass'), '', 'Passwortfeld nach dem Verbinden geleert');
  console.log('ok SSH mit getrennten Feldern');

  // 3) Langer Befehl mit offener Bausteine-Leiste bleibt im Fenster (Fehler aus 0.1)
  await page.click('#btn-snippets');
  await page.waitForTimeout(400);
  await page.locator('.tabview:not([hidden]) .pane .xterm').first().click();
  await page.keyboard.type('show running-config | include ' + 'interface GigabitEthernet1/0/'.repeat(9));
  await page.waitForTimeout(400);
  await assertInside(page, 'Bausteine offen');
  await page.screenshot({ path: path.join(shots, '02-langer-befehl.png') });
  await page.keyboard.press('Control+U');
  await page.keyboard.press('Enter');
  console.log('ok langer Befehl bleibt im Fenster');

  // 4) Profil aus dem Formular (ohne Passwort speichern)
  await page.fill('#q-host', '127.0.0.1');
  await page.fill('#q-port', String(port));
  await page.fill('#q-user', 'admin');
  await page.click('#q-save');
  await page.waitForSelector('.dialog >> text=Neues Profil');
  await page.fill('.dialog input[placeholder="z. B. Core-Switch RZ1"]', 'Core-SW Test');
  await page.screenshot({ path: path.join(shots, '03-profil.png') });
  await page.click('.dialog button:has-text("Speichern & verbinden")');
  await page.waitForSelector('.dialog input[type=password]');
  await page.fill('.dialog input[type=password]', 'pw');
  await page.keyboard.press('Enter');
  await waitText(page, 'SW2#');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'cable.json'), 'utf8'));
  assert.equal(saved.sessions[0].name, 'Core-SW Test');
  assert.equal(saved.sessions[0].username, 'admin');
  console.log('ok Profil gespeichert');

  // 5) Drei weitere Bereiche im selben Tab → Raster 2×2, dann einen einzeln schließen
  for (let i = 0; i < 3; i++) {
    await page.click('#btn-split');
    await page.waitForSelector('.dialog input[type=password]');
    await page.fill('.dialog input[type=password]', 'pw');
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.tabview:not([hidden]) .pane .dot.st-ready').length === n, i + 2);
  }
  await page.click('#btn-snippets');
  await page.waitForTimeout(500);
  assert.equal(await visiblePanes(page), 4);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.tabview:not([hidden]) .grid')).gridTemplateColumns.split(' ').length);
  assert.equal(cols, 2, 'Raster mit zwei Spalten');
  await assertInside(page, 'Raster');
  await page.screenshot({ path: path.join(shots, '04-raster.png') });
  await page.click('.tabview:not([hidden]) .pane >> nth=3 >> button[aria-label="Bereich schließen"]');
  await page.click('.dialog button:has-text("Schließen")');
  await page.waitForFunction(() => document.querySelectorAll('.tabview:not([hidden]) .pane').length === 3);
  console.log('ok Raster + Bereich einzeln geschlossen');

  // 6) An mehrere: erst zwei ausgewählte, dann der ganze Tab
  await page.click('#open-list .oitem >> nth=1 >> input[type=checkbox]');
  await page.click('#open-list .oitem >> nth=2 >> input[type=checkbox]');
  await page.click('#btn-broadcast');
  await page.waitForSelector('#multibar:not([hidden])');
  assert.equal(await page.textContent('#n-selected'), '2');
  received.length = 0;
  await page.fill('#mb-input', 'show clock');
  await page.press('#mb-input', 'Enter');
  await page.waitForTimeout(600);
  let hits = new Set(received.filter((r) => r.data.includes('\r')).map((r) => r.n));
  assert.equal(hits.size, 2, `an zwei ausgewählte Sitzungen (erhalten: ${[...hits]})`);
  await page.screenshot({ path: path.join(shots, '05-an-mehrere.png') });
  await page.click('#scope-seg button[data-scope="tab"]');
  received.length = 0;
  await page.fill('#mb-input', 'bogus command');
  await page.press('#mb-input', 'Enter');
  await page.waitForTimeout(600);
  hits = new Set(received.filter((r) => r.data.includes('\r')).map((r) => r.n));
  assert.equal(hits.size, 3, `an alle drei im Tab (erhalten: ${[...hits]})`);
  console.log('ok An mehrere (Auswahl und Tab)');

  // 7) Fokus: eine Sitzung sichtbar, Statusliste meldet % Fehler, Auswahl über Liste
  await page.click('#view-seg button[data-view="focus"]');
  await page.waitForTimeout(400);
  assert.equal(await visiblePanes(page), 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.statuslist .sitem .st')].filter((s) => s.textContent === '% FEHLER').length === 3);
  await page.selectOption('.focusbar select', { index: 2 });
  await page.waitForTimeout(300);
  await assertInside(page, 'Fokus');
  await page.screenshot({ path: path.join(shots, '06-fokus.png') });
  console.log('ok Fokus mit Statusliste');

  // 8) Aufzeichnen und Verlauf speichern
  await page.click('.tabview:not([hidden]) .pane:not(.off) .phead button[aria-label="Aufzeichnen"]');
  await page.waitForSelector('.tabview:not([hidden]) .pane:not(.off) .phead button.rec');
  await page.click('#mb-off');
  await page.locator('.tabview:not([hidden]) .pane:not(.off) .xterm').click();
  await page.keyboard.type('show version\r');
  await page.waitForTimeout(500);
  await page.click('.tabview:not([hidden]) .pane:not(.off) .phead button.rec');
  await page.waitForTimeout(300);
  const logs = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
  assert.equal(logs.length, 1);
  assert.match(fs.readFileSync(path.join(logDir, logs[0]), 'utf8'), /\[\d\d:\d\d:\d\d\] .*GigabitEthernet1\/0\/1/);
  const exportFile = path.join(logDir, 'export.txt');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exportFile);
  await page.click('.tabview:not([hidden]) .pane:not(.off) .phead button[aria-label="Verlauf speichern"]');
  await page.waitForTimeout(400);
  const exported = fs.readFileSync(exportFile, 'utf8');
  assert.match(exported, /show version/);
  assert.match(exported, /% Invalid input/);
  console.log('ok Aufzeichnen + Verlauf speichern');

  // 9) Gruppe aus der Auswahl, öffnen mit gemeinsamem Passwort
  await page.click('#btn-sel-none');
  await page.click('#open-list .oitem:has-text("Core-SW Test") >> nth=0 >> input[type=checkbox]');
  await page.click('#btn-group-from-sel');
  await page.waitForSelector('.dialog >> text=Neue Gruppe');
  await page.fill('.dialog input[placeholder="z. B. Etage 2"]', 'Etage 2');
  await page.click('.dialog button:has-text("Speichern")');
  await page.waitForSelector('#group-list .gitem');
  await page.click('#group-list .gitem button[aria-label="Alle öffnen"]');
  await page.waitForSelector('.dialog >> text=Gruppe öffnen');
  await page.fill('.dialog input[type=password]', 'pw');
  await page.click('.dialog button:has-text("Öffnen")');
  await waitText(page, '#');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tab').length), 4);
  console.log('ok Gruppe');

  // 10) TFTP-Server: starten, Datei per TFTP laden, Ereignis im Dialog, stoppen
  await page.click('#mb-off').catch(() => {});
  await page.click('#btn-tftp');
  await page.waitForSelector('.dialog >> text=TFTP-Server');
  await page.fill('.dialog .row3 input:not([type=number])', tftpDir);
  await page.fill('.dialog input[type=number]', '16969');
  await page.click('.dialog button:has-text("Starten")');
  await page.waitForSelector('.dialog button:has-text("Stoppen")');
  const img = await tftpGet(16969, 'c9300.bin');
  assert.equal(img.length, 1500);
  await page.waitForSelector('.dialog .events .ok');
  await page.screenshot({ path: path.join(shots, '07-tftp.png') });
  await page.click('.dialog button:has-text("Stoppen")');
  await page.waitForSelector('.dialog button:has-text("Starten")');
  await page.click('.dialog footer button:has-text("Schließen")');
  console.log('ok TFTP-Server');

  // 11) Dunkel, Raster mit Bausteinen
  await page.click('.tab >> nth=2');
  await page.click('#view-seg button[data-view="grid"]');
  await page.click('#btn-settings');
  await page.waitForSelector('.dialog');
  await page.selectOption('.dialog select', 'dark');
  await page.click('.dialog button:has-text("Übernehmen")');
  await page.click('#btn-snippets');
  await page.waitForTimeout(500);
  await assertInside(page, 'Dunkel');
  await page.screenshot({ path: path.join(shots, '08-dunkel.png') });
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(500);
  await assertInside(page, 'Schmales Fenster');
  await page.screenshot({ path: path.join(shots, '09-schmal.png') });
  console.log('ok Dunkel');

  // 12) Hilfe-Menü mit Repo-Verknüpfung aus dist/build-info.json
  const help = await app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu().items.find((i) => i.label === 'Hilfe');
    return m ? m.submenu.items.filter((i) => i.type !== 'separator').map((i) => [i.label, i.enabled]) : null;
  });
  assert.deepEqual(help.map(([l]) => l), ['Über Cable …', 'Nach Updates suchen …', 'Repo auf GitHub öffnen', 'Quellordner öffnen']);
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, '../../dist/build-info.json'), 'utf8'));
  assert.equal(info.sourceDir, path.resolve(__dirname, '../..'));
  assert.match(info.commit, /^[0-9a-f]{40}$/);
  assert.equal(help[3][1], true, 'Quellordner öffnen muss aktiv sein');
  console.log('ok Hilfe-Menü mit Repo und Quellordner');

  // 13) Viele Einzel-Tabs: Port neben dem Namen, Pfeile zum Blättern, Raster bietet Zusammenführen an
  await page.setViewportSize({ width: 1400, height: 860 });
  const before = await page.$$eval('.tab', (x) => x.length);
  for (let i = 0; i < 6; i++) {
    await page.fill('#q-host', '127.0.0.1');
    await page.fill('#q-port', String(port));
    await page.fill('#q-user', 'admin');
    await page.fill('#q-pass', 'pw');
    await page.click('#q-go');
    await page.waitForFunction((n) => document.querySelectorAll('.tab').length === n, before + i + 1);
    await page.waitForFunction(() => document.querySelector('.tabview:not([hidden]) .pane .dot.st-ready'));
  }
  await page.waitForTimeout(400);
  const ports = await page.$$eval('#open-list .oitem .port', (x) => x.map((e) => e.textContent));
  assert.ok(ports.includes(`:${port}`), `Port in der Liste offener Sitzungen (${ports})`);
  assert.ok(await page.$eval('.tab.active .port', (e) => e.textContent) === `:${port}`, 'Port im Tab');
  assert.equal(await page.isVisible('#tabs-right'), true, 'Pfeile bei vielen Tabs');
  const sl0 = await page.$eval('#tabs', (e) => e.scrollLeft);
  await page.click('#tabs-left');
  await page.waitForTimeout(500);
  assert.ok(await page.$eval('#tabs', (e) => e.scrollLeft) < sl0, 'Pfeil links blättert');
  await page.locator('.tabview:not([hidden]) .pane .xterm').first().click();
  await page.keyboard.type('show inventory\r');
  await waitText(page, 'FOC2213X0AB');
  await page.screenshot({ path: path.join(shots, '10-viele-tabs.png') });
  await page.click('#view-seg button[data-view="grid"]');
  await page.waitForSelector('.dialog >> text=Tabs zusammenführen');
  await page.click('.dialog button:has-text("Zusammenführen")');
  await page.waitForTimeout(600);
  assert.equal(await page.$$eval('.tab', (x) => x.length), 1);
  assert.ok(await visiblePanes(page) >= 7, 'alle Sitzungen im Raster');
  await page.screenshot({ path: path.join(shots, '11-raster-zusammengefuehrt.png') });
  console.log('ok Ports, Tab-Pfeile, Raster führt Tabs zusammen');

  app.process().kill();
  srv.close();
  console.log('Screenshots:', shots);
})().catch((e) => { console.error(e); process.exit(1); });
