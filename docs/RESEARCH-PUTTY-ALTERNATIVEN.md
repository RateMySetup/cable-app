# PuTTY und Alternativen für macOS – Funktionsvergleich

Stand 19.10.2026. Recherche in drei Durchgängen: (1) Übersichtsartikel und Listen, (2) Herstellerseiten
und Repos, (3) Einzelfragen zu Serial-Konsole, Preisen und PuTTY-Versionen. Preise und Funktionen ändern
sich – vor einem Kauf auf der Herstellerseite prüfen. Bewertungsblogs sind oft Affiliate-getrieben;
maßgeblich sind die Herstellerangaben.

## 1. Was PuTTY kann (Referenz)

PuTTY (Simon Tatham, MIT-Lizenz, frei) ist Terminal-Emulator, Serial-Konsole und Dateiübertragung:

- Protokolle: SSH (1/2), Telnet, rlogin, Raw (TCP-Socket), Serial (COM/USB-Serial), SUPDUP.
- Portweiterleitung lokal, remote, dynamisch (SOCKS) und X11.
- Zusatzwerkzeuge: Pageant (SSH-Agent), PuTTYgen (Schlüssel), PSCP/PSFTP (Datei), Plink (Kommandozeile).
- Gespeicherte Sitzungen, Logging, Zeichensätze, Tastatur-/Farbeinstellungen.
- 0.83 (02/2025) brachte ML-KEM (Post-Quanten-Schlüsseltausch); Mirrors nennen 0.84/0.85 (2026).
- macOS: kein offizielles natives Programm. `brew install putty` bzw. MacPorts liefern die GTK-Version
  (läuft, wirkt aber fremd, braucht GTK/XQuartz-Bibliotheken).

Schwächen aus heutiger Sicht: keine Tabs/Split-Fenster, kein Sitzungsbaum mit Suche, keine
Befehlsbausteine, kein „an alle senden“, keine Hervorhebung, keine SFTP-Ansicht, Passwörter nicht
gespeichert (gut für Sicherheit, umständlich im Alltag), Einstellungen in der Windows-Registry.

## 2. Kandidaten auf dem Mac

| App | Lizenz / Preis | SSH | Telnet | Serial | Raw/rlogin | SFTP | Tunnel | Besonders |
|---|---|---|---|---|---|---|---|---|
| **PuTTY (GTK)** | frei, MIT | ✔ | ✔ | ✔ | ✔/✔ | PSFTP (CLI) | ✔ inkl. SOCKS | Referenz, aber kein Mac-Look |
| **Terminal.app + OpenSSH** | in macOS | ✔ | – (nachinstallierbar) | `screen` | `nc` | `sftp` CLI | ✔ `-L/-R/-D` | null Kosten, alles per Kommandozeile |
| **iTerm2** | frei, GPL | über `ssh` | über `telnet` | über `screen`/`picocom` | über `nc` | – | über `ssh` | Split-Panes, Hotkey-Fenster, Trigger/Hervorhebung, Profile; Terminal, kein Verbindungsmanager |
| **Termius** | Starter frei; Pro 10 $/Monat; Team 20 $; Business 30 $ | ✔ | ✔ | ✔ (Pro) | – | ✔ | ✔ | Sync über alle Geräte inkl. iOS/Android, Snippets, Vault, KI-Autovervollständigung |
| **SecureCRT** (VanDyke) | kommerziell, 30 Tage Test | ✔ SSH1/2 | ✔ | ✔ | Raw ✔ | SFTP-Tab, X/Y/Zmodem, Kermit, TFTP-Server | ✔ inkl. SOCKS | Sitzungsordner, Button-Bar, Befehlsfenster an alle/Gruppen, Schlüsselwort-Hervorhebung (Regex), Python-Skripte, Log-Rotation – Standard bei Netzwerkern |
| **ZOC Terminal** (EmTec) | kommerziell, 30 Tage Test | ✔ (OpenSSH 9.3) | ✔ | ✔ + Modem | rlogin ✔ | SCP/SFTP/FTP(S), X/Y/Zmodem, Kermit | ✔ | Adressbuch mit Farben, Skriptsprache mit 200+ Befehlen, Makrorekorder, TN3270/5250, nativ Intel/ARM |
| **Royal TSX** | Lite frei (10 Verbindungen); Single User 49 € einmalig | ✔ | ✔ | – (nicht genannt) | – | ✔ (FTP/SFTP/SCP) | ✔ SSH-Tunnel | RDP, VNC, Web, Credentials (1Password/KeePass), teilbare Dokumente – Verbindungsmanager für alles |
| **Tabby** | frei, MIT | ✔ | ✔ | ✔ (Hex, Auto-Reconnect) | – | Zmodem (SFTP v. a. Web-Version) | ✔ inkl. X11, Jump-Host | Split-Panes, verschlüsselter Vault, Plugins, Sync per Plugin (Gist) |
| **WindTerm** | frei (Apache-2.0) | ✔ | ✔ | ✔ | Raw ✔ | ✔ integriert | Proxy/Jump | Schnell, wenig Speicher, Sitzungsbaum, Layout-Wiederherstellung; Entwicklung zuletzt langsam (2.7 Pre 2025) |
| **electerm** | frei, MIT | ✔ | ✔ | ✔ | – | ✔ + FTP | ✔ | dazu RDP/VNC/Spice, Remote-Dateien direkt bearbeiten, Lesezeichen-Sync per Gist |
| **CoolTerm / Serial / minicom / picocom** | frei bzw. Serial kommerziell | – | – | ✔ | – | – | – | Reine Serial-Werkzeuge (Hex, Logging); `picocom -b 9600 /dev/cu.usbserial-*` |

