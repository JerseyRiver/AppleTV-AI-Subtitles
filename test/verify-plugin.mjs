import fs from 'node:fs';
import assert from 'node:assert/strict';
const plugin = fs.readFileSync('plugin/AppleTV.AI.Subtitles.plugin', 'utf8');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
assert.match(plugin, /GeminiAPIKey = input,""/);
assert.match(plugin, /GatewayURL = input,""/);
assert.match(plugin, /HighestQuality = switch,false/);
assert.match(plugin, /RetranslateNext = switch,false/);
assert.match(plugin, /RetranslateRequest = input,"1"/);
assert.match(plugin, /GeminiConcurrency = select,"3","2","1","4"/);
assert.match(plugin, /#!author = JerseyRiver/);
assert.match(plugin, /#!icon = https:\/\/raw\.githubusercontent\.com\/JerseyRiver\/AppleTV-AI-Subtitles\/main\/assets\/icon-button\.png/);
assert.ok(fs.existsSync('assets/icon-button.png'), 'Missing plugin icon');
for (const line of plugin.split('\n').filter(line => line.startsWith('http-response '))) {
  const resource = line.match(/script-path=https:\/\/raw\.githubusercontent\.com\/JerseyRiver\/AppleTV-AI-Subtitles\/main\/plugin\/scripts\/([^,\s]+)/)?.[1];
  const file = resource?.split('?')[0];
  assert.ok(file && fs.existsSync('plugin/scripts/' + file), 'Unresolved script');
  if (file.endsWith('.bundle.js')) {
    assert.ok(line.includes('{GeminiAPIKey}') && line.includes('{GatewayURL}'), 'Config not forwarded');
  }
  if (file === 'Manifest.response.bundle.js') assert.ok(line.includes('{HighestQuality}') && resource.includes('v=' + version), 'Quality toggle or cache version not forwarded');
  if (file === 'Translate.response.bundle.js') assert.ok(line.includes('{SubtitleCacheSize}') && line.includes('{SubtitleCacheMB}') && line.includes('{GeminiConcurrency}'), 'Cache/concurrency configuration not forwarded');
  if (file === 'Manifest.response.bundle.js' || file === 'Translate.response.bundle.js') assert.ok(line.includes('{RetranslateNext}') && line.includes('{RetranslateRequest}'), 'Retry controls not forwarded');
  assert.ok(/apple\\\.com/.test(line), 'Rule outside Apple scope');
}
console.log('Public plugin paths, branding, Apple scope and configuration passed.');
