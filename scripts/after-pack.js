'use strict';
// electron-builder afterPack: native Module (node-pty, serialport) enthalten Debug-Pfade des Rechners,
// auf dem sie gebaut wurden (/Users/<name>/…). Vor dem Weitergeben Debug-Symbole entfernen, ad hoc neu
// signieren (arm64 startet sonst nicht) und prüfen, dass keine solchen Pfade mehr in der App stehen.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const res = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  const unpacked = path.join(res, 'app.asar.unpacked');
  if (!fs.existsSync(unpacked)) return;
  const native = walk(unpacked).filter((f) => f.endsWith('.node') || path.basename(f) === 'spawn-helper');
  for (const f of native) {
    execFileSync('strip', ['-S', '-x', f]);
    execFileSync('codesign', ['--force', '--sign', '-', f]);
  }
  const leak = /\/Users\/[^/\0]+\//;
  const hits = [...walk(unpacked), path.join(res, 'app.asar')].filter((f) => leak.test(fs.readFileSync(f).toString('latin1')));
  if (hits.length) throw new Error(`Persönliche Pfade in der App:\n${hits.map((f) => path.relative(res, f)).join('\n')}`);
  console.log(`  • after-pack: ${native.length} native Module ohne Debug-Pfade, keine /Users/-Pfade in der App`);
};
