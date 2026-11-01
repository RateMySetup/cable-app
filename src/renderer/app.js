// Oberfläche von Cable: Verbinden-Formular, offene Sitzungen mit Auswahl, Gruppen, Profile, Tabs mit
// Bereichen in vier Anordnungen (Raster, Spalten, Zeilen, Fokus), „An mehrere“, Bausteine, Aufzeichnen,
// TFTP-Server. Kein Framework – kleiner DOM-Code, Zustand in `state`.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { stagingPorts, stagingSession } from '../core/staging.js';

const api = window.cable;
const $ = (s, root = document) => root.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value') n[k] = v;
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};

const MAX_PANES = 64;
const state = {
  data: { sessions: [], groups: [], snippets: [], rules: [], settings: { fontSize: 13, theme: 'auto' }, tftp: {} },
  tabs: [], // {id, title, panes: [pane], view, grid, focusbar, statuslist, layout, focus}
  active: null,
  multi: { on: false, scope: 'selected', rec: false },
  selected: null,
  tftp: { running: false, addresses: [], events: [] },
  closedFolders: new Set(JSON.parse(localStorageGet('closedFolders') || '[]')),
  closedSnippetGroups: new Set(JSON.parse(localStorageGet('closedSnippetGroups') || '[]')),
  openPerlen: new Set(JSON.parse(localStorageGet('openPerlen') || '[]')),
  stagingClosed: localStorageGet('stagingClosed') === '1',
};
let seq = 0;
const panes = new Map(); // paneId → pane

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- Themen ----------
// Hintergrund durchsichtig: die Farbe kommt vom Glas-Bereich dahinter.
const THEMES = {
  dark: { background: '#00000000', foreground: '#e3e7ee', cursor: '#6b9dff', selectionBackground: '#2e4a7d',
    black: '#1c212b', red: '#ff6f68', green: '#4fcf85', yellow: '#e6b062', blue: '#6b9dff', magenta: '#c08cff', cyan: '#4fd1c9', white: '#d4d8df',
    brightBlack: '#5f6878', brightRed: '#ff8d87', brightGreen: '#74dd9f', brightYellow: '#f0c785', brightBlue: '#93b6ff', brightMagenta: '#d4adff', brightCyan: '#7fe3dd', brightWhite: '#ffffff' },
  light: { background: '#00000000', foreground: '#1a2130', cursor: '#2459c4', selectionBackground: '#c6d7f7',
    black: '#1a2130', red: '#c4302b', green: '#1b7f49', yellow: '#8a5a0e', blue: '#2459c4', magenta: '#7d3cc4', cyan: '#0f6f6c', white: '#5d6574',
    brightBlack: '#465063', brightRed: '#d84a44', brightGreen: '#25965a', brightYellow: '#a46c14', brightBlue: '#3a6fd8', brightMagenta: '#9450d8', brightCyan: '#13827f', brightWhite: '#8b93a1' },
};
function isDark() {
  const t = state.data.settings.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme() {
  const t = state.data.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  for (const p of panes.values()) {
    p.term.options.theme = isDark() ? THEMES.dark : THEMES.light;
    p.term.options.fontSize = state.data.settings.fontSize;
    fit(p);
  }
  // Nach Schriftwechsel misst xterm die Zeichenbreite neu – danach noch einmal anpassen, sonst bleibt die
  // alte Spaltenzahl und lange Zeilen laufen über den Rand.
  requestAnimationFrame(() => { for (const p of panes.values()) if (!p.root.classList.contains('off')) fit(p); });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- Profile ----------
const PROTO_LABEL = { ssh: 'SSH', telnet: 'TEL', serial: 'SER', raw: 'RAW', local: 'SH' };
const DEFAULT_PORT = { ssh: 22, telnet: 23, raw: 23 };
function subline(s) {
  if (s.protocol === 'serial') return `${s.path} · ${s.baudRate}`;
  if (s.protocol === 'local') return s.shell || 'Standard-Shell';
  return `${s.username ? s.username + '@' : ''}${s.host}${s.port && s.port !== DEFAULT_PORT[s.protocol] ? ':' + s.port : ''}`;
}

/** Port bzw. Baudrate als feiner Zusatz neben dem Namen (z. B. „:10007“), wenn nicht schon im Namen. */
function portHint(s, title) {
  if (!s) return '';
  const hint = s.protocol === 'serial' ? (s.baudRate ? `@${s.baudRate}` : '') : s.port ? `:${s.port}` : '';
  return hint && !String(title).includes(hint) ? hint : '';
}

function renderTree() {
  const q = $('#search').value.trim().toLowerCase();
  const tree = $('#tree');
  tree.replaceChildren();
  const list = state.data.sessions.filter((s) => !q || [s.name, s.host, s.path, s.folder, s.note, s.username].some((v) => v && v.toLowerCase().includes(q)));
  if (!list.length) {
    tree.append(el('p', { class: 'muted small' }, state.data.sessions.length ? 'Keine Treffer.' : 'Noch keine Profile. Links verbinden und „Als Profil …“, oder Ablage → Import.'));
    return;
  }
  const groups = new Map();
  for (const s of list) {
    const f = s.folder || 'Profile';
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(s);
  }
  for (const [folder, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
    const closed = !q && state.closedFolders.has(folder);
    tree.append(el('div', { class: 'folder' + (closed ? ' closed' : '') },
      el('div', { class: 'fhead', onclick: () => {
        if (state.closedFolders.has(folder)) state.closedFolders.delete(folder); else state.closedFolders.add(folder);
        localStorageSet('closedFolders', JSON.stringify([...state.closedFolders]));
        renderTree();
      } }, closed ? '▸' : '▾', ` ${folder} (${items.length})`),
      el('div', { class: 'items' }, items.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true })).map((s) => el('div', {
        class: 'item' + (state.selected === s.id ? ' sel' : ''), title: s.note || subline(s), tabindex: '0',
        onclick: () => { state.selected = s.id; renderTree(); },
        ondblclick: () => connect(s),
        onkeydown: (e) => { if (e.key === 'Enter') connect(s); },
      },
      el('span', { class: 'badge ' + s.protocol }, PROTO_LABEL[s.protocol]),
      el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'name' }, s.color ? el('span', { class: 'dot', style: `background:${s.color};margin-right:6px` }) : null, s.name), el('div', { class: 'sub' }, subline(s))),
      el('span', { class: 'acts' },
        el('button', { class: 'icon', title: 'Bearbeiten', 'aria-label': 'Bearbeiten', onclick: (e) => { e.stopPropagation(); editSession(s); } }, '✎'),
        el('button', { class: 'icon', title: 'Verbinden', 'aria-label': 'Verbinden', onclick: (e) => { e.stopPropagation(); connect(s); } }, '▶')))))));
  }
}

async function refreshSerial() {
  const box = $('#serial-list');
  try {
    const ports = await api.serialPorts();
    box.replaceChildren();
    if (!ports.length) { box.textContent = 'Kein Kabel erkannt. USB-Konsolenkabel einstecken und „Neu suchen“.'; return; }
    for (const p of ports) {
      const baud = el('select', { title: 'Baudrate', 'aria-label': 'Baudrate' }, [9600, 19200, 38400, 57600, 115200].map((b) => el('option', { value: b }, b)));
      box.append(el('div', { class: 'serial-port', title: [p.manufacturer, p.serialNumber].filter(Boolean).join(' · ') },
        el('span', { class: 'name' }, p.path.replace('/dev/', '')), baud,
        el('button', { onclick: () => connect({ protocol: 'serial', name: p.path.replace('/dev/', ''), path: p.path, baudRate: Number(baud.value), dataBits: 8, stopBits: 1, parity: 'none', draft: true }) }, 'Öffnen')));
    }
  } catch (e) { box.textContent = `Serielle Anschlüsse nicht lesbar: ${e.message}`; }
}

// ---------- Staging ----------
/** Offener Bereich zu Perle und Port, falls schon verbunden (oder am Verbinden). */
function stagingPane(perle, port) {
  return [...panes.values()].find((p) => p.session.host === perle.host && p.session.port === port && p.session.protocol === 'telnet') || null;
}

/** Konsolenserver aus staging.json mit je einem Knopf pro Konsole; Klick verbindet, offene Konsolen springen zum Bereich. */
function renderStaging() {
  const cfg = state.data.staging;
  $('#staging-box').hidden = !cfg;
  if (!cfg) return;
  const ports = stagingPorts(cfg);
  $('#staging-title').textContent = cfg.title;
  $('#staging-ports').textContent = `Telnet · ${ports[0]}–${ports[ports.length - 1]}`;
  const box = $('#staging-list');
  const closed = state.stagingClosed;
  $('#staging-chev').textContent = closed ? '▸' : '▾';
  $('#staging-head').setAttribute('aria-expanded', String(!closed));
  box.hidden = closed;
  if (closed) return;
  box.replaceChildren(...cfg.servers.map((perle) => {
    const open = state.openPerlen.has(perle.id);
    const live = ports.filter((port) => stagingPane(perle, port)).length;
    return el('div', { class: 'perle' + (open ? '' : ' closed') },
      el('div', { class: 'phd', onclick: () => {
        if (state.openPerlen.has(perle.id)) state.openPerlen.delete(perle.id); else state.openPerlen.add(perle.id);
        localStorageSet('openPerlen', JSON.stringify([...state.openPerlen]));
        renderStaging();
      } },
      el('span', { class: 'chev' }, open ? '▾' : '▸'),
      el('span', { class: 'name' }, perle.name),
      el('span', { class: 'ip' }, perle.host),
      live ? el('span', { class: 'live', title: `${live} Konsole(n) offen` }, live) : null,
      el('button', { class: 'icon', title: `Alle ${ports.length} Konsolen in einem Tab öffnen`, 'aria-label': `${perle.name}: alle öffnen`, onclick: (e) => { e.stopPropagation(); openPerle(perle); } }, '▶')),
      open ? el('div', { class: 'ports' }, ports.map((port, i) => {
        const p = stagingPane(perle, port);
        return el('button', {
          class: 'cport' + (p ? ' on st-' + p.state : ''),
          title: `${perle.host}:${port}${p ? ' – offen, Klick springt hin, ⌥-Klick öffnet neu' : ''}`,
          onclick: (e) => { if (p && !e.altKey) revealPane(p); else connect(stagingSession(cfg, perle, i + 1)); },
        }, String(i + 1));
      })) : null);
  }));
}

