'use strict';
// Minimaler Telnet-Client (RFC 854) über TCP: verhandelt Echo, Suppress-Go-Ahead, Terminaltyp und
// Fenstergröße (NAWS), lehnt alles andere ab. Reicht für Cisco IOS, Konsolenserver und Router.

const net = require('node:net');
const { EventEmitter } = require('node:events');

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const ECHO = 1, SGA = 3, TTYPE = 24, NAWS = 31;

/**
 * Zerlegt eingehende Bytes in Nutzdaten und Telnet-Befehle. Zustand bleibt zwischen Paketen erhalten,
 * weil ein IAC-Befehl auf zwei TCP-Pakete verteilt ankommen kann.
 */
class TelnetParser {
  constructor() {
    this.state = 'data';
    this.verb = 0;
    this.sb = [];
  }

  /** @returns {{data: Buffer, commands: Array<{verb:number, option:number}|{sb:number[]}>}} */
  feed(buf) {
    const out = [];
    const commands = [];
    for (const b of buf) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac';
          else out.push(b);
          break;
        case 'iac':
          if (b === IAC) { out.push(IAC); this.state = 'data'; }
          else if (b === DO || b === DONT || b === WILL || b === WONT) { this.verb = b; this.state = 'opt'; }
          else if (b === SB) { this.sb = []; this.state = 'sb'; }
          else this.state = 'data'; // NOP, GA, AYT … ignorieren
          break;
        case 'opt':
          commands.push({ verb: this.verb, option: b });
          this.state = 'data';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sb-iac';
          else if (this.sb.length < 512) this.sb.push(b);
          break;
        case 'sb-iac':
          if (b === SE) { commands.push({ sb: this.sb }); this.state = 'data'; }
          else { if (b === IAC && this.sb.length < 512) this.sb.push(IAC); this.state = 'sb'; }
          break;
      }
    }
    return { data: Buffer.from(out), commands };
  }
}

/** Antwort auf DO/DONT/WILL/WONT. Gibt die zu sendenden Bytes zurück. */
function negotiate(cmd, { cols, rows, term }) {
  const { verb, option } = cmd;
  if (verb === DO) {
    if (option === NAWS) return Buffer.concat([Buffer.from([IAC, WILL, NAWS]), naws(cols, rows)]);
    if (option === TTYPE || option === SGA) return Buffer.from([IAC, WILL, option]);
    return Buffer.from([IAC, WONT, option]);
  }
  if (verb === WILL) {
    if (option === ECHO || option === SGA) return Buffer.from([IAC, DO, option]);
    return Buffer.from([IAC, DONT, option]);
  }
  if (verb === DONT) return Buffer.from([IAC, WONT, option]);
  if (verb === WONT) return Buffer.from([IAC, DONT, option]);
  void term;
  return Buffer.alloc(0);
}

/** Subnegotiation „TERMINAL-TYPE SEND“ → „IS xterm-256color“. */
function subnegotiate(sb, { term }) {
  if (sb[0] === TTYPE && sb[1] === 1) {
    return Buffer.concat([Buffer.from([IAC, SB, TTYPE, 0]), Buffer.from(term, 'ascii'), Buffer.from([IAC, SE])]);
  }
  return Buffer.alloc(0);
}

function naws(cols, rows) {
  const v = [Math.min(cols, 65535) >> 8, cols & 255, Math.min(rows, 65535) >> 8, rows & 255]
    .flatMap((x) => (x === IAC ? [IAC, IAC] : [x]));
  return Buffer.from([IAC, SB, NAWS, ...v, IAC, SE]);
}

/** IAC in Nutzdaten verdoppeln (Byte 255 ist sonst ein Befehl). */
function escapeOut(buf) {
  if (!buf.includes(IAC)) return buf;
  const out = [];
  for (const b of buf) { out.push(b); if (b === IAC) out.push(IAC); }
  return Buffer.from(out);
}

class TelnetConnection extends EventEmitter {
  constructor({ host, port = 23, cols = 80, rows = 24, term = 'xterm-256color', timeoutMs = 10000 }) {
    super();
    this.opts = { cols, rows, term };
    this.parser = new TelnetParser();
    this.nawsOn = false;
    this.socket = net.connect({ host, port });
    this.socket.setTimeout(timeoutMs, () => {
      if (!this.ready) this.socket.destroy(new Error(`Zeitüberschreitung bei ${host}:${port}`));
    });
    this.socket.on('connect', () => { this.ready = true; this.socket.setTimeout(0); this.emit('ready'); });
    this.socket.on('data', (buf) => {
      const { data, commands } = this.parser.feed(buf);
      for (const c of commands) {
        const reply = c.sb ? subnegotiate(c.sb, this.opts) : negotiate(c, this.opts);
        if (c.verb === DO && c.option === NAWS) this.nawsOn = true;
        if (reply.length) this.socket.write(reply);
      }
      if (data.length) this.emit('data', data);
    });
    this.socket.on('error', (e) => this.emit('error', e));
    this.socket.on('close', () => this.emit('close'));
  }

  write(data) { this.socket.write(escapeOut(Buffer.from(data))); }

  resize(cols, rows) {
    this.opts.cols = cols; this.opts.rows = rows;
    if (this.nawsOn && this.ready) this.socket.write(naws(cols, rows));
  }

  /** Telnet-„Break“ (IAC BRK), z. B. für Konsolenserver. */
  sendBreak() { this.socket.write(Buffer.from([IAC, 243])); }

  close() { this.socket.end(); this.socket.destroy(); }
}

module.exports = { TelnetParser, TelnetConnection, negotiate, subnegotiate, naws, escapeOut, IAC, DO, DONT, WILL, WONT, SB, SE, NAWS, TTYPE, ECHO, SGA };
