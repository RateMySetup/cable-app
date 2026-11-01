'use strict';
// Staging-Konsolenserver (z. B. Perle, Opengear, Cisco-Terminalserver): nicht fest eingebaut, sondern
// optional aus `staging.json` im Datenordner. Ohne Datei bleibt der Bereich „Staging“ ausgeblendet.
// Jeder Server reicht `consoles` Konsolen per Telnet durch, `firstPort` = Konsole 1, `firstPort + 1` = Konsole 2 …
// Beispiel: docs/staging.example.json

const MAX_SERVERS = 50;
const MAX_CONSOLES = 64;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;

/** Prüft den Inhalt von staging.json; liefert die bereinigte Konfiguration oder wirft mit verständlicher Meldung. */
function parseStaging(raw) {
  const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.servers)) throw new Error('„servers“ fehlt (Liste mit name und host)');
  const firstPort = cfg.firstPort == null ? 10001 : Number(cfg.firstPort);
  const consoles = cfg.consoles == null ? 16 : Number(cfg.consoles);
  if (!Number.isInteger(firstPort) || firstPort < 1) throw new Error('„firstPort“ ungültig');
  if (!Number.isInteger(consoles) || consoles < 1 || consoles > MAX_CONSOLES) throw new Error(`„consoles“ muss 1–${MAX_CONSOLES} sein`);
  if (firstPort + consoles - 1 > 65535) throw new Error('Ports reichen über 65535');
  if (!cfg.servers.length || cfg.servers.length > MAX_SERVERS) throw new Error(`1–${MAX_SERVERS} Server erlaubt`);
  const servers = cfg.servers.map((s, i) => {
    const host = String((s && s.host) || '').trim();
    if (!HOST_RE.test(host)) throw new Error(`Server ${i + 1}: Host ungültig`);
    const name = String((s && s.name) || host).trim().slice(0, 40) || host;
    return { id: `srv-${host}`, name, host };
  });
  const title = String(cfg.title || 'Staging').trim().slice(0, 30) || 'Staging';
  return { title, firstPort, consoles, servers };
}

/** Telnet-Ports der Konsolen 1 … consoles. */
function stagingPorts(cfg) {
  return Array.from({ length: cfg.consoles }, (_, i) => cfg.firstPort + i);
}

/** Telnet-Sitzung (ohne Profil) für Konsole `nr` (1 … consoles) eines Servers. */
function stagingSession(cfg, server, nr) {
  if (!Number.isInteger(nr) || nr < 1 || nr > cfg.consoles) throw new Error('Konsole ungültig');
  return { protocol: 'telnet', name: `${server.name} · ${nr}`, host: server.host, port: cfg.firstPort + nr - 1, draft: true };
}

module.exports = { parseStaging, stagingPorts, stagingSession };