/** Ganzen Staging-Bereich ein- oder ausklappen (bleibt über Neustarts erhalten). */
function toggleStaging() {
  state.stagingClosed = !state.stagingClosed;
  localStorageSet('stagingClosed', state.stagingClosed ? '1' : '0');
  renderStaging();
}

/** Alle Konsolen eines Servers in einen neuen Tab (Fokus-Ansicht); bereits offene werden übersprungen. */
async function openPerle(perle) {
  const cfg = state.data.staging;
  const todo = stagingPorts(cfg).map((port, i) => [port, i + 1]).filter(([port]) => !stagingPane(perle, port));
  if (!todo.length) { toast(`Alle Konsolen von ${perle.name} sind schon offen`); return; }
  if (!(await confirmDialog(`${perle.name} öffnen?`, `${todo.length} Telnet-Konsole(n) auf ${perle.host} (Port ${todo[0][0]}–${todo[todo.length - 1][0]}) in einem neuen Tab öffnen?`, 'Öffnen'))) return;
  const tab = newTab(perle.name);
  tab.layout = 'focus';
  for (const [, nr] of todo) start(newPane(tab, stagingSession(cfg, perle, nr)));
  activate(tab.id);
  refreshAll();
}

// ---------- Gruppen ----------
function renderGroups() {
  const box = $('#group-list');
  if (!state.data.groups.length) { box.textContent = 'Gruppen fassen bis zu 50 Profile zusammen, z. B. alle Switches einer Etage.'; return; }
  box.replaceChildren(el('div', { class: 'olist' }, state.data.groups.map((g) => el('div', { class: 'gitem' },
    el('span', { class: 'name', title: g.sessionIds.map((id) => (state.data.sessions.find((s) => s.id === id) || {}).name).filter(Boolean).join(', ') }, g.name),
    el('span', { class: 'count' }, g.sessionIds.length),
    el('button', { class: 'icon', title: 'Offene Sitzungen dieser Gruppe auswählen', 'aria-label': 'Auswählen', onclick: () => selectGroup(g) }, '☑'),
    el('button', { class: 'icon', title: 'Bearbeiten', 'aria-label': 'Bearbeiten', onclick: () => editGroup(g) }, '✎'),
    el('button', { class: 'icon', title: 'Alle öffnen', 'aria-label': 'Alle öffnen', onclick: () => openGroup(g) }, '▶')))));
}

function selectGroup(g) {
  const ids = new Set(g.sessionIds);
  let n = 0;
  for (const p of panes.values()) { p.target = ids.has(p.session.id); if (p.target) n++; }
  if (!n) { toast('Keine Sitzung dieser Gruppe ist offen – ▶ öffnet alle'); return; }
  state.multi.scope = 'selected';
  if (!state.multi.on) toggleMulti(true); else refreshAll();
  toast(`${n} Sitzung(en) ausgewählt`);
}

async function editGroup(g0 = null, preset = []) {
  const g = g0 ? { ...g0, sessionIds: [...g0.sessionIds] } : { name: '', sessionIds: preset };
  const chosen = new Set(g.sessionIds);
  const name = el('input', { value: g.name, placeholder: 'z. B. Etage 2' });
  const filter = el('input', { type: 'search', placeholder: 'Profile filtern' });
  const count = el('span', { class: 'muted small' });
  const list = el('div', { class: 'pick' });
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    count.textContent = `${chosen.size} von höchstens 50 ausgewählt`;
    list.replaceChildren(...state.data.sessions
      .filter((s) => !q || [s.name, s.host, s.folder].some((v) => v && v.toLowerCase().includes(q)))
      .sort((a, b) => (a.folder || '').localeCompare(b.folder || '', 'de') || a.name.localeCompare(b.name, 'de', { numeric: true }))
      .map((s) => el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: chosen.has(s.id), onchange: (e) => {
          if (e.target.checked && chosen.size >= 50) { e.target.checked = false; toast('Höchstens 50 Profile je Gruppe'); return; }
          if (e.target.checked) chosen.add(s.id); else chosen.delete(s.id);
          count.textContent = `${chosen.size} von höchstens 50 ausgewählt`;
        } }), s.name, el('span', { class: 'sub' }, subline(s)))));
  };
  filter.addEventListener('input', draw);
  draw();
  const body = el('div', { class: 'body' }, field('Name', name), el('div', { class: 'row' }, filter, count), list);
  await modal(g0 ? `Gruppe bearbeiten – ${g0.name}` : 'Neue Gruppe', body, [
    ...(g0 ? [{ label: 'Löschen', cls: 'danger', left: true, action: async () => {
      if (!(await confirmDialog('Gruppe löschen?', `„${g0.name}“ wird gelöscht. Die Profile bleiben erhalten.`, 'Löschen'))) return false;
      await api.deleteGroup(g0.id); await reload();
    } }] : []),
    { label: 'Abbrechen', value: null },
    { label: 'Speichern', cls: 'primary', action: async () => {
      try { await api.saveGroup({ id: g.id, name: name.value, sessionIds: [...chosen] }); await reload(); toast('Gruppe gespeichert'); } catch (e) { toast(e.message); return false; }
    } },
  ], { wide: true });
}

/** Gruppe öffnen: alle Profile in einen neuen Tab, ein gemeinsames Passwort für Profile ohne gemerktes. */
async function openGroup(g) {
  const list = g.sessionIds.map((id) => state.data.sessions.find((s) => s.id === id)).filter(Boolean);
  if (!list.length) return;
  const has = await Promise.all(list.map((s) => api.hasPassword(s.id).catch(() => false)));
  const missing = list.filter((s, i) => !has[i] && s.protocol !== 'local' && s.protocol !== 'raw').length;
  const pw = el('input', { type: 'password', autocomplete: 'new-password', placeholder: missing ? 'für Profile ohne gemerktes Passwort' : 'nicht nötig' });
  const trust = el('input', { type: 'checkbox', checked: true });
  const target = el('input', { type: 'checkbox', checked: true });
  const body = el('div', { class: 'body' },
    el('p', {}, `${list.length} Profil(e) werden in einem neuen Tab geöffnet${list.length > 12 ? ' (Ansicht Fokus)' : ' (Ansicht Raster)'}.`),
    missing ? field(`Passwort für ${missing} Profil(e) ohne gemerktes Passwort (leer = einzeln fragen)`, pw) : null,
    el('label', { class: 'check' }, trust, 'Neue Host-Schlüssel ohne Rückfrage merken (nur Erstkontakt – geänderte Schlüssel fragen immer)'),
    el('label', { class: 'check' }, target, 'Alle als Ziel für „An mehrere“ auswählen'));
  const r = await modal(`Gruppe öffnen – ${g.name}`, body, [{ label: 'Abbrechen', value: null }, { label: 'Öffnen', cls: 'primary', action: () => ({ pw: pw.value, trust: trust.checked, target: target.checked }) }]);
  if (!r) return;
  const tab = newTab(g.name);
  tab.layout = list.length > 12 ? 'focus' : 'grid';
  list.forEach((s, i) => {
    const pane = newPane(tab, s);
    pane.target = r.target;
    start(pane, { password: !has[i] && r.pw ? r.pw : undefined, trustNew: r.trust });
  });
  activate(tab.id);
  if (r.target) { state.multi.scope = 'selected'; toggleMulti(true); }
}

// ---------- Tabs und Bereiche ----------
function activeTab() { return state.tabs.find((t) => t.id === state.active) || null; }
function focusedPane() {
  const t = activeTab();
  return t ? t.panes.find((p) => p.id === t.focus) || t.panes[0] : null;
}

