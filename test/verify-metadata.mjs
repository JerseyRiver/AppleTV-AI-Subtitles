import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('plugin/scripts/Apple.Metadata.response.js', 'utf8');
const storage = new Map();
const body = JSON.stringify({ data: { videoAssetId: '1234567890', title: 'Synthetic Movie', releaseDate: '2020-01-01', duration: 7200, playEvent: { mediaLengthInSeconds: 7230 }, hlsUrl: 'https://play-edge.itunes.apple.com/test.m3u8' } });
let result;
vm.runInNewContext(source, {
  console: { log() {} }, $response: { body },
  $persistentStore: { read: key => storage.get(key) || null, write: (value, key) => (storage.set(key, value), true) },
  $done: value => { result = value; },
});
const cached = JSON.parse(storage.get('DualSubs.Gemini.ExternalSubtitle.Metadata.v1'))['1234567890'];
assert.equal(cached.title, 'Synthetic Movie');
assert.equal(cached.year, 2020);
assert.equal(cached.playbackDuration, 7230);
assert.ok(result.body.includes('play-edge-cdn.itunes.apple.com'));
assert.equal(JSON.parse(result.body).data.duration, 7200);
console.log('Synthetic metadata cache and playback bridge passed.');
