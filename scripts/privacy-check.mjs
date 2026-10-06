import fs from 'node:fs';
import path from 'node:path';

const excluded = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.DS_Store']);
const rules = [
  ['Google API key', /AIza[A-Za-z0-9_-]{30,}/],
  ['SubDL API key', /\bsubdl_[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['personal local path', /\/Users\/[^/\s]+\//],
  ['cloud project ID', /gen-lang-client-\d+/],
  ['real gateway token', /https:\/\/[^\s"'`]+\/v1\/[a-f0-9]{32,}/i],
];
let files = 0;
let failures = 0;
function walk(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const file = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink: ' + file);
    if (entry.isDirectory()) { walk(file); continue; }
    files++;
    const forbidden = /(?:\.har|\.zip|\.log|\.pem|\.key|\.pyc)$/i.test(file)
      || /(?:^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')
      || path.basename(file) === 'apple-subtitles.env';
    if (forbidden) { console.error(file + ': forbidden release file'); failures++; }
    const text = fs.readFileSync(file, 'utf8');
    for (const [label, pattern] of rules) {
      if (pattern.test(text)) { console.error(file + ': ' + label); failures++; }
    }
    // Avoid treating specification anchors such as "#sec-15.9.1.15" as IPs.
    const ips = [...text.matchAll(/(?<![\w#-])(?:\d{1,3}\.){3}\d{1,3}\b/g)].map(match => match[0]);
    if (ips.some(ip => ip !== '127.0.0.1' && ip !== '0.0.0.0' && ip.split('.').every(n => Number(n) <= 255))) {
      console.error(file + ': unexpected IPv4 address; review before release'); failures++;
    }
  }
}
walk('.');
if (failures) { console.error(`Privacy check failed (${failures} findings; values not printed).`); process.exit(1); }
console.log(`Privacy patterns passed for ${files} release files. Manual/history review still required.`);