function renderTabs() {
  const host = $('#tabs');
  host.replaceChildren(...state.tabs.map((t) => {
    const p = t.panes[0];
    const worst = t.panes.some((x) => x.state === 'error' || x.state === 'closed') ? 'error' : t.panes.some((x) => x.state === 'connecting') ? 'connecting' : p ? p.state : 'closed';
    return el('div', { class: 'tab' + (t.id === state.active ? ' active' : ''), role: 'tab', onclick: () => activate(t.id), onauxclick: (e) => { if (e.button === 1) closeTab(t.id); } },
      el('span', { class: 'dot st-' + worst }),
      el('span', { class: 't' }, t.title + (t.panes.length > 1 ? ` · ${t.panes.length}` : ''),
        t.panes.length === 1 && portHint(p.session, t.title) ? el('span', { class: 'port' }, portHint(p.session, t.title)) : null),
      el('button', { class: 'x', title: 'Tab schließen (⌘W)', 'aria-label': 'Tab schließen', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, '×'));
  }));
  $('#empty').hidden = state.tabs.length > 0;
  const t = activeTab();
  const single = !t || t.panes.length < 2;
  $('#view-seg').classList.toggle('dim', single);
  $('#view-seg').title = single
    ? 'Raster, Spalten, Zeilen und Fokus ordnen mehrere Sitzungen in EINEM Tab an. Dieser Tab hat nur eine Sitzung – Klick bietet an, die offenen Tabs hier zusammenzuführen.'
    : '';
  for (const b of document.querySelectorAll('#view-seg button')) {
    b.classList.toggle('on', Boolean(t) && !single && t.layout === b.dataset.view);
    b.disabled = !t;
  }
  requestAnimationFrame(() => {
    const cur = host.querySelector('.tab.active');
    if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateTabArrows();
  });
}

/** Pfeile links/rechts neben den Tabs, sobald nicht alle Tabs hineinpassen. */
function updateTabArrows() {
  const host = $('#tabs');
  const over = host.scrollWidth > host.clientWidth + 1;
  $('#tabs-left').hidden = !over;
  $('#tabs-right').hidden = !over;
  $('#tabs-left').disabled = host.scrollLeft <= 0;
  $('#tabs-right').disabled = host.scrollLeft + host.clientWidth >= host.scrollWidth - 1;
}
function scrollTabs(dir) {
  const host = $('#tabs');
  host.scrollBy({ left: dir * Math.max(160, host.clientWidth * 0.7), behavior: 'smooth' });
}

/** Anordnung der Bereiche: Raster (Kamerawand), Spalten, Zeilen oder Fokus (einer groß + Liste). */
function layout(t) {
  const n = t.panes.length;
  const mode = t.layout;
  let cols = 1;
  let rows = 1;
  if (mode === 'grid') { cols = Math.ceil(Math.sqrt(n)); rows = Math.ceil(n / cols); } else if (mode === 'cols') cols = n; else if (mode === 'rows') rows = n;
  t.grid.style.gridTemplateColumns = `repeat(${Math.max(1, cols)}, minmax(0, 1fr))`;
  t.grid.style.gridTemplateRows = `repeat(${Math.max(1, rows)}, minmax(0, 1fr))`;
  const focus = mode === 'focus';
  if (focus && !t.panes.some((p) => p.id === t.focus) && t.panes[0]) t.focus = t.panes[0].id;
  t.panes.forEach((p) => {
    p.root.classList.toggle('off', focus && p.id !== t.focus);
    // Letzte Zeile im Raster auffüllen, damit keine Lücke bleibt.
    p.root.style.gridColumn = '';
  });
  if (mode === 'grid' && n > 1 && n % cols) t.panes[n - 1].root.style.gridColumn = `${(n - 1) % cols + 1} / span ${cols - ((n - 1) % cols)}`;
  t.focusbar.hidden = !focus || n < 2;
  t.statuslist.hidden = !focus || n < 2;
  if (focus) renderFocusUi(t);
  requestAnimationFrame(() => t.panes.forEach((p) => { if (!p.root.classList.contains('off')) fit(p); }));
}

function paneStatus(p) {
  if (p.state === 'connecting') return ['verbinde', 'wait'];
  if (p.state === 'error') return ['FEHLER', 'bad'];
  if (p.state === 'closed') return ['getrennt', 'bad'];
  if (p.err) return ['% FEHLER', 'bad'];
  return ['OK', ''];
}

function renderFocusUi(t) {
  const sel = el('select', { 'aria-label': 'Sitzung wählen', onchange: (e) => showInFocus(t, e.target.value) },
    t.panes.map((p, i) => el('option', { value: p.id, selected: p.id === t.focus }, `${i + 1}. ${p.title}${p.err ? '  – % Fehler' : p.state !== 'ready' ? `  – ${paneStatus(p)[0]}` : ''}`)));
  const i = t.panes.findIndex((p) => p.id === t.focus);
  const bad = t.panes.filter((p) => paneStatus(p)[1] === 'bad').length;
  t.focusbar.replaceChildren(...[sel,
    el('button', { title: 'Vorherige Sitzung', 'aria-label': 'Vorherige Sitzung', onclick: () => stepFocus(t, -1) }, '‹'),
    el('button', { title: 'Nächste Sitzung', 'aria-label': 'Nächste Sitzung', onclick: () => stepFocus(t, 1) }, '›'),
    el('span', { class: 'count' }, `${i + 1} von ${t.panes.length}`),
    bad ? el('button', { class: 'danger', title: 'Zur nächsten Sitzung mit Fehler', onclick: () => nextBad(t) }, `${bad} mit Fehler →`) : null].filter(Boolean));
  t.statuslist.replaceChildren(...t.panes.map((p) => {
    const [txt, cls] = paneStatus(p);
    return el('div', { class: 'sitem' + (p.id === t.focus ? ' cur' : ''), title: p.err || p.statusText || '', onclick: () => showInFocus(t, p.id) },
      p.target && state.multi.on ? el('span', { class: 'dot', style: 'background:var(--danger)' }) : el('span', { class: 'dot st-' + p.state }),
      el('span', { class: 'name' }, p.title), el('span', { class: 'st ' + cls }, txt));
  }));
}

function showInFocus(t, id) {
  t.focus = id;
  layout(t);
  markFocus();
  const p = panes.get(id);
  if (p) p.term.focus();
}
function stepFocus(t, dir) {
  const i = t.panes.findIndex((p) => p.id === t.focus);
  const next = t.panes[(i + dir + t.panes.length) % t.panes.length];
  if (next) showInFocus(t, next.id);
}
function nextBad(t) {
  const i = t.panes.findIndex((p) => p.id === t.focus);
  for (let k = 1; k <= t.panes.length; k++) {
    const p = t.panes[(i + k) % t.panes.length];
    if (paneStatus(p)[1] === 'bad') { showInFocus(t, p.id); return; }
  }
}

async function setLayout(mode) {
  const t = activeTab();
  if (!t) return;
  if (t.panes.length < 2) {
    const names = { grid: 'Raster', cols: 'Spalten', rows: 'Zeilen', focus: 'Fokus' };
    if (state.tabs.length < 2) { toast(`${names[mode]} ordnet mehrere Sitzungen in einem Tab an – mit „+ Bereich“ eine weitere öffnen`); return; }
    const n = state.tabs.reduce((a, x) => a + x.panes.length, 0);
    if (!(await confirmDialog(`${names[mode]}: Tabs zusammenführen?`,
      `${names[mode]} zeigt mehrere Sitzungen gleichzeitig in einem Tab. Alle ${n} offenen Sitzungen in diesen Tab holen? (Einzeln wieder lösen: ⇱ im Bereich)`, 'Zusammenführen'))) return;
    if (!mergeTabs()) return;
  }
  t.layout = mode;
  layout(t);
  renderTabs();
}

function activate(id) {
  state.active = id;
  for (const t of state.tabs) t.view.hidden = t.id !== id;
  renderTabs();
  markFocus();
  const t = activeTab();
  if (t) { layout(t); const p = focusedPane(); if (p) p.term.focus(); }
}

function fit(p) {
  try {
    p.fit.fit();
    if (p.state === 'ready') api.resize(p.id, p.term.cols, p.term.rows);
  } catch { /* unsichtbar */ }
}

function newTab(title) {
  const grid = el('div', { class: 'grid' });
  const focusbar = el('div', { class: 'focusbar glass', hidden: true });
  const statuslist = el('div', { class: 'statuslist glass', hidden: true });
  const view = el('div', { class: 'tabview' }, focusbar, el('div', { class: 'tv-body' }, grid, statuslist));
  const tab = { id: 't' + (++seq), title, panes: [], view, grid, focusbar, statuslist, layout: 'grid', focus: null };
  $('#panes-host').append(view);
  state.tabs.push(tab);
  return tab;
}

function newPane(tab, session) {
  const id = 'p' + (++seq) + '-' + Date.now().toString(36);
  const termBox = el('div', { class: 'term' });
  const msg = el('span', { class: 'msg' }, '…');
  const logInfo = el('span', { class: 'logf', title: 'Im Finder zeigen' });
  const head = el('div', { class: 'phead', draggable: 'true' });
  const root = el('div', { class: 'pane' }, head, termBox, el('div', { class: 'status' }, msg, logInfo));
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, "JetBrains Mono", Consolas, monospace', fontSize: state.data.settings.fontSize,
    scrollback: state.data.settings.scrollback || 10000, cursorBlink: true, allowProposedApi: true, allowTransparency: true,
    theme: isDark() ? THEMES.dark : THEMES.light, macOptionIsMeta: true, rightClickSelectsWord: true,
    minimumContrastRatio: 3, // farbige Treffer (z. B. Orange) bleiben auch im hellen Design lesbar
  });
  const fitAddon = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(search);
  term.open(termBox);
  const pane = { id, tab, session, title: tabTitle(session), term, fit: fitAddon, search, root, head, msg, logInfo, state: 'connecting', target: false, err: null, logFile: null };
  panes.set(id, pane);
  term.onData((d) => {
    if (pane.state === 'closed' || pane.state === 'error') {
      if (d === '\r') reconnect(pane);
      return;
    }
    sendInput(pane, d);
  });
  // Kopieren bei Auswahl wie PuTTY; Rechtsklick fügt ein.
  term.onSelectionChange(() => { const s = term.getSelection(); if (s) navigator.clipboard.writeText(s).catch(() => {}); });
  termBox.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const text = await navigator.clipboard.readText().catch(() => '');
    if (text) pastePane(pane, text);
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.metaKey && e.key === 'v') { navigator.clipboard.readText().then((t) => t && pastePane(pane, t)); return false; }
    if (e.type === 'keydown' && e.metaKey && e.key === 'c' && term.hasSelection()) return false;
    return true;
  });
  root.addEventListener('mousedown', () => { if (pane.tab.focus !== pane.id) { pane.tab.focus = pane.id; markFocus(); } });
  term.textarea && term.textarea.addEventListener('focus', () => { if (pane.tab.focus !== pane.id) { pane.tab.focus = pane.id; markFocus(); } });
  // Bereiche per Ziehen am Kopf umsortieren.
  head.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/cable-pane', pane.id); e.dataTransfer.effectAllowed = 'move'; });
  root.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('text/cable-pane')) { e.preventDefault(); root.classList.add('drop'); } });
  root.addEventListener('dragleave', () => root.classList.remove('drop'));
  root.addEventListener('drop', (e) => {
    root.classList.remove('drop');
    const from = panes.get(e.dataTransfer.getData('text/cable-pane'));
    if (from && from !== pane) { e.preventDefault(); movePane(from, pane.tab, pane); }
  });
  new ResizeObserver(() => fit(pane)).observe(termBox);
  tab.panes.push(pane);
  tab.grid.append(root);
  tab.focus = id;
  renderHead(pane);
  return pane;
}

function renderHead(p) {
  const [txt, cls] = paneStatus(p);
  p.head.replaceChildren(...[
    el('label', { class: 'tgt', title: 'Ziel für „An mehrere“' }, el('input', { type: 'checkbox', checked: p.target, onchange: (e) => { p.target = e.target.checked; refreshAll(); } })),
    el('span', { class: 'dot st-' + p.state }),
    el('span', { class: 'name' }, p.title),
    el('span', { class: 'sub' }, p.session.protocol === 'local' ? 'lokal' : subline(p.session)),
    cls === 'bad' && p.state === 'ready' ? el('span', { class: 'err', title: p.err || '' }, txt) : null,
    el('button', { class: p.logFile ? 'rec' : '', title: p.logFile ? 'Aufzeichnung beenden (⌘⇧R)' : 'Ausgabe in Datei mitschreiben (⌘⇧R)', 'aria-label': p.logFile ? 'Aufzeichnung beenden' : 'Aufzeichnen', onclick: () => toggleRecord(p) }, '●', el('span', { class: 'lbl' }, p.logFile ? ' Aufnahme' : ' Aufzeichnen')),
    el('button', { title: 'Verlauf als Textdatei speichern (⌘S)', 'aria-label': 'Verlauf speichern', onclick: () => exportPane(p) }, '⤓', el('span', { class: 'lbl' }, ' Speichern')),
    p.tab.panes.length > 1 ? el('button', { title: 'In eigenen Tab lösen', 'aria-label': 'In eigenen Tab lösen', onclick: () => detachPane(p) }, '⇱') : null,
    el('button', { title: 'Diesen Bereich schließen (⌘⇧W)', 'aria-label': 'Bereich schließen', onclick: () => askClosePane(p) }, '✕'),
  ].filter(Boolean));
}

