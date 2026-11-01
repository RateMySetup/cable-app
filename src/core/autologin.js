'use strict';
// Anmeldung für Telnet und Konsolenkabel: Telnet kennt kein Login im Protokoll, Cisco fragt im Text nach
// „Username:“ und „Password:“. Gespeicherte Werte werden je einmal gesendet, danach ist Schluss – ein
// zweites „Password:“ (falsches Passwort, enable) bleibt dem Menschen.

const { stripAnsi } = require('./highlight');

const USER_PROMPT = /(?:user ?name|login)\s*:\s*$/i;
const PASS_PROMPT = /password\s*:\s*$/i;

class AutoLogin {
  /**
   * @param {{username?:string, password?:string|null}} creds
   * @param {(text:string)=>void} write
   * @param {number} [windowMs] nach dieser Zeit nichts mehr automatisch senden
   */
  constructor(creds, write, windowMs = 60000) {
    this.user = creds.username || '';
    this.pass = creds.password || '';
    this.write = write;
    this.tail = '';
    this.sentUser = !this.user;
    this.sentPass = !this.pass;
    this.until = Date.now() + windowMs;
  }

  get active() { return !(this.sentUser && this.sentPass) && Date.now() < this.until; }

  feed(text) {
    if (!this.active) return;
    this.tail = (this.tail + stripAnsi(String(text))).slice(-200);
    const line = this.tail.split(/\r?\n/).pop();
    if (!this.sentUser && USER_PROMPT.test(line)) { this.sentUser = true; this.tail = ''; this.write(this.user + '\r'); return; }
    if (!this.sentPass && PASS_PROMPT.test(line)) { this.sentPass = true; this.sentUser = true; this.tail = ''; this.write(this.pass + '\r'); }
  }
}

module.exports = { AutoLogin, USER_PROMPT, PASS_PROMPT };
