'use strict';
// Hervorhebung in der Terminal-Ausgabe: färbt Treffer (z. B. „down“, „err-disabled“, „% Invalid“) mit
// ANSI-Farben ein. Escape-Sequenzen des Servers bleiben unangetastet, damit Programme wie vim oder
// Menüs nicht kaputtgehen. Gegen zerteilte Treffer hält main.js angefangene Wörter kurz zurück (splitTail).

// Farbe je Regel: Name, optional mit „+bold“ und/oder „+underline“, z. B. „bright-cyan+bold“.
const COLORS = {
  red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36', white: '37',
  'bright-red': '91', 'bright-green': '92', 'bright-yellow': '93', 'bright-blue': '94',
  'bright-magenta': '95', 'bright-cyan': '96', 'bright-white': '97', orange: '38;5;208',
};
const STYLES = { bold: '1', underline: '4' };
const RESET = '\x1b[22;24;39m';

/** „bright-cyan+bold“ → SGR-Parameter „96;1“, ungültig → null. */
function sgr(spec) {
  if (typeof spec !== 'string') return null;
  const [name, ...mods] = spec.trim().toLowerCase().split('+');
  if (!COLORS[name] || mods.some((m) => !STYLES[m])) return null;
  return [COLORS[name], ...mods.map((m) => STYLES[m])].join(';');
}

// Werte hinter einer Beschriftung, z. B. „SN: FOC1234X0AB“ oder „PID: WS-C3850-48P“. Der Wert muss
// eine Ziffer enthalten, damit „Serial Number : …“ nicht das Wort „Number“ färbt.
const LABEL_SERIAL = '(?:SN|S/N|Serial(?:\\s?(?:Number|No\\.?|#))?|System serial number|Processor board ID|Chassis Serial Number)';
const LABEL_MODEL = '(?:PID|Model(?:\\s?(?:Number|No\\.?))?|Product ID)';
const VALUE = '(?=[A-Z/+.-]*\\d)[A-Z0-9][A-Z0-9/+.-]*[A-Z0-9]';

/** Standardregeln für Netzwerkgeräte (Cisco IOS/NX-OS, Meraki, Linux). Bei Überlappung gewinnt die erste. */
const DEFAULT_RULES = [
  // Seriennummern: beschriftet, Meraki (Q2XX-XXXX-XXXX), Cisco (3 Buchstaben, 4 Ziffern Jahr/Woche, 4 Zeichen)
  { pattern: `(?<=\\b${LABEL_SERIAL}(?:\\s*[:#=]\\s*|\\s+))${VALUE}`, color: 'orange+bold' },
  { pattern: '\\bQ[0-9A-Z]{3}-[0-9A-Z]{4}-[0-9A-Z]{4}\\b', color: 'orange+bold' },
  { pattern: '\\b[A-Z]{3}\\d{4}[A-Z0-9]{4}\\b', color: 'orange+bold' },
  // Hardwaremodelle: beschriftet, Cisco-Familien, Meraki
  { pattern: `(?<=\\b${LABEL_MODEL}\\s*[:#=]\\s*)${VALUE}`, color: 'bright-blue+bold' },
  { pattern: '\\b(?:WS-C|N\\dK-|AIR-|GLC-|Q?SFP-|PWR-|C\\dKX-|IE-)[A-Z0-9][A-Z0-9/+-]*[A-Z0-9]|\\b(?:C9|C8|C1|ISR|ASR|ASA|FPR|CBS|CISCO|ISA|IR)\\d{3,}[A-Z0-9/+-]*[A-Z0-9]', color: 'bright-blue+bold' },
  { pattern: '\\b(?:MR|MS|MX|MV|MG|MT|CW)\\d{2,4}[A-Z]{0,3}(?:-[A-Z0-9]{1,5})*\\b', color: 'bright-blue+bold' },
  // Adressen: IPv4 (mit Präfix), MAC, IPv6
  { pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:/\\d{1,2})?\\b', color: 'bright-cyan+bold' },
  { pattern: '\\b(?:[0-9a-fA-F]{4}\\.){2}[0-9a-fA-F]{4}\\b|\\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\\b', color: 'magenta' },
  { pattern: '\\b(?:[0-9A-F]{1,4}:){7}[0-9A-F]{1,4}\\b|\\b(?:[0-9A-F]{1,4}:){1,6}:(?:[0-9A-F]{1,4}(?::[0-9A-F]{1,4})*)?(?:/\\d{1,3})?', color: 'bright-cyan+bold' },
  // Zustände
  { pattern: '\\b(err-disabled|administratively down|down|failed|failure|error|errors|denied|refused|timeout|unreachable|CRITICAL)\\b|%[A-Z0-9_-]+-[0-3]-[A-Z0-9_]+\\b', color: 'red' },
  { pattern: '(?<=^|[\\r\\n])% ?(Invalid|Incomplete|Ambiguous|Unknown)[^\\r\\n]*', color: 'red' },
  { pattern: '\\b(warning|warn|flapping|notconnect|disabled)\\b|%[A-Z0-9_-]+-4-[A-Z0-9_]+\\b', color: 'yellow' },
  { pattern: '\\b(up|connected|established|success|ok|FULL)\\b', color: 'green' },
];