/** Alles neu zeichnen, was von Zustand, Auswahl oder „An mehrere“ abhängt. */
function refreshAll() {
  for (const p of panes.values()) renderHead(p);
  renderTabs();
  renderOpenList();
  renderStaging();
  renderMultiBar();
  renderSnippetTarget();
  markFocus();
  const t = activeTab();
  if (t && t.layout === 'focus') renderFocusUi(t);
}
let refreshQueued = false;
function refreshSoon() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => { refreshQueued = false; refreshAll(); });
}

function markFocus() {
  const targets = new Set(state.multi.on ? targetPanes() : []);
  for (const p of panes.values()) {
    p.root.classList.toggle('focus', p.tab.focus === p.id && p.tab.panes.length > 1);
    p.root.classList.toggle('target', targets.has(p));
  }
}

function renderOpenList() {
  const all = [...panes.values()];
  $('#open-title').textContent = `Offene Sitzungen${all.length ? ` (${all.length})` : ''}`;
  const box = $('#open-list');
  if (!all.length) { box.className = 'muted small'; box.textContent = 'Noch keine Verbindung.'; return; }
  box.className = '';
  const cur = focusedPane();
  box.replaceChildren(el('div', { class: 'olist' }, all.map((p) => el('div', { class: 'oitem' + (p === cur ? ' cur' : '') },
    el('input', { type: 'checkbox', checked: p.target, title: 'Ziel für „An mehrere“', 'aria-label': `${p.title} auswählen`, onchange: (e) => { p.target = e.target.checked; refreshAll(); } }),
    el('span', { class: 'dot st-' + p.state }),
    el('span', { class: 'name', title: subline(p.session), onclick: () => revealPane(p) }, p.title,
      portHint(p.session, p.title) ? el('span', { class: 'port' }, portHint(p.session, p.title)) : null),
    p.logFile ? el('span', { class: 'flag', title: 'Wird aufgezeichnet' }, '●') : null,
    p.err ? el('span', { class: 'flag', title: p.err }, '%') : null,
    el('button', { class: 'icon x', title: 'Schließen', 'aria-label': `${p.title} schließen`, onclick: () => askClosePane(p) }, '✕')))));
}

function revealPane(p) {
  if (state.active !== p.tab.id) activate(p.tab.id);
  if (p.tab.layout === 'focus') showInFocus(p.tab, p.id);
  else { p.tab.focus = p.id; markFocus(); p.term.focus(); }
  renderOpenList();
}

// ---------- An mehrere ----------
function targetPanes() {
  const ready = (p) => p.state === 'ready';
  if (state.multi.scope === 'all') return [...panes.values()].filter(ready);
  if (state.multi.scope === 'tab') { const t = activeTab(); return t ? t.panes.filter(ready) : []; }
  return [...panes.values()].filter((p) => p.target && ready(p));
}

function toggleMulti(force) {
  state.multi.on = typeof force === 'boolean' ? force : !state.multi.on;
  if (state.multi.on && state.multi.scope === 'selected' && ![...panes.values()].some((p) => p.target)) state.multi.scope = 'tab';
  $('#btn-broadcast').classList.toggle('on', state.multi.on);
  $('#multibar').hidden = !state.multi.on;
  refreshAll();
  const t = activeTab();
  if (t) layout(t);
  if (state.multi.on) setTimeout(() => $('#mb-input').focus(), 0);
}

function renderMultiBar() {
  const all = [...panes.values()].filter((p) => p.state === 'ready');
  const t = activeTab();
  $('#n-selected').textContent = all.filter((p) => p.target).length;
  $('#n-tab').textContent = t ? t.panes.filter((p) => p.state === 'ready').length : 0;
  $('#n-all').textContent = all.length;
  for (const b of document.querySelectorAll('#scope-seg button')) b.classList.toggle('on', b.dataset.scope === state.multi.scope);
  const n = targetPanes().length;
  $('#mb-send').textContent = `An ${n} senden`;
  $('#mb-send').disabled = !n;
  $('#mb-rec').classList.toggle('rec', state.multi.rec);
  $('#mb-rec').textContent = state.multi.rec ? '● Aufnahme läuft' : '● Aufzeichnen';
}

/**
 * Eingabe an diesen Bereich – oder, wenn „An mehrere“ an ist und der Bereich zu den Zielen gehört, an alle
 * Ziele. Tippen in einem Bereich, der kein Ziel ist, bleibt bei ihm.
 */
function sendInput(pane, data) {
  if (state.multi.on) {
    const targets = targetPanes();
    if (targets.includes(pane)) { for (const p of targets) writeTo(p, data); return; }
  }
  if (pane.state === 'ready') writeTo(pane, data);
}

function writeTo(p, data) {
  if (data.includes('\r') && p.err) { p.err = null; refreshSoon(); }
  api.write(p.id, data);
}

function sendLineToTargets(line) {
  const targets = targetPanes();
  if (!targets.length) { toast('Keine verbundenen Ziele'); return; }
  for (const p of targets) writeTo(p, line + '\r');
  toast(`An ${targets.length} Sitzung(en) gesendet`);
}

const mbHistory = [];
let mbIndex = 0;
function multiBarKeys(e) {
  const inp = e.target;
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = inp.value;
    if (!v.trim() && !e.shiftKey) { sendLineToTargets(''); return; }
    sendLineToTargets(v);
    if (v.trim() && mbHistory[mbHistory.length - 1] !== v) mbHistory.push(v);
    mbIndex = mbHistory.length;
    inp.value = '';
  } else if (e.key === 'ArrowUp' && mbHistory.length) {
    e.preventDefault(); mbIndex = Math.max(0, mbIndex - 1); inp.value = mbHistory[mbIndex];
  } else if (e.key === 'ArrowDown' && mbHistory.length) {
    e.preventDefault(); mbIndex = Math.min(mbHistory.length, mbIndex + 1); inp.value = mbHistory[mbIndex] || '';
  } else if (e.key === 'Escape') toggleMulti(false);
}

async function recordTargets() {
  const on = !state.multi.rec;
  const targets = targetPanes();
  if (on && !targets.length) { toast('Keine verbundenen Ziele'); return; }
  let n = 0;
  for (const p of on ? targets : [...panes.values()].filter((x) => x.logFile)) {
    try { p.logFile = await api.setLogging(p.id, on); n++; } catch { /* getrennt */ }
  }
  state.multi.rec = on;
  refreshAll();
  toast(on ? `${n} Sitzung(en) werden aufgezeichnet` : 'Aufzeichnungen beendet');
}

/** Mehrzeiliges Einfügen erst nach Rückfrage (Schutz vor versehentlich eingefügter Konfiguration). */
async function pastePane(pane, text) {
  const lines = text.split(/\r?\n/).filter((l, i, a) => l || i < a.length - 1).length;
  const targets = state.multi.on && targetPanes().includes(pane) ? targetPanes().length : 1;
  if (lines > 1 || targets > 1) {
    const ok = await confirmDialog(lines > 1 ? 'Mehrere Zeilen einfügen?' : 'An mehrere einfügen?', `${lines} Zeile(n) gehen an ${targets > 1 ? `${targets} Sitzungen` : 'diese Sitzung'}.`, 'Einfügen');
    if (!ok) return;
  }
  sendInput(pane, text.replace(/\r?\n/g, '\r'));
}

function tabTitle(s) { return s.name || s.host || s.path || 'Sitzung'; }

async function connect(session, opts = {}) {
  let tab = opts.intoTab;
  if (!tab) tab = newTab(tabTitle(session));
  if (tab.panes.length >= MAX_PANES) { toast(`Höchstens ${MAX_PANES} Bereiche je Tab`); return null; }
  const pane = newPane(tab, session);
  activate(tab.id);
  refreshAll();
  await start(pane, opts);
  return pane;
}

async function start(pane, opts = {}) {
  pane.state = 'connecting';
  pane.err = null;
  pane.connectOpts = { password: opts.password, trustNew: opts.trustNew };
  setStatus(pane, 'Verbinde …');
  refreshSoon();
  fit(pane);
  try {
    const r = await api.open(pane.id, pane.session.id && !pane.session.draft ? { id: pane.session.id } : pane.session, pane.term.cols, pane.term.rows, pane.connectOpts);
    pane.label = r.label;
    if (r.log) setLog(pane, r.log);
  } catch (e) {
    pane.state = 'error';
    setStatus(pane, e.message, true);
    pane.term.writeln(`\r\n\x1b[31m${e.message}\x1b[0m\r\n\x1b[2mEnter = erneut versuchen\x1b[0m`);
    refreshSoon();
  }
}

function reconnect(pane) {
  if (pane.state === 'ready' || pane.state === 'connecting') return;
  const old = pane.id;
  panes.delete(old);
  pane.id = 'p' + (++seq) + '-' + Date.now().toString(36);
  panes.set(pane.id, pane);
  if (pane.tab.focus === old) pane.tab.focus = pane.id;
  setLog(pane, null);
  pane.term.writeln('\r\n\x1b[2m— neu verbinden —\x1b[0m');
  start(pane, pane.connectOpts || {});
}

function setStatus(pane, text, error = false) {
  pane.statusText = text;
  pane.msg.textContent = text;
  pane.msg.classList.toggle('err', error);
}

function setLog(pane, file) {
  pane.logFile = file;
  pane.logInfo.textContent = file ? `● Aufzeichnung: ${file.split('/').pop()}` : '';
  pane.logInfo.onclick = file ? () => api.revealLog(file) : null;
}

async function toggleRecord(p = focusedPane()) {
  if (!p) return;
  if (p.state !== 'ready') { toast('Nur bei verbundener Sitzung'); return; }
  try {
    const file = await api.setLogging(p.id, !p.logFile);
    setLog(p, file);
    toast(file ? `Aufzeichnung läuft: ${file.split('/').pop()}` : 'Aufzeichnung beendet');
  } catch (e) { toast(e.message); }
  refreshAll();
}

/** Gesamten Verlauf des Terminals (Scrollback + Bildschirm) als Text. */
function bufferText(p) {
  const b = p.term.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n') + '\n';
}

