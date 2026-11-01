'use strict';
// Electron-Hauptprozess: Fenster, Verbindungen, Speicher, Rückfragen an die Oberfläche, cable://-Links,
// Aufzeichnung und Export, TFTP-Server.
// Die Oberfläche hat keinen Node-Zugriff (contextIsolation + sandbox); alles läuft über preload.js.

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { Store } = require('../core/store');
const { HostKeyStore } = require('../core/hostkeys');
const { open: openConnection, listSerialPorts, describeForward } = require('../core/connections');
const { compile, apply, splitTail } = require('../core/highlight');
const { parseSshConfig, parsePuttyReg, decodeReg } = require('../core/importers');
const { parseCableUrl, parseQuick } = require('../core/cableurl');
const { SessionLog, stamp, safeName } = require('../core/logger');
const { AutoLogin } = require('../core/autologin');
const { TftpServer, localAddresses } = require('../core/tftp');
const { parseStaging } = require('../core/staging');

let win = null;
let store = null;
let dataDir = '';
let hostKeys = null;
let compiled = compile([]);
const conns = new Map(); // tabId → {conn, decoder, log, session}
const asks = new Map(); // askId → resolve
let pendingUrls = [];
let askSeq = 0;
let tftp = null; // laufender TftpServer
let tftpEvents = [];

const crypt = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b),
};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Rückfrage an die Oberfläche (Host-Schlüssel, Passwort, keyboard-interactive). */
function ask(kind, info) {
  const id = ++askSeq;
  return new Promise((resolve) => {
    asks.set(id, resolve);
    send('ask:request', { id, kind, ...info });
    if (win) win.show();
  });
}

function askFor(tabId, session, trustNew) {
  return {
    // „Neue Host-Schlüssel vertrauen“ beim Öffnen einer Gruppe: nur für neue, nie für geänderte Schlüssel.
    hostKey: (info) => (trustNew && info.state === 'new' ? Promise.resolve(true) : ask('hostkey', { tabId, ...info })),
    secret: (prompt) => ask('secret', { tabId, prompt, canSave: session.protocol === 'ssh' && crypt.available() && Boolean(session.id) })
      .then((r) => {
        if (r && r.save && session.id) { session.savePassword = true; pendingSave.set(tabId, r.value); }
        return r ? r.value : null;
      }),
    keyboard: (name, prompts) => ask('keyboard', { tabId, name, prompts: prompts.map((p) => ({ prompt: String(p.prompt).slice(0, 200), echo: Boolean(p.echo) })) }),
  };
}
const pendingSave = new Map();

function logDir() {
  const s = store.data.settings;
  return s.logDir || path.join(os.homedir(), 'Documents', 'Cable Logs');
}

function resolveSession(input) {
  if (input && input.id && store.session(input.id) && !input.draft) return { ...store.session(input.id) };
  // Entwurf (Schnellverbindung, Link) – über dieselbe Prüfung wie gespeicherte Sitzungen.
  const { sanitizeSession } = require('../core/store');
  const s = sanitizeSession({ ...input, id: undefined });
  s.id = '';
  return s;
}