// Standardregeln von 0.1.0: unverändert gespeicherte werden beim Start durch die neuen ersetzt.
const RULES_V1 = [
  "\\b(err-disabled|administratively down|down|failed|failure|error|errors|denied|refused|timeout|unreachable|CRITICAL|%[A-Z0-9_-]+-[0-3]-[A-Z0-9_]+)\\b",
  "^% ?(Invalid|Incomplete|Ambiguous|Unknown)[^\\r\\n]*",
  "\\b(warning|warn|flapping|notconnect|disabled|%[A-Z0-9_-]+-[4]-[A-Z0-9_]+)\\b",
  "\\b(up|connected|established|success|ok|FULL)\\b",
  "\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:/\\d{1,2})?\\b",
  "\\b(?:[0-9a-fA-F]{4}\\.){2}[0-9a-fA-F]{4}\\b|\\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\\b",
];

/**
 * Gespeicherte Regeln auf den aktuellen Stand bringen: alte Standardregeln ersetzen, eigene Regeln
 * behalten (nach den Standardregeln, Reihenfolge wie bisher).
 */
function migrateRules(stored) {
  if (!Array.isArray(stored)) return DEFAULT_RULES;
  const own = stored.filter((r) => r && !RULES_V1.includes(r.pattern) && !DEFAULT_RULES.some((d) => d.pattern === r.pattern));
  return [...DEFAULT_RULES, ...own];
}

/** Regeln prüfen und kompilieren; ungültige Muster werden übersprungen (Rückgabe enthält Fehler). */
function compile(rules) {
  const ok = [];
  const errors = [];
  for (const r of rules || []) {
    const code = r && sgr(r.color);
    if (!code || typeof r.pattern !== 'string' || r.pattern.length > 500) {
      errors.push(r && r.pattern);
      continue;
    }
    try {
      const flags = 'g' + (/^[imsu]*$/.test(r.flags || '') ? r.flags || '' : '');
      ok.push({ re: new RegExp(r.pattern, flags.includes('i') ? flags : flags + 'i'), code });
    } catch {
      errors.push(r.pattern);
    }
  }
  return { rules: ok, errors };
}

// Steuersequenzen: CSI (ESC [ … Buchstabe), OSC (ESC ] … BEL/ST), andere ESC + 1 Zeichen.
const ESC_SEQ = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/**
 * Färbt Text außerhalb von Escape-Sequenzen. Sind im Abschnitt schon Farben gesetzt (SGR), bleibt der
 * Abschnitt unverändert – das Gerät färbt dann selbst.
 */
function apply(text, compiled) {
  if (!compiled.rules.length || !text) return text;
  if (/\x1b\[[0-9;]*m/.test(text)) return text;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(ESC_SEQ)) {
    out += colorPlain(text.slice(last, m.index), compiled) + m[0];
    last = m.index + m[0].length;
  }
  return out + colorPlain(text.slice(last), compiled);
}

function colorPlain(s, compiled) {
  if (!s) return s;
  // Treffer sammeln, Überlappungen: erste Regel gewinnt.
  const marks = [];
  for (const { re, code } of compiled.rules) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      if (!m[0]) continue;
      const a = m.index, b = m.index + m[0].length;
      if (!marks.some((x) => a < x.b && b > x.a)) marks.push({ a, b, code });
    }
  }
  if (!marks.length) return s;
  marks.sort((x, y) => x.a - y.a);
  let out = '';
  let pos = 0;
  for (const { a, b, code } of marks) {
    out += s.slice(pos, a) + `\x1b[${code}m` + s.slice(a, b) + RESET;
    pos = b;
  }
  return out + s.slice(pos);
}

/**
 * Text bis zum letzten Leerzeichen/Zeilenende sofort ausgeben, das angefangene Wort am Ende zurückhalten.
 * Konsolenkabel liefern oft nur wenige Zeichen je Paket; so wird eine IP oder Seriennummer nicht zerteilt
 * und bleibt färbbar. Escape-Sequenzen und lange Reste werden nie zurückgehalten.
 */
function splitTail(text) {
  const i = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n'), text.lastIndexOf('\r'), text.lastIndexOf('\t'));
  const tail = text.slice(i + 1);
  if (!tail || tail.length > 64 || tail.includes('\x1b')) return [text, ''];
  return [text.slice(0, i + 1), tail];
}

/** ANSI-Sequenzen entfernen (für Protokolldateien). */
function stripAnsi(s) {
  return s.replace(ESC_SEQ, '').replace(/\r\n?/g, (m) => (m.length === 2 ? '\n' : ''));
}

module.exports = { DEFAULT_RULES, COLORS, sgr, migrateRules, compile, apply, splitTail, stripAnsi };
