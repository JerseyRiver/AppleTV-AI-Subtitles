import fs from 'node:fs';
import assert from 'node:assert/strict';
const plugin = fs.readFileSync('plugin/AppleTV.AI.Subtitles.plugin', 'utf8');
assert.match(plugin, /GeminiAPIKey = input,""/);
assert.match(plugin, /GatewayURL = input,""/);
assert.match(plugin, /#!author = JerseyRiver/);
assert.doesNotMatch(plugin, /#!icon/);
for (const line of plugin.split('\n').filter(line => line.startsWith('http-response '))) {
  const file = line.match(/script-path=https:\/\/raw\.githubusercontent\.com\/JerseyRiver\/AppleTV-AI-Subtitles\/main\/plugin\/scripts\/([^,\s]+)/)?.[1];
  assert.ok(file && fs.existsSync('plugin/scripts/' + file), 'Unresolved script');
  if (file.endsWith('.bundle.js')) {
    assert.ok(line.includes('{GeminiAPIKey}') && line.includes('{GatewayURL}'), 'Config not forwarded');
  }
  assert.ok(/apple\\\.com/.test(line), 'Rule outside Apple scope');
}
console.log('Public plugin paths, branding, Apple scope and configuration passed.');