function openTab({ tabId, session: input, cols, rows, password: typed, trustNew }) {
  if (!/^[a-z0-9-]{1,40}$/.test(tabId) || conns.has(tabId)) throw new Error('Tab ungültig');
  const session = resolveSession(input);
  // Passwort aus dem Formular gilt nur für diese Verbindung; gespeichert wird es nur über das Profil.
  const once = typeof typed === 'string' && typed ? typed.slice(0, 500) : null;
  const ctx = {
    cols: Math.max(20, Math.min(cols | 0, 1000)), rows: Math.max(5, Math.min(rows | 0, 500)),
    hostKeys, ask: askFor(tabId, session, Boolean(trustNew)),
    password: once || (session.id ? store.getSecret(session.id) : null),
  };
  if (session.protocol === 'ssh' && session.jump) {
    const j = store.session(session.jump);
    if (!j || j.protocol !== 'ssh') throw new Error(`Jump-Host „${session.jump}“ nicht gefunden`);
    ctx.jumpSession = j;
    ctx.jumpPassword = store.getSecret(j.id);
  }
  const conn = openConnection(session, ctx);
  const entry = { conn, decoder: new StringDecoder('utf8'), log: null, session, hold: '', holdTimer: null };
  conns.set(tabId, entry);
  if (session.log) {
    try { entry.log = new SessionLog(logDir(), session.name); } catch (e) { send('conn:state', { tabId, state: 'notice', message: `Protokoll nicht möglich: ${e.message}` }); }
  }
  if (['telnet', 'serial'].includes(session.protocol) && (session.username || ctx.password)) {
    entry.login = new AutoLogin({ username: session.username, password: ctx.password }, (t) => conn.write(t));
  }
  const label = session.protocol === 'serial' ? `${session.path} @ ${session.baudRate}` : `${session.host || session.shell || 'Shell'}${session.port ? ':' + session.port : ''}`;
  send('conn:state', { tabId, state: 'connecting', message: `Verbinde ${label} …` });
  conn.on('ready', () => {
    const pw = pendingSave.get(tabId);
    if (pw && session.id) {
      store.setSecret(session.id, pw);
      const saved = store.session(session.id);
      if (saved && !saved.savePassword) { saved.savePassword = true; store.save(); }
    }
    pendingSave.delete(tabId);
    send('conn:state', { tabId, state: 'ready', message: `Verbunden: ${label}`, log: entry.log ? entry.log.file : null });
  });
  conn.on('notice', (message) => send('conn:state', { tabId, state: 'notice', message }));
  conn.on('data', (buf) => {
    if (entry.log) entry.log.write(buf);
    const text = entry.decoder.write(buf);
    if (entry.login) entry.login.feed(text);
    if (!text) return;
    if (!session.highlight) { send('conn:data', { tabId, data: text }); return; }
    // Angefangenes Wort kurz zurückhalten, damit IP/Modell/Seriennummer nicht über Pakete zerteilt werden.
    clearTimeout(entry.holdTimer);
    const [ready, tail] = splitTail(entry.hold + text);
    entry.hold = tail;
    if (ready) send('conn:data', { tabId, data: apply(ready, compiled) });
    if (tail) entry.holdTimer = setTimeout(() => { const t = entry.hold; entry.hold = ''; if (t) send('conn:data', { tabId, data: apply(t, compiled) }); }, 25);
  });
  conn.on('error', (e) => send('conn:state', { tabId, state: 'error', message: friendlyError(e) }));
  conn.on('close', () => {
    clearTimeout(entry.holdTimer);
    if (entry.hold) send('conn:data', { tabId, data: apply(entry.hold, compiled) });
    if (entry.log) entry.log.close();
    conns.delete(tabId);
    pendingSave.delete(tabId);
    send('conn:state', { tabId, state: 'closed', message: 'Verbindung beendet' });
  });
  return { label, session, log: entry.log ? entry.log.file : null };
}

/** Aufzeichnung einer laufenden Sitzung starten/stoppen (unabhängig vom Profil-Häkchen). */
function setLogging(tabId, on) {
  const c = conns.get(tabId);
  if (!c) throw new Error('Sitzung nicht verbunden');
  if (on && !c.log) c.log = new SessionLog(logDir(), c.session.name || c.session.host || 'sitzung');
  if (!on && c.log) { c.log.close(); c.log = null; }
  return c.log ? c.log.file : null;
}

