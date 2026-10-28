import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import MD5 from 'crypto-js/md5.js';
import M3U8 from '../src/EXTM3U/EXTM3U.mjs';
import SubtitleCache from '../src/function/subtitleCache.mjs';
import selectHighestQuality from '../src/function/selectHighestQuality.mjs';

const translate = fs.readFileSync('plugin/scripts/Translate.response.bundle.js', 'utf8');
const manifest = fs.readFileSync('plugin/scripts/Manifest.response.bundle.js', 'utf8');
const cue = (text = 'Hello, world.') => `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${text}\n`;
const entries = storage => {
  const value = JSON.parse(storage.get('DualSubs') || '{}').Translate?.Caches?.Subtitles || [];
  return new Map(typeof value === 'string' ? JSON.parse(value) : value);
};
async function simulate(bundle, body, { storage = new Map(), model, argument = {}, mode = 'translate', clock = { now: Date.now() }, headers = { 'User-Agent': 'com.apple.tv/1.0 iOS/27.0.1 model/iPad13,8' } } = {}) {
  class ClockDate extends Date { static now() { return clock.now; } }
  let finish, count = 0;
  const requests = [];
  const done = new Promise(resolve => { finish = resolve; });
  const send = (request, callback) => {
    count++; requests.push(request);
    if (mode === 'manifest') { callback(null, { status: 200, headers: {} }, '{"ok":true}'); return; }
    const payload = JSON.parse(JSON.parse(request.body).contents[0].parts[0].text);
    const reply = model?.(payload, count, request) || { translations: payload.map(item => ({ id: item.id, text: `译文：${item.text}` })) };
    if (reply.duration) clock.now += Math.min(reply.duration, request.timeout);
    if (reply.duration > request.timeout) { callback('request timed out'); return; }
    if (reply.error) { callback(null, { status: reply.error, headers: {} }, JSON.stringify({ error: { code: reply.error, message: 'mock failure' } })); return; }
    callback(null, { status: 200, headers: {} }, JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }));
  };
  const context = vm.createContext({ console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, URL, Date: ClockDate, crypto: globalThis.crypto,
    $loon: {}, $script: { startTime: clock.now },
    $request: { url: mode === 'manifest' ? 'https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?a=1234567890' : 'https://vod-ap-aoc.tv.apple.com/movie.webvtt?subtype=Translate&lang=EN&tlang=ZH', headers },
    $response: { headers: { 'Content-Type': mode === 'manifest' ? 'application/vnd.apple.mpegurl' : 'text/vtt' }, body },
    $argument: { Vendor: 'Gemini', GeminiAPIKey: 'mock-key', GeminiModel: 'gemini-3.5-flash-lite', GeminiBatchSize: '400', 'Languages[0]': 'EN', 'Languages[1]': 'ZH', ShowOnly: 'true', Position: 'Reverse', Types: 'Official,Translate', GatewayURL: '', HighestQuality: false, LogLevel: 'ERROR', ...argument },
    $persistentStore: { read: key => storage.get(key) || null, write: (value, key) => (storage.set(key, value), true) },
    $httpClient: { get: send, post: send }, $done: finish });
  vm.runInContext(bundle, context);
  let timeout;
  const output = await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Reliability test hung')), 5000); })]);
  clearTimeout(timeout);
  return { output, requests, count, storage, clock };
}

const blank = await simulate(translate, cue(), { model: input => ({ translations: input.map(item => ({ id: item.id, text: ' \u200b ' })) }) });
assert.equal(blank.output.headers['X-DualSubs-Gemini'], 'error');
assert.equal(blank.output.body, cue());
assert.equal(entries(blank.storage).size, 0, 'Blank output entered completed cache');
const repaired = await simulate(translate, cue(), { model: (input, n) => ({ translations: input.map(item => ({ id: item.id, text: n === 1 ? '' : '你好' })) }) });
assert.equal(repaired.count, 2);
assert.match(repaired.output.body, /你好/);

const oldKey = MD5(`Gemini|gemini-3.5-flash-lite|EN|ZH|${cue()}`).toString();
const legacyKey = MD5(`cue-isolation-v2|${oldKey}`).toString();
const legacyStorage = new Map([['DualSubs', JSON.stringify({ Translate: { Caches: { Subtitles: JSON.stringify([[legacyKey, ['旧版有效译文']], ['other-movie', ['保留其他影片']]]) } } })]]);
const legacy = await simulate(translate, cue(), { storage: legacyStorage });
assert.equal(legacy.count, 0, 'Valid legacy translation was charged again');
assert.match(legacy.output.body, /旧版有效译文/);
assert.ok(entries(legacyStorage).has('other-movie'));
const badLegacyStorage = new Map([['DualSubs', JSON.stringify({ Translate: { Caches: { Subtitles: JSON.stringify([[legacyKey, ['']], ['other-movie', ['保留']]]) } } })]]);
const fixedLegacy = await simulate(translate, cue(), { storage: badLegacyStorage });
assert.equal(fixedLegacy.count, 1);
assert.ok(entries(badLegacyStorage).has('other-movie'));