async function exportPane(p = focusedPane()) {
  if (!p) return;
  try {
    const file = await api.exportText(p.title, bufferText(p));
    if (file) toast(`Gespeichert: ${file.split('/').pop()}`);
  } catch (e) { toast(e.message); }
}

async function askClosePane(p) {
  if (p.state === 'ready' && !(await confirmDialog('Bereich schließen?', `Die Verbindung zu „${p.title}“ wird getrennt.`, 'Schließen'))) return;
  closePane(p);
}

function closePane(pane) {
  api.close(pane.id).catch(() => {});
  pane.term.dispose();
  pane.root.remove();
  panes.delete(pane.id);
  const t = pane.tab;
  t.panes = t.panes.filter((p) => p !== pane);
  if (!t.panes.length) removeTab(t);
  else { if (t.focus === pane.id) t.focus = t.panes[0].id; layout(t); }
  refreshAll();
}

function removeTab(t) {
  t.view.remove();
  const i = state.tabs.indexOf(t);
  if (i >= 0) state.tabs.splice(i, 1);
  if (state.active === t.id) {
    const next = state.tabs[Math.max(0, i - 1)];
    state.active = next ? next.id : null;
    if (next) activate(next.id);
  }
}

async function closeTab(id) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  const live = t.panes.filter((p) => p.state === 'ready').length;
  if (live && !(await confirmDialog('Tab schließen?', `${live} offene Verbindung(en) werden getrennt.`, 'Schließen'))) return;
  for (const p of [...t.panes]) closePane(p);
}

/** Bereich in einen anderen (oder denselben) Tab verschieben, vor `before`. */
function movePane(p, toTab, before = null) {
  const from = p.tab;
  from.panes = from.panes.filter((x) => x !== p);
  p.tab = toTab;
  const i = before ? toTab.panes.indexOf(before) : -1;
  if (i >= 0) { toTab.panes.splice(i, 0, p); toTab.grid.insertBefore(p.root, before.root); } else { toTab.panes.push(p); toTab.grid.append(p.root); }
  p.root.classList.remove('off');
  toTab.focus = p.id;
  if (from !== toTab) {
    if (!from.panes.length) removeTab(from);
    else { if (from.focus === p.id) from.focus = from.panes[0].id; layout(from); }
  }
  layout(toTab);
  activate(toTab.id);
  refreshAll();
}

function detachPane(p) {
  const t = newTab(p.title);
  movePane(p, t);
}

function mergeTabs() {
  const t = activeTab();
  if (!t || state.tabs.length < 2) { toast('Nur ein Tab offen'); return false; }
  const others = state.tabs.filter((x) => x !== t);
  const n = others.reduce((a, x) => a + x.panes.length, t.panes.length);
  if (n > MAX_PANES) { toast(`Höchstens ${MAX_PANES} Bereiche je Tab`); return false; }
  for (const o of others) for (const p of [...o.panes]) movePane(p, t);
  t.title = 'Alle';
  if (t.panes.length > 12) t.layout = 'focus';
  activate(t.id);
  return true;
}

api.onData(({ tabId, data }) => {
  const p = panes.get(tabId);
  if (!p) return;
  p.term.write(data);
  // Cisco-Fehlermeldungen nach einem Befehl merken (Statusliste, Kopf, „n mit Fehler“).
  if (!p.err && /%|rror/.test(data)) {
    const m = stripAnsi(data).match(/^\s*(% ?(?:Invalid|Incomplete|Ambiguous|Unknown|Unrecognized|Bad|Error)[^\r\n]*|ERROR:[^\r\n]*)/mi);
    if (m) { p.err = m[1].trim().slice(0, 120); refreshSoon(); }
  }
});
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, ''); }

api.onState(({ tabId, state: st, message, log }) => {
  const p = panes.get(tabId);
  if (!p) return;
  if (st === 'notice') { p.term.writeln(`\r\n\x1b[2m${message}\x1b[0m`); setStatus(p, message); return; }
  const hadError = p.state === 'error';
  p.state = st;
  if (!(st === 'closed' && hadError)) setStatus(p, message, st === 'error');
  if (log) setLog(p, log);
  if (st === 'ready') fit(p);
  if (st === 'closed' || st === 'error') {
    if (p.logFile) setLog(p, null);
    if (st === 'error') p.term.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
    if (st === 'closed') p.term.writeln('\r\n\x1b[2mGetrennt. Enter = neu verbinden.\x1b[0m');
  }
  refreshSoon();
});

// ---------- Dialoge ----------
function modal(title, body, buttons, { wide = false, onClose } = {}) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const close = (v) => {
      bd.remove();
      if (onClose) onClose(v);
      resolve(v);
      // Tastatur zurück ins Terminal, sonst gehen Eingaben nach einem Dialog verloren.
      if (!$('#modal-root').children.length) setTimeout(() => { if (state.multi.on) $('#mb-input').focus(); else { const p = focusedPane(); if (p) p.term.focus(); } }, 0);
    };
    const footer = el('footer', {}, buttons.map((b) => el('button', { class: (b.cls || '') + (b.left ? ' left' : ''), onclick: async () => {
      if (b.action) { const r = await b.action(); if (r === false) return; close(r === undefined ? b.value : r); } else close(b.value);
    } }, b.label)));
    const dlg = el('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, el('header', {}, title), body, footer);
    const bd = el('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === bd) close(null); } }, dlg);
    bd.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); const p = footer.querySelector('.primary'); if (p) p.click(); }
    });
    root.append(bd);
    setTimeout(() => { const f = dlg.querySelector('input:not([type=checkbox]):not([type=search]), select, textarea, button.primary'); if (f) f.focus(); }, 0);
  });
}

function confirmDialog(title, text, ok = 'OK') {
  return modal(title, el('div', { class: 'body' }, el('p', {}, text)), [{ label: 'Abbrechen', value: false }, { label: ok, value: true, cls: 'primary' }]).then(Boolean);
}

function field(label, input) { return el('label', {}, label, input); }

/** Profil anlegen oder bearbeiten: getrennte Felder für Host/IP, Port, Benutzer und Passwort. */
async function editSession(s0 = null, prefill = null) {
  const s = s0 ? JSON.parse(JSON.stringify(s0)) : { protocol: 'ssh', port: 22, auth: 'auto', forwards: [], highlight: true, keepalive: 30, ...(prefill || {}) };
  s.forwards ??= [];
  let password = prefill && prefill.password ? prefill.password : '';
  if (prefill && prefill.password) s.savePassword = true;
  const hasSaved = s0 ? await api.hasPassword(s0.id).catch(() => false) : false;
  const body = el('div', { class: 'body' });
  const draw = () => {
    const P = s.protocol;
    const inp = (k, attrs = {}) => el('input', { value: s[k] ?? '', oninput: (e) => { s[k] = attrs.type === 'number' ? Number(e.target.value) : e.target.value; }, ...attrs });
    const sel = (k, opts, onchange) => el('select', { onchange: (e) => { s[k] = e.target.value; if (onchange) onchange(); } }, opts.map(([v, l]) => el('option', { value: v, selected: String(s[k]) === String(v) }, l)));
    const chk = (k, label) => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: Boolean(s[k]), onchange: (e) => { s[k] = e.target.checked; } }), label);
    const folders = [...new Set(state.data.sessions.map((x) => x.folder).filter(Boolean))];
    const pwField = () => field(hasSaved ? 'Passwort (gespeichert – leer lassen = behalten)' : 'Passwort', el('input', { type: 'password', value: password, autocomplete: 'new-password', placeholder: hasSaved ? '••••••••' : '', oninput: (e) => { password = e.target.value; } }));
    const parts = [
      el('div', { class: 'row' },
        field('Name', inp('name', { placeholder: 'z. B. Core-Switch RZ1' })),
        field('Protokoll', sel('protocol', [['ssh', 'SSH'], ['telnet', 'Telnet'], ['serial', 'Serial (Konsolenkabel)'], ['raw', 'Raw TCP'], ['local', 'Lokale Shell']], () => {
          s.port = DEFAULT_PORT[s.protocol] ?? s.port;
          if (s.protocol === 'serial') Object.assign(s, { baudRate: s.baudRate || 9600, dataBits: s.dataBits || 8, stopBits: s.stopBits || 1, parity: s.parity || 'none', flow: s.flow || 'none' });
          draw();
        }))),
    ];
    if (['ssh', 'telnet', 'raw'].includes(P)) parts.push(el('div', { class: 'row3' }, field('IP-Adresse / Host', inp('host', { placeholder: '10.0.0.1', spellcheck: 'false' })), field('Port', inp('port', { type: 'number', min: 1, max: 65535 })), el('span')));
    if (P === 'serial') {
      const pathSel = el('select', { onchange: (e) => { s.path = e.target.value; } }, el('option', { value: s.path || '' }, s.path || 'Anschluss wählen …'));
      api.serialPorts().then((ports) => { for (const p of ports) if (p.path !== s.path) pathSel.append(el('option', { value: p.path }, p.path)); }).catch(() => {});
      parts.push(el('div', { class: 'row' }, field('Anschluss', pathSel), field('Baudrate', sel('baudRate', [9600, 19200, 38400, 57600, 115200, 230400].map((b) => [b, b])))));
      parts.push(el('div', { class: 'row3' }, field('Datenbits / Parität / Stoppbits', el('div', { style: 'display:flex;gap:6px' }, sel('dataBits', [[8, '8'], [7, '7']]), sel('parity', [['none', 'keine'], ['even', 'gerade'], ['odd', 'ungerade']]), sel('stopBits', [[1, '1'], [2, '2']]))), field('Flusskontrolle', sel('flow', [['none', 'keine'], ['rtscts', 'RTS/CTS'], ['xonxoff', 'XON/XOFF']])), el('span')));
    }
    if (['ssh', 'telnet', 'serial'].includes(P)) {
      parts.push(el('div', { class: 'row' }, field('Benutzer', inp('username', { spellcheck: 'false', autocomplete: 'off' })), pwField()));
      parts.push(el('div', { class: 'row' },
        chk('savePassword', state.data.canStoreSecrets ? 'Passwort im Schlüsselbund speichern' : 'Passwort speichern (Schlüsselbund nicht verfügbar)'),
        P === 'ssh' ? chk('legacy', 'Alte Algorithmen erlauben (alte Cisco/HP)') : el('p', { class: 'muted small', style: 'margin:0' }, 'Cable antwortet einmal auf „Username:“ und „Password:“.')));
    }
    if (P === 'ssh') {
      parts.push(el('div', { class: 'row' },
        field('Anmeldung', sel('auth', [['auto', 'Automatisch (Agent, dann Passwort)'], ['password', 'Passwort'], ['key', 'Schlüsseldatei'], ['agent', 'Nur SSH-Agent']], draw)),
        s.auth === 'key' ? field('Schlüssel', el('div', { style: 'display:flex;gap:6px' }, inp('keyPath', { placeholder: '~/.ssh/id_ed25519' }), el('button', { onclick: async () => { const k = await api.pickKey(); if (k) { s.keyPath = k; draw(); } } }, '…'))) : field('Jump-Host (Profilname)', sel('jump', [['', '– keiner –'], ...state.data.sessions.filter((x) => x.protocol === 'ssh' && x.id !== s.id).map((x) => [x.name, x.name])]))));
      const fwdRows = el('div', { style: 'display:grid;gap:6px' });
      const drawFwd = () => {
        fwdRows.replaceChildren(...s.forwards.map((f, i) => el('div', { class: 'fwd' },
          el('select', { onchange: (e) => { f.type = e.target.value; drawFwd(); } }, [['L', 'Lokal'], ['R', 'Remote'], ['D', 'SOCKS']].map(([v, l]) => el('option', { value: v, selected: f.type === v }, l))),
          el('input', { type: 'number', placeholder: 'lokaler Port', value: f.bindPort ?? '', oninput: (e) => { f.bindPort = Number(e.target.value); } }),
          f.type === 'D' ? el('span', { class: 'muted small' }, '127.0.0.1 als Proxy') : el('input', { placeholder: 'Zielhost', value: f.host ?? '', oninput: (e) => { f.host = e.target.value; } }),
          f.type === 'D' ? el('span') : el('input', { type: 'number', placeholder: 'Port', value: f.port ?? '', oninput: (e) => { f.port = Number(e.target.value); } }),
          el('button', { class: 'icon', title: 'Entfernen', 'aria-label': 'Entfernen', onclick: () => { s.forwards.splice(i, 1); drawFwd(); } }, '×'))));
      };
      drawFwd();
      parts.push(el('div', {}, el('div', { class: 'section-head' }, el('span', {}, 'Portweiterleitungen'), el('button', { class: 'link', onclick: () => { s.forwards.push({ type: 'L' }); drawFwd(); } }, '+ hinzufügen')), fwdRows));
    }
    if (P === 'local') parts.push(field('Shell (leer = Standard)', inp('shell', { placeholder: '/bin/zsh' })));
    parts.push(el('div', { class: 'row' },
      field('Ordner', el('input', { value: s.folder || '', list: 'folders', oninput: (e) => { s.folder = e.target.value; } })),
      field('Farbe', el('input', { type: 'color', value: s.color || '#2459c4', oninput: (e) => { s.color = e.target.value; } }))));
    parts.push(el('datalist', { id: 'folders' }, folders.map((f) => el('option', { value: f }))));
    parts.push(field('Notiz', el('textarea', { rows: 2, oninput: (e) => { s.note = e.target.value; } }, s.note || '')));
    parts.push(el('div', { class: 'row' }, chk('log', 'Immer aufzeichnen (Datei)'), chk('highlight', 'Ausgabe hervorheben')));
    body.replaceChildren(...parts);
  };
  draw();
  const buttons = [
    ...(s0 ? [{ label: 'Löschen', cls: 'danger', left: true, action: async () => {
      if (!(await confirmDialog('Profil löschen?', `„${s0.name}“ und ein gemerktes Passwort werden entfernt.`, 'Löschen'))) return false;
      await api.deleteSession(s0.id); await reload(); toast('Gelöscht');
    } }] : []),
    { label: 'Abbrechen', value: null },
    { label: 'Speichern', action: () => save(false) },
    { label: 'Speichern & verbinden', cls: 'primary', action: () => save(true) },
  ];
  async function save(andConnect) {
    try {
      const saved = await api.saveSession({ ...s, password: s.savePassword ? password : '' });
      await reload();
      if (andConnect) connect(saved, { password: !s.savePassword && password ? password : undefined });
      return saved;
    } catch (e) { toast(e.message); return false; }
  }
  await modal(s0 ? `Profil bearbeiten – ${s0.name}` : 'Neues Profil', body, buttons, { wide: true });
}