/** Verlauf aus dem Terminal als Textdatei sichern (Speichern-Dialog). */
async function exportText({ name, text }) {
  if (typeof text !== 'string' || text.length > 50_000_000) throw new Error('Text ungültig');
  fs.mkdirSync(logDir(), { recursive: true });
  const r = await dialog.showSaveDialog(win, {
    title: 'Verlauf speichern', defaultPath: path.join(logDir(), `${safeName(name || 'sitzung')}-${stamp()}.txt`),
    filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, { mode: 0o600 });
  return r.filePath;
}

function tftpStatus() {
  return {
    running: Boolean(tftp), root: tftp ? tftp.root : store.data.tftp.root, port: tftp ? tftp.port : store.data.tftp.port,
    allowWrite: tftp ? tftp.allowWrite : store.data.tftp.allowWrite, addresses: localAddresses(), events: tftpEvents.slice(-80),
  };
}

async function tftpStart(v) {
  if (tftp) throw new Error('TFTP-Server läuft schon');
  const cfg = store.setTftp(v);
  if (!cfg.root) throw new Error('Erst einen Ordner wählen');
  if (!fs.existsSync(cfg.root)) throw new Error(`Ordner existiert nicht: ${cfg.root}`);
  const srv = new TftpServer({ root: cfg.root, port: cfg.port, allowWrite: cfg.allowWrite });
  srv.on('event', (e) => { tftpEvents.push(e); tftpEvents = tftpEvents.slice(-200); send('tftp:event', e); });
  tftpEvents = [];
  await srv.start();
  tftp = srv;
  return tftpStatus();
}

function tftpStop() {
  if (tftp) { tftp.stop(); tftp = null; }
  return tftpStatus();
}

function friendlyError(e) {
  const m = String((e && e.message) || e);
  if (/ECONNREFUSED/.test(m)) return 'Verbindung abgelehnt (Port geschlossen?)';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Host nicht gefunden (DNS)';
  if (/ETIMEDOUT|Timed out|Zeitüberschreitung/.test(m)) return 'Zeitüberschreitung – Host nicht erreichbar';
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return 'Netz nicht erreichbar';
  if (/All configured authentication methods failed/.test(m)) return 'Anmeldung fehlgeschlagen (Benutzer, Passwort oder Schlüssel prüfen)';
  if (/Host denied|host verification/i.test(m)) return 'Host-Schlüssel nicht bestätigt – Verbindung abgebrochen';
  if (/no matching|handshake failed/i.test(m)) return `${m} – bei alten Geräten „Alte Algorithmen erlauben“ einschalten`;
  if (/EACCES|Permission denied/.test(m)) return `${m} – Zugriff auf den Anschluss verweigert`;
  if (/EBUSY|Resource busy|Cannot lock/.test(m)) return 'Serieller Anschluss ist belegt (anderes Programm offen?)';
  return m.slice(0, 300);
}

let uiReady = false;

function handleUrl(url) {
  if (!win || !uiReady) { pendingUrls.push(url); return; }
  const draft = parseCableUrl(url);
  if (!draft) return;
  if (draft.open) {
    const s = store.session(draft.open);
    if (s) send('open:session', { id: s.id });
    return;
  }
  // Links öffnen nie still: die Oberfläche fragt nach.
  send('open:draft', { ...draft, fromLink: true });
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
    try { return { ok: true, value: await fn(arg || {}) }; } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
  });
  h('store:get', () => ({ ...store.all(), staging: readStaging() }));
  h('staging:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Staging-Konsolen (staging.json) wählen', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const cfg = parseStaging(fs.readFileSync(r.filePaths[0], 'utf8'));
    fs.writeFileSync(stagingFile(), JSON.stringify(cfg, null, 2));
    return cfg;
  });
  h('staging:remove', () => { fs.rmSync(stagingFile(), { force: true }); });
  h('session:save', (s) => store.upsertSession(s));
  h('session:has-password', ({ id }) => store.hasSecret(id));
  h('group:save', (g) => store.saveGroup(g));
  h('group:delete', ({ id }) => store.deleteGroup(id));
  h('log:set', ({ tabId, on }) => setLogging(tabId, Boolean(on)));
  h('log:reveal', ({ file }) => { if (typeof file === 'string' && file.startsWith(logDir())) shell.showItemInFolder(file); });
  h('export:text', (arg) => exportText(arg));
  h('tftp:status', () => tftpStatus());
  h('tftp:start', (v) => tftpStart(v));
  h('tftp:stop', () => tftpStop());
  h('tftp:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Ordner für TFTP freigeben', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('tftp:reveal', () => { if (store.data.tftp.root) shell.openPath(store.data.tftp.root); });
  h('session:delete', ({ id }) => store.deleteSession(id));
  h('session:forget-password', ({ id }) => { store.setSecret(id, null); const s = store.session(id); if (s) { s.savePassword = false; store.save(); } });
  h('snippets:save', (list) => store.setSnippets(list.items));
  h('rules:save', (list) => { const r = store.setRules(list.items); compiled = compile(r); return { rules: r, errors: compiled.errors }; });
  h('settings:save', (v) => store.setSettings(v));
  h('serial:list', () => listSerialPorts());
  h('quick:parse', ({ text }) => parseQuick(text));
  h('import:sshconfig', () => {
    const file = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(file)) throw new Error('~/.ssh/config nicht vorhanden');
    return store.importSessions(parseSshConfig(fs.readFileSync(file, 'utf8')));
  });
  h('import:putty', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'PuTTY-Export (.reg) wählen', filters: [{ name: 'Registry-Export', extensions: ['reg'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return 0;
    return store.importSessions(parsePuttyReg(decodeReg(fs.readFileSync(r.filePaths[0]))));
  });
  h('key:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Privaten Schlüssel wählen', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('hostkeys:list', () => hostKeys.keys);
  h('hostkeys:forget', ({ host, port }) => hostKeys.forget(host, port));
  h('logs:open', () => { fs.mkdirSync(logDir(), { recursive: true }); return shell.openPath(logDir()); });
  h('conn:open', (arg) => openTab(arg));
  h('conn:close', ({ tabId }) => { const c = conns.get(tabId); if (c) c.conn.close(); });
  h('conn:break', ({ tabId }) => { const c = conns.get(tabId); if (c && c.conn.sendBreak) c.conn.sendBreak(); else throw new Error('Break nur bei Serial/Telnet'); });
  h('conn:forward', ({ tabId, forward }) => {
    const c = conns.get(tabId);
    if (!c || !c.conn.addForward) throw new Error('Nur bei SSH');
    const { sanitizeForward } = require('../core/store');
    const f = sanitizeForward(forward);
    if (!f) throw new Error('Weiterleitung ungültig');
    return c.conn.addForward(f).then(() => describeForward(f));
  });
  ipcMain.on('conn:write', (_e, { tabId, data }) => { const c = conns.get(tabId); if (c && typeof data === 'string' && data.length <= 1_000_000) c.conn.write(data); });
  ipcMain.on('conn:resize', (_e, { tabId, cols, rows }) => { const c = conns.get(tabId); if (c) c.conn.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); });
  ipcMain.on('ask:reply', (_e, { id, value }) => { const r = asks.get(id); if (r) { asks.delete(id); r(value); } });
  ipcMain.on('ui:ready', () => {
    uiReady = true;
    const urls = pendingUrls;
    pendingUrls = [];
    for (const u of urls) handleUrl(u);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 840, minWidth: 760, minHeight: 500, title: 'Cable',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#10131a' : '#e9edf3',
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('close', (e) => {
    if (conns.size && !app.isQuitting) {
      const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Beenden', 'Abbrechen'], defaultId: 1, message: `${conns.size} Verbindung(en) offen. Cable trotzdem beenden?` });
      if (r !== 0) { e.preventDefault(); return; }
    }
    for (const c of conns.values()) c.conn.close();
    tftpStop();
  });
  win.on('closed', () => { win = null; uiReady = false; });
}

// Staging-Konsolenserver: optional, nur aus staging.json im Datenordner (nie im Code oder Repo).
function stagingFile() { return path.join(dataDir, 'staging.json'); }

function readStaging() {
  if (!fs.existsSync(stagingFile())) return null;
  try { return parseStaging(fs.readFileSync(stagingFile(), 'utf8')); } catch (e) { console.warn('staging.json:', e.message); return null; }
}

// Verknüpfung App ↔ Repo: dist/build-info.json (scripts/build-info.js) sagt, aus welchem Commit und
// welchem lokalen Ordner gebaut wurde. Darüber prüft „Nach Updates suchen“ GitHub und baut neu.
const REPO_URL = 'https://github.com/RateMySetup/cable-app';
let buildInfo = null;
let updating = false;

function readBuildInfo() {
  try { buildInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '../../dist/build-info.json'), 'utf8')); } catch { buildInfo = {}; }
  buildInfo.version = app.getVersion();
  buildInfo.repo = buildInfo.repo || REPO_URL;
  app.setAboutPanelOptions({ applicationVersion: buildInfo.version, version: buildInfo.commit ? buildInfo.commit.slice(0, 7) + (buildInfo.dirty ? '+' : '') : '', website: buildInfo.repo });
  return buildInfo;
}

