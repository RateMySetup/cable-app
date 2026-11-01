'use strict';
// Links „cable://…“, z. B. aus einer Geräteliste im Browser (das alte „kabel://“ aus 0.1 geht weiter):
//   cable://ssh/admin@10.0.0.1:22   cable://telnet/10.0.0.1:2001   cable://raw/10.0.0.1:9100
//   cable://serial/cu.usbserial-1410?baud=9600   cable://session/Core-Switch
// Links kommen von außen: streng prüfen, nie etwas ausführen, nur eine Verbindung vorschlagen.

const HOST = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)*$|^(?:\d{1,3}\.){3}\d{1,3}$|^\[[0-9a-fA-F:]+\]$/;
const USER = /^[a-zA-Z0-9._-]{1,64}$/;
const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** @returns {object|null} Sitzungs-Entwurf oder null bei ungültigem Link */
function parseCableUrl(input) {
  let u;
  try { u = new URL(String(input)); } catch { return null; }
  if (u.protocol !== 'cable:' && u.protocol !== 'kabel:') return null;
  const kind = u.hostname.toLowerCase();
  const rest = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  if (rest.length > 200) return null;
  if (kind === 'session') return rest ? { open: rest } : null;
  if (kind === 'serial') {
    if (!/^(?:tty|cu)\.[A-Za-z0-9._-]{1,80}$/.test(rest)) return null;
    const baud = Number(u.searchParams.get('baud') || 9600);
    if (!BAUDS.includes(baud)) return null;
    return { protocol: 'serial', name: rest, path: `/dev/${rest}`, baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none' };
  }
  if (!['ssh', 'telnet', 'raw'].includes(kind)) return null;
  const m = rest.match(/^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const [, user, host, port] = m;
  if (!HOST.test(host) || (user && !USER.test(user))) return null;
  const p = port ? Number(port) : { ssh: 22, telnet: 23, raw: 23 }[kind];
  if (p < 1 || p > 65535) return null;
  const s = { protocol: kind, name: host, host: host.replace(/^\[|\]$/g, ''), port: p };
  if (user) s.username = user;
  return s;
}

/** Schnellverbindung „user@host:port“, „telnet host 2001“, „/dev/cu.usbserial 9600“. */
function parseQuick(text) {
  const t = String(text).trim();
  let m = t.match(/^(ssh|telnet|raw)\s+(\S+)(?:\s+(\d{1,5}))?$/i);
  if (m) return parseCableUrl(`cable://${m[1].toLowerCase()}/${m[2]}${m[3] ? ':' + m[3] : ''}`);
  m = t.match(/^\/dev\/((?:tty|cu)\.\S+)(?:\s+(\d+))?$/);
  if (m) return parseCableUrl(`cable://serial/${m[1]}${m[2] ? '?baud=' + m[2] : ''}`);
  if (/^[^\s/]+$/.test(t)) return parseCableUrl(`cable://ssh/${t}`);
  return null;
}

module.exports = { parseCableUrl, parseQuick, BAUDS };
