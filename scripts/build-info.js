'use strict';
// Schreibt dist/build-info.json: Version, Commit und Quellordner, aus dem gebaut wurde.
// Die App liest die Datei, um im Menü „Hilfe“ Repo, Quellordner und Updates anzubieten.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

function git(...args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

const info = {
  version: pkg.version,
  repo: (pkg.homepage || '').replace(/#.*$/, ''),
  commit: git('rev-parse', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
  sourceDir: git('rev-parse', '--show-toplevel') ? root : '',
  builtAt: new Date().toISOString(),
};

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`build-info: ${info.version} ${info.commit.slice(0, 7) || 'ohne git'}${info.dirty ? ' (lokale Änderungen)' : ''}`);