function sourceDir() {
  const d = buildInfo && buildInfo.sourceDir;
  return d && fs.existsSync(path.join(d, '.git')) ? d : '';
}

function git(dir, args, timeout = 30000) {
  const { execFile } = require('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out, errOut) => {
      if (err) reject(new Error((errOut || err.message).trim().split('\n').pop()));
      else resolve(out.trim());
    });
  });
}

function showAbout() {
  const b = buildInfo;
  const commit = b.commit ? `${b.commit.slice(0, 7)}${b.dirty ? ' + lokale Änderungen' : ''}` : 'unbekannt';
  const built = b.builtAt ? new Date(b.builtAt).toLocaleString('de-DE') : 'unbekannt';
  const r = dialog.showMessageBoxSync(win, {
    type: 'info', title: 'Über Cable', message: `Cable ${b.version}`,
    detail: `Commit: ${commit}\nGebaut: ${built}\nQuellordner: ${sourceDir() || '–'}\nRepo: ${b.repo}`,
    buttons: ['OK', 'Repo auf GitHub', ...(sourceDir() ? ['Quellordner'] : [])], defaultId: 0,
  });
  if (r === 1) shell.openExternal(b.repo);
  if (r === 2) shell.openPath(sourceDir());
}

/** Vergleicht den Build-Commit mit origin/main und dem lokalen Stand im Quellordner. */
async function checkUpdates() {
  const dir = sourceDir();
  if (!dir) {
    const r = dialog.showMessageBoxSync(win, { type: 'info', message: 'Kein lokaler Quellordner bekannt', detail: `Diese App wurde nicht aus einem Git-Klon gebaut. Neue Versionen gibt es hier:\n${REPO_URL}/releases`, buttons: ['OK', 'Repo öffnen'] });
    if (r === 1) shell.openExternal(`${REPO_URL}/releases`);
    return;
  }
  let behind = 0, ahead = 0, dirty = false, fetchErr = '';
  try { await git(dir, ['fetch', '--quiet', 'origin']); } catch (e) { fetchErr = e.message; }
  try {
    const base = buildInfo.commit || 'HEAD';
    behind = Number(await git(dir, ['rev-list', '--count', `${base}..origin/main`])) || 0;
    ahead = Number(await git(dir, ['rev-list', '--count', `${base}..HEAD`])) || 0;
    dirty = (await git(dir, ['status', '--porcelain', '--untracked-files=no'])) !== '';
  } catch (e) { fetchErr = fetchErr || e.message; }
  const lines = [];
  if (fetchErr) lines.push(`GitHub nicht erreichbar: ${fetchErr}`);
  if (behind) lines.push(`${behind} neue(r) Commit(s) auf GitHub.`);
  if (ahead) lines.push(`${ahead} lokale(r) Commit(s) im Quellordner, die noch nicht in dieser App sind.`);
  if (dirty) lines.push('Im Quellordner gibt es nicht committete Änderungen (werden mitgebaut).');
  if (!behind && !ahead) {
    dialog.showMessageBoxSync(win, { type: 'info', message: fetchErr ? 'Update-Prüfung unvollständig' : `Cable ${buildInfo.version} ist aktuell`, detail: [...lines, `Quellordner: ${dir}`].join('\n') });
    return;
  }
  if (process.platform !== 'darwin') {
    dialog.showMessageBoxSync(win, { type: 'info', message: 'Neuere Version verfügbar', detail: [...lines, `Im Quellordner: git pull && npm run setup && npm run dist:linux`].join('\n') });
    return;
  }
  const r = dialog.showMessageBoxSync(win, {
    type: 'question', message: 'Neuere Version verfügbar', buttons: ['Jetzt bauen', 'Später'], defaultId: 0, cancelId: 1,
    detail: [...lines, '', `„Jetzt bauen“ holt die Änderungen (git pull --ff-only), baut im Hintergrund und fragt danach, ob Cable neu starten soll. Offene Sitzungen bleiben bis dahin offen.`].join('\n'),
  });
  if (r === 0) runUpdate(dir, behind > 0);
}