api.onAsk(async (q) => {
  if (q.kind === 'hostkey') {
    const changed = q.state === 'changed';
    const body = el('div', { class: 'body' },
      changed ? el('div', { class: 'warnbox' }, el('b', {}, 'Achtung: Host-Schlüssel hat sich geändert! '), 'Das kann ein Angriff (Man-in-the-Middle) sein – oder das Gerät wurde neu aufgesetzt. Nur fortfahren, wenn du den neuen Fingerabdruck geprüft hast.') : el('p', {}, `Erste Verbindung zu ${q.host}:${q.port}. Fingerabdruck prüfen und merken?`),
      el('div', { class: 'fp' }, `${q.type}\n${q.fingerprint}`),
      changed && q.old ? el('p', { class: 'muted small' }, `Bisher: ${q.old.type} ${q.old.fingerprint} (seit ${String(q.old.added).slice(0, 10)})`) : null);
    const ok = await modal(changed ? 'Host-Schlüssel geändert' : 'Neuer Host', body, [{ label: 'Abbrechen', value: false, cls: changed ? 'primary' : '' }, { label: changed ? 'Trotzdem vertrauen' : 'Vertrauen & verbinden', value: true, cls: changed ? 'danger' : 'primary' }]);
    api.reply(q.id, Boolean(ok));
  } else if (q.kind === 'secret') {
    const inp = el('input', { type: 'password', autocomplete: 'off' });
    const save = el('input', { type: 'checkbox' });
    const body = el('div', { class: 'body' }, field(q.prompt, inp), q.canSave ? el('label', { class: 'check' }, save, 'Im Schlüsselbund speichern') : null);
    const r = await modal('Anmeldung', body, [{ label: 'Abbrechen', value: null }, { label: 'Anmelden', cls: 'primary', action: () => ({ value: inp.value, save: save.checked }) }]);
    api.reply(q.id, r && r.value !== undefined ? r : null);
  } else if (q.kind === 'keyboard') {
    const inputs = q.prompts.map((p) => el('input', { type: p.echo ? 'text' : 'password', autocomplete: 'off' }));
    const body = el('div', { class: 'body' }, q.prompts.map((p, i) => field(p.prompt, inputs[i])));
    const r = await modal(q.name || 'Anmeldung', body, [{ label: 'Abbrechen', value: null }, { label: 'Senden', cls: 'primary', action: () => inputs.map((i) => i.value) }]);
    api.reply(q.id, r);
  }
});

// ---------- Bausteine ----------
function renderSnippets() {
  const q = $('#snippet-search').value.trim().toLowerCase();
  const box = $('#snippet-list');
  const groups = new Map();
  for (const s of state.data.snippets) {
    if (q && ![s.name, s.text, s.group].some((v) => v.toLowerCase().includes(q))) continue;
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  if (!groups.size) { box.replaceChildren(el('p', { class: 'muted small' }, 'Keine Treffer.')); return; }
  box.replaceChildren(...[...groups].map(([g, items]) => {
    const closed = !q && state.closedSnippetGroups.has(g);
    return el('div', { class: 'sgroup' },
      el('h4', { onclick: () => {
        if (state.closedSnippetGroups.has(g)) state.closedSnippetGroups.delete(g); else state.closedSnippetGroups.add(g);
        localStorageSet('closedSnippetGroups', JSON.stringify([...state.closedSnippetGroups]));
        renderSnippets();
      } }, `${closed ? '▸' : '▾'} ${g}`),
      closed ? null : items.map((s) => el('button', { class: 'snip', title: s.text, onclick: (e) => runSnippet(s, e.altKey) }, s.name, el('small', {}, s.text.replace(/\n/g, '⏎ ')))));
  }));
}

function renderSnippetTarget() {
  const box = $('#snippet-target');
  if (state.multi.on) { box.replaceChildren('→ ', el('b', {}, `${targetPanes().length} Sitzungen`), ' (An mehrere)'); return; }
  const p = focusedPane();
  box.textContent = p ? `→ ${p.title}` : '→ keine Sitzung';
}

/** Platzhalter {{Name}} oder {{Name|Vorgabe}}; TFTP-Server wird mit der Adresse dieses Macs vorbelegt. */
async function runSnippet(s, insertOnly = false) {
  const pane = focusedPane();
  const targets = state.multi.on ? targetPanes() : pane && pane.state === 'ready' ? [pane] : [];
  if (!targets.length) { toast('Keine verbundene Sitzung'); return; }
  let text = s.text;
  const vars = [];
  for (const m of text.matchAll(/\{\{([^}|]{1,40})(?:\|([^}]{0,80}))?\}\}/g)) if (!vars.some((v) => v.name === m[1])) vars.push({ name: m[1], def: m[2] || '' });
  if (vars.length) {
    const addr = state.tftp.addresses && state.tftp.addresses[0] ? state.tftp.addresses[0].address : '';
    const inputs = vars.map((v) => el('input', { spellcheck: 'false', value: /tftp/i.test(v.name) && !v.def ? addr : v.def }));
    const r = await modal(s.name, el('div', { class: 'body' }, targets.length > 1 ? el('p', { class: 'infobox' }, `Geht an ${targets.length} Sitzungen.`) : null, vars.map((v, i) => field(v.name, inputs[i]))), [{ label: 'Abbrechen', value: null }, { label: 'Senden', cls: 'primary', action: () => inputs.map((i) => i.value) }]);
    if (!r) return;
    text = text.replace(/\{\{([^}|]{1,40})(?:\|[^}]{0,80})?\}\}/g, (_m, name) => r[vars.findIndex((v) => v.name === name)] ?? '');
  } else if (targets.length > 1 && /\n.+/.test(text.trim()) && !(await confirmDialog('Baustein an mehrere?', `„${s.name}“ (${text.trim().split('\n').length} Zeilen) geht an ${targets.length} Sitzungen.`, 'Senden'))) return;
  if (insertOnly) text = text.replace(/\n+$/, '');
  const data = text.replace(/\r?\n/g, '\r');
  for (const p of targets) writeTo(p, data);
  if (state.multi.on) $('#mb-input').focus(); else pane.term.focus();
}

