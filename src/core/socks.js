'use strict';
// Minimaler SOCKS5-Server (RFC 1928, nur CONNECT ohne Anmeldung) für dynamische Weiterleitung (-D).
// Lauscht nur auf 127.0.0.1. Ziel wird über den SSH-Tunnel geöffnet.

const net = require('node:net');

/**
 * Liest Begrüßung + Anfrage aus einem Puffer.
 * @returns {{need:true}|{error:string}|{host:string, port:number, consumed:number, greetingLen:number}}
 */
function parseRequest(buf) {
  if (buf.length < 2) return { need: true };
  if (buf[0] !== 5) return { error: 'kein SOCKS5' };
  const g = 2 + buf[1];
  if (buf.length < g) return { need: true };
  if (!buf.subarray(2, g).includes(0)) return { error: 'keine Methode ohne Anmeldung' };
  if (buf.length < g + 5) return { need: true };
  const [ver, cmd, , atyp] = buf.subarray(g, g + 4);
  if (ver !== 5) return { error: 'kein SOCKS5' };
  if (cmd !== 1) return { error: 'nur CONNECT' };
  let host, at = g + 4;
  if (atyp === 1) {
    if (buf.length < at + 6) return { need: true };
    host = Array.from(buf.subarray(at, at + 4)).join('.');
    at += 4;
  } else if (atyp === 3) {
    const len = buf[at];
    if (buf.length < at + 1 + len + 2) return { need: true };
    host = buf.subarray(at + 1, at + 1 + len).toString('ascii');
    at += 1 + len;
  } else if (atyp === 4) {
    if (buf.length < at + 18) return { need: true };
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(at + i).toString(16));
    host = parts.join(':');
    at += 16;
  } else return { error: 'Adressart unbekannt' };
  return { host, port: buf.readUInt16BE(at), consumed: at + 2, greetingLen: g };
}

const REPLY_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
const REPLY_FAIL = Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]);

/**
 * @param {number} port lokaler Port
 * @param {(host:string, port:number) => Promise<import('stream').Duplex>} open Ziel über SSH öffnen
 */
function createSocksServer(port, open) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let greeted = false;
    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 600) return sock.destroy();
      const r = parseRequest(buf);
      if (r.need) {
        if (!greeted && buf.length >= 2 && buf.length >= 2 + buf[1]) { sock.write(Buffer.from([5, 0])); greeted = true; }
        return;
      }
      sock.off('data', onData);
      if (r.error) return sock.end(Buffer.from([5, 0xff]));
      if (!greeted) sock.write(Buffer.from([5, 0]));
      const rest = buf.subarray(r.consumed);
      try {
        const stream = await open(r.host, r.port);
        sock.write(REPLY_OK);
        if (rest.length) stream.write(rest);
        sock.pipe(stream).pipe(sock);
        stream.on('error', () => sock.destroy());
        sock.on('error', () => stream.destroy());
      } catch {
        sock.end(REPLY_FAIL);
      }
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  });
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { parseRequest, createSocksServer };