function runUpdate(dir, pull) {
  if (updating) return;
  updating = true;
  const { spawn } = require('node:child_process');
  const logFile = path.join(app.getPath('logs'), 'update.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'w');
  const child = spawn('bash', [path.join(dir, 'scripts/install-local.sh'), '--build-only', ...(pull ? ['--pull'] : [])], { cwd: dir, stdio: ['ignore', out, out] });
  send('menu', 'update-building');
  child.on('exit', (code) => {
    fs.closeSync(out);
    updating = false;
    if (code !== 0) {
      const r = dialog.showMessageBoxSync(win, { type: 'error', message: 'Bauen fehlgeschlagen', detail: `Die laufende App bleibt unverändert. Protokoll: ${logFile}`, buttons: ['OK', 'Protokoll öffnen'] });
      if (r === 1) shell.openPath(logFile);
      return;
    }
    const open = conns.size ? `\n${conns.size} offene Verbindung(en) werden dabei getrennt.` : '';
    const r = dialog.showMessageBoxSync(win, { type: 'question', message: 'Neue Version ist gebaut', detail: `Cable jetzt beenden, nach /Applications installieren und neu starten?${open}`, buttons: ['Neu starten', 'Später'], defaultId: 0, cancelId: 1 });
    if (r !== 0) return;
    const inst = spawn('bash', [path.join(dir, 'scripts/install-local.sh'), '--no-build', '--wait-pid', String(process.pid), '--relaunch'], {
      cwd: dir, detached: true, stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    });
    inst.unref();
    app.isQuitting = true;
    app.quit();
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const cmd = (name) => () => send('menu', name);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Ablage', submenu: [
      { label: 'Neue Sitzung …', accelerator: 'CmdOrCtrl+N', click: cmd('new-session') },
      { label: 'Schnellverbindung', accelerator: 'CmdOrCtrl+K', click: cmd('quick') },
      { label: 'Lokale Shell', accelerator: 'CmdOrCtrl+T', click: cmd('local') },
      { type: 'separator' },
      { label: 'Tab schließen', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
      { label: 'Erneut verbinden', accelerator: 'CmdOrCtrl+R', click: cmd('reconnect') },
      { type: 'separator' },
      { label: 'Aus ~/.ssh/config importieren', click: cmd('import-ssh') },
      { label: 'PuTTY-Sitzungen importieren (.reg) …', click: cmd('import-putty') },
      { label: 'Staging-Konsolen importieren (.json) …', click: cmd('import-staging') },
      { label: 'Staging-Konsolen entfernen', click: cmd('remove-staging') },
      { label: 'Protokoll-Ordner öffnen', click: cmd('open-logs') },
    ] },
    { role: 'editMenu', label: 'Bearbeiten' },
    { label: 'Sitzung', submenu: [
      { label: 'Weitere Sitzung im Tab', accelerator: 'CmdOrCtrl+D', click: cmd('split') },
      { label: 'Bereich schließen', accelerator: 'CmdOrCtrl+Shift+W', click: cmd('close-pane') },
      { label: 'An mehrere senden ein/aus', accelerator: 'CmdOrCtrl+Shift+B', click: cmd('broadcast') },
      { label: 'Aufzeichnen ein/aus', accelerator: 'CmdOrCtrl+Shift+R', click: cmd('record') },
      { label: 'Verlauf speichern …', accelerator: 'CmdOrCtrl+S', click: cmd('export') },
      { label: 'Suchen', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
      { label: 'Break senden', accelerator: 'CmdOrCtrl+Shift+K', click: cmd('break') },
      { label: 'Bildschirm leeren', accelerator: 'CmdOrCtrl+L', click: cmd('clear') },
      { type: 'separator' },
      { label: 'Nächster Tab', accelerator: 'CmdOrCtrl+Shift+]', click: cmd('next-tab') },
      { label: 'Vorheriger Tab', accelerator: 'CmdOrCtrl+Shift+[', click: cmd('prev-tab') },
    ] },
    { label: 'Darstellung', submenu: [
      { label: 'Größer', accelerator: 'CmdOrCtrl+Plus', click: cmd('font-up') },
      { label: 'Kleiner', accelerator: 'CmdOrCtrl+-', click: cmd('font-down') },
      { label: 'Seitenleiste ein/aus', accelerator: 'CmdOrCtrl+B', click: cmd('sidebar') },
      { label: 'Raster', accelerator: 'CmdOrCtrl+1', click: cmd('view-grid') },
      { label: 'Nebeneinander', accelerator: 'CmdOrCtrl+2', click: cmd('view-cols') },
      { label: 'Untereinander', accelerator: 'CmdOrCtrl+3', click: cmd('view-rows') },
      { label: 'Fokus', accelerator: 'CmdOrCtrl+4', click: cmd('view-focus') },
      { label: 'Alle Tabs zusammenführen', click: cmd('merge-tabs') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Vollbild' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
    ] },
    { label: 'Werkzeuge', submenu: [
      { label: 'TFTP-Server …', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('tftp') },
      { label: 'Befehlsbausteine ein/aus', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('snippets') },
    ] },
    { role: 'windowMenu', label: 'Fenster' },
    { role: 'help', label: 'Hilfe', submenu: [
      { label: 'Über Cable …', click: showAbout },
      { label: 'Nach Updates suchen …', click: () => checkUpdates().catch((e) => dialog.showErrorBox('Update-Prüfung', e.message)) },
      { type: 'separator' },
      { label: 'Repo auf GitHub öffnen', click: () => shell.openExternal(REPO_URL) },
      { label: 'Quellordner öffnen', enabled: !!sourceDir(), click: () => shell.openPath(sourceDir()) },
    ] },
  ]));
}

/**
 * Bis 0.1 hieß die App „Kabel“ (Daten in …/Application Support/Kabel). Beim ersten Start als Cable
 * werden Profile und Host-Schlüssel übernommen. Gemerkte Passwörter hängen am Schlüsselbund-Eintrag
 * „Kabel Safe Storage“ und lassen sich nicht übertragen – sie werden beim nächsten Verbinden neu abgefragt.
 */
function migrateFromKabel(dir) {
  const old = path.join(path.dirname(dir), 'Kabel');
  if (old === dir || fs.existsSync(path.join(dir, 'cable.json')) || !fs.existsSync(path.join(old, 'kabel.json'))) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['kabel.json', 'hostkeys.json']) {
    try { if (fs.existsSync(path.join(old, f))) fs.copyFileSync(path.join(old, f), path.join(dir, f), fs.constants.COPYFILE_EXCL); } catch { /* schon da */ }
  }
}

