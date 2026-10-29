import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bundle = fs.readFileSync('plugin/scripts/Translate.response.bundle.js', 'utf8');
const timestamp = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.000`;
const bodyFor = count => 'WEBVTT\n\n' + Array.from({ length: count }, (_, i) => `${timestamp(i * 2)} --> ${timestamp(i * 2 + 1)}\nSource line ${i}.\n`).join('\n');

// Deterministic virtual time: exercise long provider waits without live API calls.
async function simulate({ count = 1097, parallel = 3, runs = 1, duration = 28000, storage = new Map(), start = 1793239200000, errorBatch = 0, duplicateIds = false } = {}) {
  let now = start, timerId = 0, active = 0, maxActive = 0;
  const timers = new Map(), requests = [], results = [];
  const schedule = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + Number(delay) }); return id; };
  class ClockDate extends Date { static now() { return now; } }
  const body = bodyFor(count);
  const send = (request, callback) => {
    const payload = JSON.parse(request.body);
    assert.deepEqual(payload.generationConfig.responseSchema.required, ['translations']);
    const items = JSON.parse(payload.contents[0].parts[0].text);
    const number = requests.length + 1;
    requests.push({ at: now - start, cues: items.length, timeout: request.timeout });
    active++; maxActive = Math.max(maxActive, active);
    const elapsed = Math.min(duration, request.timeout);
    schedule(() => {
      active--;
      if (duration > request.timeout) { callback('mock timeout'); return; }
      if (number === errorBatch) { callback(null, { status: 429, headers: {} }, JSON.stringify({ error: { code: 429, message: 'mock quota' } })); return; }
      const rows = [...items].reverse();
      const ids = rows.map(item => item.id);
      if (duplicateIds && ids.length > 1) ids[1] = ids[0];
      callback(null, { status: 200, headers: {} }, JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ translations: rows.map((item, i) => ({ id: ids[i], text: `新译文 ${item.text}` })) }) }] } }] }));
    }, elapsed);
  };
  for (let i = 0; i < runs; i++) {
    const context = vm.createContext({
      console: { log() {}, warn() {}, error() {} }, Date: ClockDate, URL, crypto: globalThis.crypto,
      setTimeout: schedule, clearTimeout: id => timers.delete(id),
      $loon: {}, $script: { startTime: now },
      $request: { url: 'https://vod-ap-aoc.tv.apple.com/movie.webvtt?subtype=Translate&lang=EN&tlang=ZH', headers: {} },
      $response: { headers: { 'Content-Type': 'text/vtt' }, body },
      $argument: { Vendor: 'Gemini', GeminiAPIKey: 'mock-key', GeminiModel: 'gemini-3.5-flash-lite', GeminiBatchSize: '400', GeminiConcurrency: String(parallel), 'Languages[0]': 'EN', 'Languages[1]': 'ZH', ShowOnly: true, LogLevel: 'ERROR' },
      $persistentStore: { read: key => storage.get(key) || null, write: (value, key) => (storage.set(key, value), true) },
      $httpClient: { get: send, post: send },
      $done: output => results.push({ output, elapsed: now - start }),
    });
    vm.runInContext(bundle, context);
  }
  for (let iteration = 0; results.length < runs; iteration++) {
    if (iteration > 3000) throw new Error('Virtual timer did not settle');
    await new Promise(setImmediate);
    if (results.length === runs) break;
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) throw new Error('No scheduled work while script is unfinished');
    now = next[1].at; timers.delete(next[0]); next[1].fn();
  }
  return { results, requests, maxActive, storage, now, body };
}

const first = await simulate({ runs: 3 });
assert.equal(first.requests.length, 3, 'Concurrent player requests triggered duplicate translation');
assert.equal(first.maxActive, 3, 'Third batch waited for a second processing wave');
assert.ok(first.requests.every(request => request.at < 100), 'Three batches did not start together');
assert.ok(first.results.every(result => result.elapsed < 30000), '28-second batches exceeded the simulated player wait');
for (const result of first.results) {
  assert.match(result.output.body, /新译文 Source line 1096/);
  assert.equal(result.output.body.match(/ --> /g).length, 1097);
}
const replay = await simulate({ storage: first.storage, start: first.now + 1000 });
assert.equal(replay.requests.length, 0, 'Compact transport invalidated a finished cache');

const interrupted = await simulate({ errorBatch: 3 });
assert.equal(interrupted.requests.length, 3);
assert.equal(interrupted.results[0].output.headers['X-DualSubs-Gemini'], 'error');
const resumed = await simulate({ storage: interrupted.storage, start: interrupted.now + 61000 });
assert.equal(resumed.requests.length, 1, 'Valid finished batches were translated again');
assert.match(resumed.results[0].output.headers['X-DualSubs-Gemini-Progress'], /resumed=2/);

// Previously saved values must not silently preserve the queue after updating.
for (const parallel of [1, 2, 3, 99]) {
  const all = await simulate({ count: 1594, parallel, duration: 20000 });
  assert.equal(all.maxActive, 4);
  assert.equal(all.requests.length, 4);
  assert.ok(all.requests.every(request => request.at < 100));
  assert.ok(all.results[0].elapsed < 21000);
  assert.match(all.results[0].output.headers['X-DualSubs-Gemini-Progress'], /batches=4; parallel=4/);
}
const larger = await simulate({ count: 2401, duration: 1000 });
assert.equal(larger.maxActive, 7);
assert.equal(larger.requests.length, 7);
const stopped = await simulate({ count: 2401, parallel: 2, duration: 1000, errorBatch: 1 });
assert.equal(stopped.requests.length, 7, 'All batches should already be dispatched when quota failure arrives');
assert.equal(stopped.results[0].output.headers['X-DualSubs-Gemini'], 'error');
const cooldown = await simulate({ count: 2401, storage: stopped.storage, start: stopped.now + 1000 });
assert.equal(cooldown.requests.length, 0, 'Quota cooldown must still block a new attempt');
const invalid = await simulate({ duplicateIds: true, duration: 1000 });
assert.equal(invalid.results[0].output.body, invalid.body, 'Duplicate IDs produced mismatched captions');
assert.equal(invalid.results[0].output.headers['X-DualSubs-Gemini'], 'error');
console.log('First-load scheduling passed: three batches in one wave, 30-second virtual playback window, single leader, ID-bound output, resume, cache reuse, all-batch scheduling, ignored legacy settings and quota cooldown.');