async function editSnippets() {
  const ta = el('textarea', { rows: 20 }, state.data.snippets.map((s) => `[${s.group}] ${s.name}\n${s.text.replace(/\n$/, '')}`).join('\n\n'));
  const body = el('div', { class: 'body' }, el('p', { class: 'muted small' }, 'Je Baustein: erste Zeile „[Gruppe] Name“, darunter der Text (auch mehrzeilig). Leerzeile trennt Bausteine. Platzhalter {{Name}} oder {{Name|Vorgabe}} werden beim Senden abgefragt. Am Ende wird Enter gesendet.'), ta);
  const r = await modal('Bausteine bearbeiten', body, [{ label: 'Abbrechen', value: null }, { label: 'Speichern', cls: 'primary', action: () => ta.value }], { wide: true });
  if (r == null) return;
  const items = r.split(/\n\s*\n(?=\[)/).map((block) => {
    const [head, ...rest] = block.trim().split('\n');
    const m = head.match(/^\[([^\]]+)\]\s*(.*)$/);
    return m ? { group: m[1], name: m[2], text: rest.join('\n') + '\n' } : null;
  }).filter((x) => x && x.text.trim());
  try { state.data.snippets = await api.saveSnippets(items); renderSnippets(); toast(`${items.length} Bausteine gespeichert`); } catch (e) { toast(e.message); }
}

function toggleSnippets() {
  const s = $('#snippets');
  s.hidden = !s.hidden;
  if (!s.hidden) { renderSnippetTarget(); $('#snippet-search').focus(); }
  const t = activeTab();
  if (t) layout(t);
}

// ---------- TFTP ----------
async function tftpDialog() {
  try { state.tftp = await api.tftpStatus(); } catch (e) { toast(e.message); return; }
  const cfg = { root: state.tftp.root || '', port: state.tftp.port || 69, allowWrite: Boolean(state.tftp.allowWrite) };
  const body = el('div', { class: 'body' });
  const events = el('div', { class: 'events', 'aria-live': 'polite' });
  const drawEvents = () => {
    const list = state.tftp.events || [];
    events.replaceChildren(...(list.length ? list.slice().reverse().map((e) => el('div', { class: e.kind }, `${new Date(e.ts).toTimeString().slice(0, 8)}  ${e.text}`)) : [el('span', { class: 'muted' }, 'Noch keine Übertragung.')]));
  };
  const copy = (t) => navigator.clipboard.writeText(t).then(() => toast('Kopiert'));
  const draw = () => {
    const on = state.tftp.running;
    const ip = state.tftp.addresses[0] ? state.tftp.addresses[0].address : '<IP dieses Macs>';
    const portSuffix = cfg.port !== 69 ? `:${cfg.port}` : '';
    const examples = [
      `copy tftp://${ip}${portSuffix}/<Datei> flash:`,
      ...(cfg.allowWrite ? [`copy running-config tftp://${ip}${portSuffix}/<hostname>-confg.txt`] : []),
    ];
    body.replaceChildren(
      el('p', { class: on ? 'infobox' : 'muted small' }, on
        ? `Läuft auf Port ${state.tftp.port} – ${state.tftp.allowWrite ? 'Geräte können laden und hochladen' : 'Geräte können nur laden'}. Jeder im Netz kann den Ordner lesen, solange der Server läuft.`
        : 'Gibt einen Ordner per TFTP frei, z. B. für Images oder Configs. Standard: nur lesen. Hochladen (Gerät → Mac) nur mit Häkchen; vorhandene Dateien werden nie überschrieben.'),
      el('div', { class: 'row3' },
        field('Ordner', el('div', { style: 'display:flex;gap:6px' },
          el('input', { value: cfg.root, disabled: on, spellcheck: 'false', oninput: (e) => { cfg.root = e.target.value; } }),
          el('button', { disabled: on, onclick: async () => { const d = await api.tftpPick(); if (d) { cfg.root = d; draw(); } } }, 'Wählen …'))),
        field('Port', el('input', { type: 'number', min: 1, max: 65535, value: cfg.port, disabled: on, oninput: (e) => { cfg.port = Number(e.target.value); } })),
        el('div', { style: 'display:flex;align-items:end' }, on ? el('button', { class: 'danger', style: 'width:100%', onclick: stop }, 'Stoppen') : el('button', { class: 'primary', style: 'width:100%', onclick: startSrv }, 'Starten'))),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: cfg.allowWrite, disabled: on, onchange: (e) => { cfg.allowWrite = e.target.checked; draw(); } }), 'Hochladen erlauben (Gerät → Mac, z. B. „copy running-config tftp:“)'),
      el('div', {}, el('div', { class: 'section-head', style: 'margin-bottom:6px' }, el('span', {}, 'Adressen dieses Macs'), el('button', { class: 'link', disabled: !cfg.root, onclick: () => api.tftpReveal() }, 'Ordner im Finder')),
        el('div', { class: 'addr' }, state.tftp.addresses.length ? state.tftp.addresses.map((a) => el('button', { title: `${a.name} – kopieren`, onclick: () => copy(a.address) }, `${a.address}  ${a.name}`)) : el('span', { class: 'muted small' }, 'Keine Netzwerkadresse gefunden.'))),
      el('div', { style: 'display:grid;gap:6px' }, el('div', { class: 'section-head' }, el('span', {}, 'Befehle am Switch')),
        examples.map((x) => el('div', { class: 'cmdline' }, el('code', {}, x), el('button', { onclick: () => copy(x) }, 'Kopieren')))),
      el('div', { style: 'display:grid;gap:6px' }, el('div', { class: 'section-head' }, el('span', {}, 'Übertragungen')), events));
    drawEvents();
  };
  async function startSrv() {
    try { state.tftp = await api.tftpStart(cfg); toast('TFTP-Server läuft'); } catch (e) { toast(e.message); }
    renderTftpDot(); draw();
  }
  async function stop() {
    try { state.tftp = await api.tftpStop(); toast('TFTP-Server gestoppt'); } catch (e) { toast(e.message); }
    renderTftpDot(); draw();
  }
  const off = api.onTftp((e) => { state.tftp.events = [...(state.tftp.events || []), e].slice(-80); drawEvents(); });
  draw();
  await modal('TFTP-Server', body, [{ label: 'Schließen', value: null, cls: 'primary' }], { wide: true, onClose: off });
}

function renderTftpDot() {
  $('#tftp-dot').classList.toggle('on', Boolean(state.tftp.running));
  $('#btn-tftp').title = state.tftp.running ? `TFTP-Server läuft (Port ${state.tftp.port})` : 'TFTP-Server (⌘⇧T)';
}

// ---------- Einstellungen ----------
async function settingsDialog() {
  const set = { ...state.data.settings };
  const body = el('div', { class: 'body' });
  const tabs = el('div', { class: 'tabs2' });
  let page = 'general';
  const draw = async () => {
    tabs.replaceChildren(...[['general', 'Allgemein'], ['rules', 'Hervorhebung'], ['hosts', 'Host-Schlüssel'], ['import', 'Import']].map(([k, l]) => el('button', { class: page === k ? 'on' : '', onclick: () => { page = k; draw(); } }, l)));
    if (page === 'general') {
      body.replaceChildren(
        el('div', { class: 'row' },
          field('Schriftgröße', el('input', { type: 'number', min: 9, max: 28, value: set.fontSize, oninput: (e) => { set.fontSize = Number(e.target.value); } })),
          field('Darstellung', el('select', { onchange: (e) => { set.theme = e.target.value; } }, [['auto', 'Wie macOS'], ['dark', 'Dunkel'], ['light', 'Hell']].map(([v, l]) => el('option', { value: v, selected: set.theme === v }, l))))),
        el('div', { class: 'row' },
          field('Zeilen im Verlauf', el('input', { type: 'number', min: 1000, max: 200000, step: 1000, value: set.scrollback || 10000, oninput: (e) => { set.scrollback = Number(e.target.value); } })),
          field('Ordner für Aufzeichnungen (leer = ~/Documents/Cable Logs)', el('input', { value: set.logDir || '', oninput: (e) => { set.logDir = e.target.value; } }))),
        el('p', { class: 'muted small' }, state.data.canStoreSecrets ? 'Passwörter werden verschlüsselt über den macOS-Schlüsselbund gespeichert – nur wenn du es je Profil einschaltest.' : 'Schlüsselbund nicht verfügbar: Passwörter werden nicht gespeichert.'),
        el('button', { onclick: () => api.openLogs() }, 'Ordner mit Aufzeichnungen öffnen'));
    } else if (page === 'rules') {
      const ta = el('textarea', { rows: 12 }, state.data.rules.map((r) => `${r.color}: ${r.pattern}`).join('\n'));
      body.replaceChildren(el('p', { class: 'muted small' }, 'Je Zeile „farbe: Regex“. Farben: red, green, yellow, blue, magenta, cyan, white, orange, auch bright-… (z. B. bright-cyan); dazu +bold und/oder +underline, z. B. „orange+bold“. Groß/Klein egal; bei Überschneidung gewinnt die obere Zeile. Gilt für Profile mit „Ausgabe hervorheben“.'), ta,
        el('button', { onclick: async () => {
          const items = ta.value.split('\n').map((l) => l.match(/^\s*([\w+-]+)\s*:\s*(.+)$/)).filter(Boolean).map((m) => ({ color: m[1], pattern: m[2].trim() }));
          try { const r = await api.saveRules(items); state.data.rules = r.rules; toast(r.errors.length ? `Gespeichert, ${r.errors.length} ungültige Muster übersprungen` : 'Regeln gespeichert'); } catch (e) { toast(e.message); }
        } }, 'Regeln speichern'));
    } else if (page === 'hosts') {
      const keys = await api.hostKeys();
      body.replaceChildren(Object.keys(keys).length ? el('table', { class: 'list' }, Object.entries(keys).map(([id, k]) => el('tr', {},
        el('td', {}, id), el('td', { class: 'mono' }, `${k.type} ${k.fingerprint}`), el('td', {}, el('button', { class: 'link', onclick: async () => {
          const i = id.lastIndexOf(':'); await api.forgetHostKey(id.slice(0, i), Number(id.slice(i + 1))); draw();
        } }, 'Vergessen'))))) : el('p', { class: 'muted' }, 'Noch keine Host-Schlüssel gemerkt.'));
    } else {
      body.replaceChildren(
        el('p', {}, 'Profile übernehmen (Passwörter werden nie importiert):'),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          el('button', { onclick: () => importSsh() }, 'Aus ~/.ssh/config'),
          el('button', { onclick: () => importPutty() }, 'PuTTY-Export (.reg) …')),
        el('p', { class: 'muted small' }, 'PuTTY unter Windows exportieren: regedit → HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions → Rechtsklick → Exportieren. Datei auf den Mac kopieren.'));
    }
  };
  const wrap = el('div', {}, tabs, body);
  await draw();
  await modal('Einstellungen', wrap, [{ label: 'Schließen', value: null }, { label: 'Übernehmen', cls: 'primary', action: async () => {
    try { state.data.settings = await api.saveSettings(set); applyTheme(); toast('Gespeichert'); } catch (e) { toast(e.message); }
  } }], { wide: true });
}