const first = await simulate(translate, cue());
const changedHeader = cue().replace('WEBVTT\n', 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n');
const replay = await simulate(translate, changedHeader, { storage: first.storage });
assert.equal(replay.count, 0, 'Timestamp-map change invalidated the text translation');
assert.match(replay.output.body, /MPEGTS:900000/);
const changedTime = await simulate(translate, cue().replace('00:00:01.000', '00:00:02.000'), { storage: first.storage });
assert.equal(changedTime.count, 0);
assert.match(changedTime.output.body, /00:00:02.000 -->/);

const slowClock = { now: Date.now() };
const start = slowClock.now;
const slow = await simulate(translate, cue(), { clock: slowClock, model: (input, n) => ({ duration: 40000, translations: n === 1 ? [] : input.map(item => ({ id: item.id, text: '你好' })) }) });
assert.equal(slow.output.headers['X-DualSubs-Gemini'], 'error');
assert.equal(slow.output.body, cue());
assert.ok(slowClock.now - start <= 53000, 'Requests exceeded script time budget');
assert.ok(slow.requests[1].timeout < slow.requests[0].timeout);

const two = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfirst\n\n00:00:03.000 --> 00:00:04.000\nsecond\n';
const interrupted = await simulate(translate, two, { model: (input, n) => n === 2 ? { error: 429 } : { translations: input.map(item => ({ id: item.id, text: '第一段已完成' })) } });
assert.equal(interrupted.output.body, two);
assert.equal(entries(interrupted.storage).size, 0);
assert.equal(interrupted.count, 2, 'Short cues were not isolated');
interrupted.clock.now += 61000;
const resumed = await simulate(translate, two, { storage: interrupted.storage, clock: interrupted.clock });
assert.equal(resumed.count, 1, 'Already completed batch was translated again');
assert.match(resumed.output.body, /第一段已完成/);
assert.match(resumed.output.headers['X-DualSubs-Gemini-Progress'], /resumed=1/);

const storeData = new Map();
const fakeStore = { getItem: (key, fallback) => structuredClone(storeData.has(key) ? storeData.get(key) : fallback), setItem: (key, value) => (storeData.set(key, structuredClone(value)), true) };
const cache = new SubtitleCache(fakeStore, { limit: 2, maxBytes: 1000 });
cache.set('one', ['一']); cache.set('two', ['二']); cache.get('one', ['source']); cache.set('three', ['三']);
assert.ok(cache.readMap().has('one'));
assert.ok(!cache.readMap().has('two'), 'Recently used ordering was ignored');
const size = cache.readMap().size;
assert.equal(cache.set('huge', ['大'.repeat(1000)]).reason, 'oversize');
assert.equal(cache.readMap().size, size, 'Oversized entry evicted working movies');

const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="en.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="中文",LANGUAGE="zh",URI="zh.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",SUBTITLES="subs"\nvideo.m3u8\n';
let rewritten = master;
for (let i = 0; i < 4; i++) {
  const run = await simulate(manifest, rewritten, { mode: 'manifest', headers: {} });
  rewritten = run.output.body;
  assert.equal(M3U8.parse(rewritten).filter(x => x.OPTION?.TYPE === 'SUBTITLES').length, 4, 'Duplicate generated subtitle tracks');
}

const audio = M3U8.parse('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,CHANNELS="2",URI="en.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Japanese",LANGUAGE="ja",DEFAULT=NO,CHANNELS="2",URI="ja.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="atmos",NAME="English",LANGUAGE="en",DEFAULT=YES,CHANNELS="16/JOC",URI="en-atmos.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,VIDEO-RANGE=PQ,CODECS="dvh1.05.06,mp4a.40.2",AUDIO="aac"\nvideo-aac.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=21000000,RESOLUTION=3840x2160,VIDEO-RANGE=PQ,CODECS="dvh1.05.06,ec-3",AUDIO="atmos"\nvideo-atmos.m3u8');
const selected = selectHighestQuality(audio, true);
assert.equal(selected.audio, 'Atmos');
assert.equal(selected.after, 2);
assert.deepEqual(selected.body.filter(x => x.OPTION?.TYPE === 'AUDIO').map(x => x.OPTION.LANGUAGE).sort(), ['en', 'ja']);
assert.ok(selected.body.filter(x => x.TAG === '#EXT-X-STREAM-INF').every(x => x.OPTION.RESOLUTION === '3840x2160'));

const cc = '#EXTM3U\n#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="English",LANGUAGE="en",INSTREAM-ID="CC1"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",CLOSED-CAPTIONS="cc"\nstream/playlist.m3u8?a=1234567890&mainAssetAdamId=1234567890\n';
const refStore = new Map([['DualSubs.Gemini.ExternalSubtitle.Metadata.v1', JSON.stringify({ '1234567890': { title: 'Synthetic Movie', year: 2020, type: 'Movie', playbackDuration: 7200 } })]]);
const registration = await simulate(manifest, cc, { mode: 'manifest', storage: refStore, argument: { GatewayURL: 'https://subtitles.example.com/v1/test-token' } });
const registrationAgain = await simulate(manifest, cc, { mode: 'manifest', storage: refStore, argument: { GatewayURL: 'https://subtitles.example.com/v1/test-token' } });
assert.equal(registration.count, 1);
assert.ok(registration.requests[0].timeout <= 2000);
assert.equal(registrationAgain.count, 0);
assert.match(registrationAgain.output.headers['X-DualSubs-External-Sync'], /registered-cached/);
console.log('Reliability fixes passed: blank/legacy caches, text identity, total deadline, resume, LRU/bytes, short-cue isolation, idempotency, audio languages and reference deduplication.');
