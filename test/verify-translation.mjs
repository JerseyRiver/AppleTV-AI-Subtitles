import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import VTT from '../src/WebVTT/WebVTT.mjs';

const bundle = fs.readFileSync('plugin/scripts/Translate.response.bundle.js', 'utf8');
const timestamp = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const body = `WEBVTT\n\n${Array.from({ length: 805 }, (_, i) => `${timestamp(i * 2)}.000 --> ${timestamp(i * 2 + 1)}.500\nOriginal cue ${i}.\n`).join('\n')}`;

async function run({ key = 'mock-key', incomplete = false, showOnly = false } = {}) {
  const storage = new Map();
  const requests = [];
  const logs = [];
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const send = (resource, callback) => {
    assert.ok(!resource.url.includes(key), 'API key should not be in request URL');
    assert.equal(resource.headers['x-goog-api-key'], key);
    const payload = JSON.parse(resource.body);
    const entries = JSON.parse(payload.contents[0].parts[0].text);
    const indexes = entries.map(item => Number(item.text.match(/cue (\d+)/)[1]));
    requests.push(indexes);
    assert.ok(payload.systemInstruction.parts[0].text.includes('Never move a word'));
    const translated = entries.map((item, i) => ({ id: item.id, text: `译文 ${indexes[i]}` }));
    callback(null, { status: 200, headers: {} }, JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ translations: incomplete ? [] : translated.reverse() }) }] } }] }));
  };
  const context = vm.createContext({
    console: { log: value => logs.push(String(value)), warn() {}, error() {} },
    setTimeout, clearTimeout, crypto: globalThis.crypto,
    $loon: {}, $script: { startTime: Date.now() },
    $request: { url: 'https://vod-ap-aoc.tv.apple.com/synthetic.webvtt?subtype=Translate&lang=EN&tlang=ZH', headers: {} },
    $response: { headers: { 'Content-Type': 'text/vtt' }, body },
    $argument: { Vendor: 'Gemini', GeminiAPIKey: key, GeminiBatchSize: '400', GeminiModel: 'gemini-3.5-flash-lite', 'Languages[0]': 'EN', 'Languages[1]': 'ZH', Position: 'Reverse', ShowOnly: String(showOnly), LogLevel: 'INFO' },
    $persistentStore: { read: name => storage.get(name) || null, write: (value, name) => (storage.set(name, value), true) },
    $httpClient: { get: send, post: send }, $done: complete,
  });
  vm.runInContext(bundle, context);
  let timeout;
  const result = await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Translation test timed out')), 5000); })]);
  clearTimeout(timeout);
  assert.ok(!logs.some(line => line.includes('mock-key')), 'Settings log disclosed credentials');
  return { result, requests, storage };
}

const original = VTT.parse(body).body;
const translated = await run();
const cues = VTT.parse(translated.result.body, { milliseconds: true, timeStamp: true, line: "multi", lineBreak: "\n" }).body;
assert.equal(translated.requests.length, 3);
for (const indexes of translated.requests) {
  for (let i = 1; i < indexes.length; i++) assert.equal(indexes[i] - indexes[i - 1], 3);
}
assert.equal(cues.length, original.length);
for (let i = 0; i < cues.length; i++) {
  assert.equal(cues[i].startTime, original[i].startTime);
  assert.equal(cues[i].endTime, original[i].endTime);
  assert.deepEqual(cues[i].text, [`译文 ${i}`, `Original cue ${i}.`]);
}
const noKey = await run({ key: '' });
assert.equal(noKey.requests.length, 0);
assert.equal(noKey.result.body, body);
assert.equal(noKey.result.headers['X-DualSubs-Gemini-Key-Source'], 'missing');
const partial = await run({ incomplete: true });
assert.equal(partial.result.body, body);
const cache = JSON.parse(partial.storage.get('DualSubs') || '{}').Translate?.Caches?.Subtitles;
assert.ok(!cache || JSON.parse(cache).length === 0, 'Incomplete translation should not be committed');
console.log('Cue isolation, reordered IDs, timing preservation, no-key safety and incomplete-cache safety passed.');