## 3. Wer wo besser ist

- **Serial-Konsole (Cisco, Meraki, Switche):** SecureCRT und ZOC am vollständigsten (Logging, Skripte,
  Zmodem). Kostenlos: Tabby, WindTerm, electerm, picocom/screen. Royal TSX hat keinen Serial-Typ.
  Termius erst im Pro-Abo.
- **Viele Geräte gleichzeitig:** SecureCRT (Befehlsfenster an alle/Gruppen, Button-Bar). iTerm2 kann
  Eingabe an alle Panes senden. Sonst kaum vorhanden.
- **Sync zwischen Geräten:** Termius (Cloud, kostenpflichtig), Royal TSX (Dokument in iCloud/Dropbox),
  Tabby/electerm über Gist – Achtung, Zugangsdaten nie in Gists.
- **Automatisierung:** SecureCRT (Python), ZOC (eigene Sprache, Rekorder). Tabby über Plugins.
- **Alles in einem (RDP/VNC/Web):** Royal TSX, electerm.
- **Leicht und frei:** iTerm2 + OpenSSH, WindTerm.
- **Sicherheit:** OpenSSH-basierte Tools (Terminal, iTerm2, ZOC) bekommen Sicherheitsupdates schnell;
  bei Electron-Apps (Tabby, electerm, Termius) hängt es von deren Update-Takt ab. Host-Key-Prüfung
  überall prüfen, Passwörter nur im Schlüsselbund oder verschlüsseltem Vault.

## 4. Lücken, die eine eigene App schließen kann

Keine freie App vereint für den Netzwerk-Alltag (Automatisierung, Cisco-Konsolen, Gerätelisten):

1. Serial **und** SSH/Telnet/Raw mit einem Sitzungsbaum, Cisco-Standards vorbelegt (9600 8N1, `/dev/cu.*`).
2. „An alle senden“ wie SecureCRT – frei.
3. Befehlsbausteine mit Variablen (z. B. `show interfaces {{port}}`), je Gerätetyp.
4. Hervorhebung typischer Netzwerkausgaben (`down`, `err-disabled`, `% Invalid`, `up`, IP-Adressen).
5. Passwörter im macOS-Schlüsselbund statt in Konfigdateien, Host-Key-Prüfung mit `known_hosts`.
6. Import aus `~/.ssh/config` und PuTTY-Sitzungen (Registry-Export `.reg`).
7. Aufruf aus einer Geräteliste oder einem Dashboard per Link (`cable://ssh/<host>`), damit ein Klick direkt
   eine Konsole öffnet.
8. Protokoll jeder Sitzung als Datei mit Zeitstempel, abschaltbar je Sitzung.

Umsetzung: `README.md` dieses Repos („Kabel“).

## Quellen

- PuTTY: [Benutzerhandbuch](https://wa2l-wintools.sourceforge.net/chm/PuTTY/html/toc.html),
  [Homebrew-Formel](https://formulae.brew.sh/formula/putty), [MacPorts](https://ports.macports.org/port/putty),
  [0.83](https://putty.cs.utah.edu/latest.html), [Change Log](https://ftp.cvut.cz/putty/changes.html)
- [SecureCRT Features](https://www.vandyke.com/products/securecrt/features.html)
- [ZOC Terminal](https://www.emtec.com/zoc/index.html)
- [Termius Preise](https://termius.com/pricing), [Termius im Mac App Store](https://apps.apple.com/app/id1176074088)
- [Royal TSX Features](https://www.royalapps.com/ts/mac/features)
- [Tabby (GitHub)](https://github.com/Eugeny/tabby)
- [WindTerm (GitHub)](https://github.com/kingToolbox/WindTerm)
- [electerm (GitHub)](https://github.com/electerm/electerm)
- Serial auf dem Mac: [pbxbook](https://pbxbook.com/other/mac-ser.html),
  [embeddedTS](https://docs.embeddedts.com/Console_From_MACOSX_Workstation)
- Übersichten: [Setapp](https://setapp.com/app-reviews/putty-alternatives-for-mac),
  [dasroot.net 2026](https://dasroot.net/posts/2026/01/best-free-putty-alternatives-mac-2026/),
  [AlternativeTo](https://www.alternativeto.net/software/putty/)