async function importSsh() {
  try { const n = await api.importSshConfig(); await reload(); toast(`${n} Profil(e) aus ~/.ssh/config übernommen`); } catch (e) { toast(e.message); }
}
async function importPutty() {
  try { const n = await api.importPutty(); await reload(); toast(`${n} PuTTY-Sitzung(en) übernommen`); } catch (e) { toast(e.message); }
}

async function importStaging() {
  try {
    const cfg = await api.importStaging();
    if (!cfg) return;
    await reload();
    toast(`${cfg.servers.length} Konsolenserver übernommen`);
  } catch (e) { toast(`staging.json: ${e.message}`); }
}

async function removeStaging() {
  if (!state.data.staging) { toast('Keine Staging-Konsolen eingerichtet'); return; }
  if (!(await confirmDialog('Staging-Konsolen entfernen?', 'Der Bereich „Staging“ verschwindet aus der Seitenleiste. Offene Verbindungen bleiben offen.', 'Entfernen'))) return;
  await api.removeStaging();
  await reload();
}

// ---------- Verbinden-Formular ----------
function quickValues() {
  const protocol = $('#q-proto').value;
  const host = $('#q-host').value.trim();
  const port = Number($('#q-port').value) || DEFAULT_PORT[protocol];
  const username = $('#q-user').value.trim();
  return { protocol, host, port, username, name: username ? `${username}@${host}` : host, password: $('#q-pass').value };
}

function quickConnect() {
  const v = quickValues();
  if (!v.host) { toast('IP-Adresse oder Host fehlt'); $('#q-host').focus(); return; }
  const { password, ...session } = v;
  connect({ ...session, draft: true }, { password: password || undefined });
  $('#q-pass').value = '';
}

function quickSave() {
  const v = quickValues();
  if (!v.host) { toast('IP-Adresse oder Host fehlt'); $('#q-host').focus(); return; }
  editSession(null, { ...v, auth: 'auto', forwards: [], highlight: true, keepalive: 30 });
}

// ---------- Befehle ----------
function split() {
  const p = focusedPane();
  const t = activeTab();
  if (!p || !t) { toast('Erst eine Sitzung öffnen'); return; }
  connect(p.session, { intoTab: t, password: p.connectOpts && p.connectOpts.password });
}

function find() {
  const p = focusedPane();
  if (!p) return;
  if (p.root.querySelector('.findbar')) { p.root.querySelector('.findbar input').focus(); return; }
  const inp = el('input', { placeholder: 'Suchen', spellcheck: 'false' });
  const go = (back) => (back ? p.search.findPrevious(inp.value) : p.search.findNext(inp.value));
  const bar = el('div', { class: 'findbar' }, inp, el('button', { onclick: () => go(true) }, '↑'), el('button', { onclick: () => go(false) }, '↓'), el('button', { class: 'icon', 'aria-label': 'Suche schließen', onclick: () => { bar.remove(); p.term.focus(); } }, '×'));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e.shiftKey); if (e.key === 'Escape') { bar.remove(); p.term.focus(); } });
  p.root.append(bar);
  inp.focus();
}

async function sendBreak() {
  const p = focusedPane();
  if (!p) return;
  try { await api.sendBreak(p.id); toast('Break gesendet'); } catch (e) { toast(e.message); }
}

function cycleTab(dir) {
  if (!state.tabs.length) return;
  const i = state.tabs.findIndex((t) => t.id === state.active);
  activate(state.tabs[(i + dir + state.tabs.length) % state.tabs.length].id);
}

function selectAll(on) {
  for (const p of panes.values()) p.target = on;
  if (on) state.multi.scope = 'selected';
  refreshAll();
}

function groupFromSelection() {
  const ids = [...new Set([...panes.values()].filter((p) => p.target && p.session.id && !p.session.draft).map((p) => p.session.id))];
  const drafts = [...panes.values()].filter((p) => p.target && (!p.session.id || p.session.draft)).length;
  if (!ids.length) { toast(drafts ? 'Nur Profile lassen sich gruppieren – Verbindungen erst „Als Profil …“ speichern' : 'Erst Sitzungen per Häkchen auswählen'); return; }
  editGroup(null, ids.slice(0, 50));
}

api.onMenu((cmd) => {
  const p = focusedPane();
  ({
    'new-session': () => editSession(),
    quick: () => $('#q-host').focus(),
    local: () => connect({ protocol: 'local', name: 'Shell', draft: true }),
    'close-tab': () => { const t = activeTab(); if (t) closeTab(t.id); },
    'close-pane': () => p && askClosePane(p),
    reconnect: () => p && reconnect(p),
    'import-ssh': importSsh,
    'import-putty': importPutty,
    'import-staging': importStaging,
    'remove-staging': removeStaging,
    'open-logs': () => api.openLogs(),
    split, broadcast: () => toggleMulti(), find, break: sendBreak,
    record: () => toggleRecord(), export: () => exportPane(),
    clear: () => p && p.term.clear(),
    'next-tab': () => cycleTab(1), 'prev-tab': () => cycleTab(-1),
    'view-grid': () => setLayout('grid'), 'view-cols': () => setLayout('cols'), 'view-rows': () => setLayout('rows'), 'view-focus': () => setLayout('focus'),
    'merge-tabs': mergeTabs,
    tftp: tftpDialog, snippets: toggleSnippets,
    'update-building': () => toast('Cable wird im Hintergrund neu gebaut – Sitzungen bleiben offen'),
    'font-up': () => { state.data.settings.fontSize = Math.min(28, state.data.settings.fontSize + 1); applyTheme(); api.saveSettings({ fontSize: state.data.settings.fontSize }); },
    'font-down': () => { state.data.settings.fontSize = Math.max(9, state.data.settings.fontSize - 1); applyTheme(); api.saveSettings({ fontSize: state.data.settings.fontSize }); },
    sidebar: () => { $('#app').classList.toggle('no-side'); const t = activeTab(); if (t) layout(t); },
  }[cmd] || (() => {}))();
});

api.onDraft(async (d) => {
  const what = d.protocol === 'serial' ? `${d.path} mit ${d.baudRate} Baud` : `${d.protocol.toUpperCase()} ${d.username ? d.username + '@' : ''}${d.host}:${d.port}`;
  if (await confirmDialog('Verbindung aus Link öffnen?', `Ein Link möchte ${what} öffnen.`, 'Verbinden')) connect({ ...d, draft: true });
});
api.onOpenSession(({ id }) => { const s = state.data.sessions.find((x) => x.id === id); if (s) connect(s); });

async function reload() {
  state.data = await api.getStore();
  renderTree();
  renderGroups();
  renderStaging();
  renderSnippets();
  applyTheme();
}

// ---------- Start ----------
if (api.platform === 'darwin') document.body.classList.add('mac');
$('#quick').addEventListener('submit', (e) => { e.preventDefault(); quickConnect(); });
$('#q-proto').addEventListener('change', () => { $('#q-port').value = DEFAULT_PORT[$('#q-proto').value]; });
$('#q-save').addEventListener('click', quickSave);
$('#search').addEventListener('input', renderTree);
$('#snippet-search').addEventListener('input', renderSnippets);
$('#btn-new').addEventListener('click', () => editSession());
$('#btn-local').addEventListener('click', () => connect({ protocol: 'local', name: 'Shell', draft: true }));
$('#btn-settings').addEventListener('click', settingsDialog);
$('#btn-serial-refresh').addEventListener('click', refreshSerial);
$('#btn-sel-all').addEventListener('click', () => selectAll(true));
$('#btn-sel-none').addEventListener('click', () => selectAll(false));
$('#btn-group-from-sel').addEventListener('click', groupFromSelection);
$('#btn-group-new').addEventListener('click', () => editGroup());
$('#staging-head').addEventListener('click', toggleStaging);
$('#staging-head').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleStaging(); } });
// Knöpfe in der Leiste nehmen dem Terminal nicht die Tastatur weg.
$('#tabbar .tools').addEventListener('mousedown', (e) => e.preventDefault());
$('#tabs-left').addEventListener('click', () => scrollTabs(-1));
$('#tabs-right').addEventListener('click', () => scrollTabs(1));
$('#tabs').addEventListener('scroll', updateTabArrows, { passive: true });
// Mausrad/Trackpad senkrecht scrollt die Tab-Leiste waagrecht.
$('#tabs').addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $('#tabs').scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });
window.addEventListener('resize', updateTabArrows);
$('#view-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setLayout(b.dataset.view); });
$('#btn-split').addEventListener('click', split);
$('#btn-broadcast').addEventListener('click', () => toggleMulti());
$('#btn-break').addEventListener('click', sendBreak);
$('#btn-snippets').addEventListener('click', toggleSnippets);
$('#btn-snippets-edit').addEventListener('click', editSnippets);
$('#btn-tftp').addEventListener('click', tftpDialog);
$('#scope-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.multi.scope = b.dataset.scope; refreshAll(); $('#mb-input').focus(); } });
$('#mb-input').addEventListener('keydown', multiBarKeys);
$('#mb-send').addEventListener('click', () => { const i = $('#mb-input'); sendLineToTargets(i.value); if (i.value.trim()) mbHistory.push(i.value); mbIndex = mbHistory.length; i.value = ''; i.focus(); });
$('#mb-rec').addEventListener('click', recordTargets);
$('#mb-off').addEventListener('click', () => toggleMulti(false));
$('#tree').addEventListener('keydown', (e) => {
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selected) {
    const s = state.data.sessions.find((x) => x.id === state.selected);
    if (s) editSession(s);
  }
});

reload().then(async () => {
  refreshSerial();
  renderTabs();
  try { state.tftp = await api.tftpStatus(); renderTftpDot(); } catch { /* egal */ }
  api.ready();
});
