import fs from "node:fs";
import vm from "node:vm";

const bundle = fs.readFileSync("plugin/scripts/Translate.response.bundle.js", "utf8");
const storage = new Map();
let apiRequestCount = 0;

function sourceBody(index) {
	return `WEBVTT

00:00:00.000 --> 00:00:01.500
Distinct subtitle ${index}.
`;
}

function startRun(index, delay = 20) {
	let doneResolve;
	const completion = new Promise(resolve => {
		doneResolve = resolve;
	});
	const send = (resource, callback) => {
		apiRequestCount += 1;
		const payload = JSON.parse(resource.body);
		const items = JSON.parse(payload.contents[0].parts[0].text);
		setTimeout(() => callback(null, { status: 200, headers: { "content-type": "application/json" } }, JSON.stringify({
			candidates: [{ content: { parts: [{ text: JSON.stringify({ translations: items.map(item => ({ id: item.id, text: `译文${index}` })) }) }] } }],
		})), delay);
	};
	const context = vm.createContext({
		console: { log() {}, error() {}, warn() {} },
		setTimeout,
		clearTimeout,
		crypto: globalThis.crypto,
		$loon: {},
		$script: { startTime: Date.now() },
		$request: {
			url: `https://vod-ap-aoc.tv.apple.com/movie-${index}.webvtt?subtype=Translate&lang=EN&tlang=ZH`,
			headers: {},
		},
		$response: {
			headers: { "Content-Type": "application/octet-stream" },
			body: sourceBody(index),
		},
		$argument: {
			"Languages[0]": "EN",
			"Languages[1]": "ZH-HANS",
			Position: "Reverse",
			Vendor: "Gemini",
			GeminiAPIKey: "mock-key",
			GeminiModel: "gemini-3.5-flash-lite",
			GeminiBatchSize: "400",
			ShowOnly: "false",
			LogLevel: "ERROR",
		},
		$persistentStore: {
			read: key => storage.get(key) ?? null,
			write: (value, key) => {
				storage.set(key, value);
				return true;
			},
		},
		$done: value => doneResolve(value),
		$httpClient: { get: send, post: send },
	});
	vm.runInContext(bundle, context);
	return completion;
}

function cacheEntries() {
	const root = JSON.parse(storage.get("DualSubs") ?? "{}");
	let entries = root?.Translate?.Caches?.Subtitles ?? [];
	if (typeof entries === "string") entries = JSON.parse(entries);
	return entries;
}

const firstResults = await Promise.all([startRun(0, 80), startRun(1, 80), startRun(2, 80)]);
if (apiRequestCount !== 3) throw new Error(`三份不同字幕应各请求一次，实际 ${apiRequestCount}`);
if (cacheEntries().length !== 3) throw new Error("并发保存覆盖了其他影片缓存");
if (firstResults.some(result => !result.headers?.["X-DualSubs-Gemini-Cache"]?.startsWith("write-ok"))) throw new Error("缓存写入后没有验证成功");

const requestsBeforeReplay = apiRequestCount;
const replay = await startRun(0);
if (apiRequestCount !== requestsBeforeReplay) throw new Error("重播已缓存影片仍调用了 Gemini");
if (!replay.headers?.["X-DualSubs-Gemini"]?.startsWith("cache-hit")) throw new Error("重播没有命中缓存");

for (let index = 3; index < 22; index += 1) await startRun(index, 0);
if (cacheEntries().length !== 20) throw new Error(`缓存容量不是 20，实际 ${cacheEntries().length}`);

console.log(JSON.stringify({
	concurrentDistinctEntries: 3,
	replay: "cache-hit",
	cacheLimit: cacheEntries().length,
	apiRequestCount,
}));