// Eigener Datenordner (Tests, zweite Kopie) bekommt auch eine eigene Instanz-Sperre,
// sonst beendet sich die Kopie sofort, solange das installierte Cable läuft.
const customDir = process.env.CABLE_DATA_DIR || process.env.KABEL_DATA_DIR;
if (customDir) app.setPath('userData', path.resolve(customDir));

// Ein Fenster, Links an die laufende Instanz.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => /^(cable|kabel):\/\//.test(a));
    if (url) handleUrl(url);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('open-url', (e, url) => { e.preventDefault(); handleUrl(url); });
  if (!process.defaultApp) { app.setAsDefaultProtocolClient('cable'); app.setAsDefaultProtocolClient('kabel'); }
  app.whenReady().then(() => {
    const dir = process.env.CABLE_DATA_DIR || process.env.KABEL_DATA_DIR || app.getPath('userData');
    dataDir = dir;
    migrateFromKabel(dir);
    store = new Store(dir, crypt);
    hostKeys = new HostKeyStore(path.join(dir, 'hostkeys.json'));
    compiled = compile(store.data.rules);
    registerIpc();
    readBuildInfo();
    buildMenu();
    createWindow();
    const url = process.argv.find((a) => /^(cable|kabel):\/\//.test(a));
    if (url) pendingUrls.push(url);
    app.on('activate', () => { if (!win) createWindow(); });
  });
  app.on('before-quit', () => { app.isQuitting = true; });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
