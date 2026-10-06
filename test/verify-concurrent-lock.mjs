import fs from "node:fs";
import vm from "node:vm";

const concurrentRuns = 3;
const cueCount = 805;
const quotaMode = process.argv.includes("--429");
const bundle = fs.readFileSync("plugin/scripts/Translate.response.bundle.js", "utf8");
const storage = new Map();
let apiRequestCount = 0;
let translatedItemCount = 0;

const timestamp = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
const sourceBody = `WEBVTT\n\n${Array.from({ length: cueCount }, (_, index) => `${timestamp(index * 2)}.000 --> ${timestamp(index * 2 + 1)}.500\nSubtitle ${index + 1}.\n`).join("\n")}`;

function startRun(index) {
	let doneResolve;
	const completion = new Promise(resolve => {
		doneResolve = resolve;
	});
	const send = (resource, callback) => {
		apiRequestCount += 1;
		const payload = JSON.parse(resource.body);
		const items = JSON.parse(payload.contents[0].parts[0].text);
		translatedItemCount += items.length;
		setTimeout(() => {
			if (quotaMode) {
				callback(null, { status: 429, headers: { "content-type": "application/json" } }, JSON.stringify({ error: { code: 429, message: "quota exceeded" } }));
				return;
			}
			callback(null, { status: 200, headers: { "content-type": "application/json" } }, JSON.stringify({
				candidates: [{ content: { parts: [{ text: JSON.stringify({ translations: items.map(item => ({ id: item.id, text: `译文${item.id + 1}` })) }) }] } }],
			}));
		}, 150);
	};
	const context = vm.createContext({
		console: { log() {}, error() {}, warn() {} },
		setTimeout,
		clearTimeout,
		crypto: globalThis.crypto,
		$loon: {},
		$script: { startTime: Date.now() },
		$request: {
			url: `https://vod-ap-aoc.tv.apple.com/movie.webvtt?subtype=Translate&lang=EN&tlang=ZH&run=${index}`,
			headers: {},
		},
		$response: {
			headers: { "Content-Type": "application/octet-stream" },
			body: sourceBody,
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

let timeoutId;
const timeout = new Promise((_, reject) => {
	timeoutId = setTimeout(() => reject(new Error("并发锁测试超时")), 5000);
});
const results = await Promise.race([Promise.all(Array.from({ length: concurrentRuns }, (_, index) => startRun(index))), timeout]);
clearTimeout(timeoutId);
const diagnostics = results.map(result => result.headers?.["X-DualSubs-Gemini"]);
const coordinators = results.map(result => result.headers?.["X-DualSubs-Gemini-Coordinator"]);
const summary = { quotaMode, concurrentRuns, cueCount, apiRequestCount, translatedItemCount, diagnostics, coordinators };
console.log(JSON.stringify(summary));

if (apiRequestCount !== 3) throw new Error(`并发锁失效：期望 3 个 Gemini 批次，实际 ${apiRequestCount}`);
if (quotaMode) {
	if (diagnostics.some(value => value !== "error")) throw new Error("429 模式应全部安全回退原字幕");
} else {
	if (translatedItemCount !== cueCount) throw new Error(`重复翻译：期望发送 ${cueCount} 条，实际 ${translatedItemCount}`);
	if (diagnostics.filter(value => value?.startsWith("translated")).length !== 1) throw new Error("应当只有一个 leader 完成翻译");
	if (diagnostics.filter(value => value?.startsWith("cache-hit")).length !== concurrentRuns - 1) throw new Error("其余请求没有等待并命中共享缓存");
}
