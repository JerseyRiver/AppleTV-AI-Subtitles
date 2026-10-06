import fs from 'node:fs';
import path from 'node:path';

const licenses = new Map();
function visit(module) {
  for (const child of module.modules || []) visit(child);
  const identifier = (module.name || '').replaceAll('\\', '/');
  const match = identifier.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (!match || licenses.has(match[1])) return;
  const name = match[1];
  const folder = path.join('node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const names = fs.readdirSync(folder).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file)).sort();
  if (!names.length) throw new Error('Missing license text for bundled package: ' + name);
  const texts = names.map(file => fs.readFileSync(path.join(folder, file), 'utf8'));
  licenses.set(name, `${name} ${pkg.version} (${pkg.license || 'see text'})\n${texts.join('\n')}`);
}
for (const module of JSON.parse(fs.readFileSync('dist/modules.json', 'utf8'))) visit(module);
const ownLicenses = ['LICENSE', 'NOTICE', 'licenses/Apache-2.0.txt', 'src/XML/LICENSE', 'vendor/nsnanocat-url/LICENSE', 'vendor/nsnanocat-util/LICENSE'];
const text = ownLicenses.map(file => `=== ${file} ===\n${fs.readFileSync(file, 'utf8')}`).join('\n\n')
  + '\n\n' + [...licenses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => '=== ' + value).join('\n\n');
fs.mkdirSync('plugin/scripts', { recursive: true });
fs.writeFileSync('plugin/scripts/LICENSES.txt', text);
for (const file of fs.readdirSync('dist').filter(name => name.endsWith('.bundle.js'))) {
  const header = '/*! AppleTV AI Subtitles v1.0.0 — JerseyRiver\n' +
    ' * Modified from DualSubs Universal by VirgilClyne and contributors.\n' +
    ' * Combined plugin: GPL-3.0-only; upstream Apache-2.0 and dependency licenses preserved.\n' +
    ' * Source and NOTICE: https://github.com/JerseyRiver/AppleTV-AI-Subtitles\n' +
    ' * Full third-party notices: https://raw.githubusercontent.com/JerseyRiver/AppleTV-AI-Subtitles/main/plugin/scripts/LICENSES.txt\n' +
    ' */\n';
  fs.writeFileSync(path.join('plugin/scripts', file), header + fs.readFileSync(path.join('dist', file), 'utf8'));
}
fs.copyFileSync('src/Apple.Metadata.response.js', 'plugin/scripts/Apple.Metadata.response.js');
console.log(`Public bundles built; ${licenses.size} dependency license notices included.`);
