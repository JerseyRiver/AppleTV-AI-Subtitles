import { Console, done, Lodash as _, Storage } from "@nsnanocat/util";
import { URL } from "@nsnanocat/url";
import MD5 from "crypto-js/md5.js";
import VTT from "./WebVTT/WebVTT.mjs";
import database from "./function/database.mjs";
import setENV from "./function/setENV.mjs";
import setCache from "./function/setCache.mjs";
import detectFormat from "./function/detectFormat.mjs";
import Translate from "./class/Translate.mjs";

// Modified by JerseyRiver: public configuration, isolated cache revision; no embedded secrets.
const SUBTITLE_CACHE_KEY = "@DualSubs.Translate.Caches.Subtitles";
const IN_FLIGHT_KEY = "@DualSubs.Translate.State.InFlight";
const COOLDOWN_KEY = "@DualSubs.Translate.State.Cooldown";
const LOCK_TTL = 58000;
const WAIT_TIMEOUT = 48000;
const WAIT_INTERVAL = 400;
const SUBTITLE_CACHE_LIMIT = 20;
const CUE_BOUNDARY_CACHE_REVISION = "cue-isolation-v2";
const url = new URL($request.url);
let format = ($response.headers?.["Content-Type"] ?? $response.headers?.["content-type"])?.split(";")?.[0];
if (format === "application/octet-stream" || format === "text/plain") format = detectFormat(url, $response?.body, format);

(async () => {
	if (format !== "text/vtt" && format !== "application/vtt") return;
	Console.logLevel = "ERROR";
	const { Settings, Caches } = setENV("DualSubs", [["Universal", "Translate", "API"]], database);
	const argumentValue = (...keys) => {
		if (!$argument || typeof $argument !== "object") return undefined;
		for (const key of keys) {
			const direct = $argument[key];
			const nested = _.get($argument, key);
			if (direct !== undefined && direct !== null && direct !== "") return direct;
			if (nested !== undefined && nested !== null && nested !== "") return nested;
		}
		return undefined;
	};
	const liveAPIKey = argumentValue("GeminiAPIKey", "Gemini.APIKey");
	Settings.Vendor = argumentValue("Vendor") || Settings.Vendor;
	Settings.Gemini = {
		...Settings.Gemini,
		APIKey: liveAPIKey || Settings.GeminiAPIKey || Settings.Gemini?.APIKey || "",
		Model: argumentValue("GeminiModel", "Gemini.Model") || Settings.GeminiModel || Settings.Gemini?.Model,
		BatchSize: argumentValue("GeminiBatchSize", "Gemini.BatchSize") || Settings.GeminiBatchSize || Settings.Gemini?.BatchSize,
	};
	$response.headers["X-DualSubs-Gemini-Key-Source"] = liveAPIKey ? "argument" : Settings.Gemini?.APIKey ? "storage" : "missing";
	$response.headers["X-DualSubs-Gemini-Model"] = Settings.Gemini.Model;
	Console.logLevel = Settings.LogLevel;
	const languages = [
		url.searchParams?.get("lang")?.toUpperCase?.() ?? Settings.Languages[0],
		(url.searchParams?.get("tlang") ?? Caches?.tlang)?.toUpperCase?.() ?? Settings.Languages[1],
	];
	const body = VTT.parse($response.body);
	const fullText = body?.body.map(item => (item?.text ?? "\u200b")?.replace(/<\/?[^<>]+>/g, ""));
	const originalCacheKey = MD5(`${Settings.Vendor}|${Settings?.Gemini?.Model ?? ""}|${languages.join("|")}|${$response.body}`).toString();
	const cacheKey = MD5(`${CUE_BOUNDARY_CACHE_REVISION}|${originalCacheKey}`).toString();
	$response.headers["X-DualSubs-Gemini-Cache-Revision"] = CUE_BOUNDARY_CACHE_REVISION;
	let translation = Caches.Subtitles.get(cacheKey);
	if (!Array.isArray(translation) || translation.length !== fullText.length) {
		const slot = await claimTranslationSlot(cacheKey, fullText.length);
		if (slot.translation) {
			translation = slot.translation;
			$response.headers["X-DualSubs-Gemini-Coordinator"] = "wait-cache-hit";
			$response.headers["X-DualSubs-Gemini"] = `cache-hit; cues=${translation.length}`;
		} else {
			$response.headers["X-DualSubs-Gemini-Coordinator"] = "leader";
			try {
				translation = await translator(Settings.Vendor, Settings.Method, fullText, languages, Settings?.[Settings?.Vendor], Settings?.Times, Settings?.Interval, Settings?.Exponential);
				if (Array.isArray(translation) && translation.length === fullText.length) {
					const saved = savePersistentTranslation(cacheKey, translation);
					Caches.Subtitles = saved.cache;
					$response.headers["X-DualSubs-Gemini-Cache"] = `${saved.verified ? "write-ok" : "write-failed"}; entries=${saved.size}`;
					clearCooldown();
				}
				$response.headers["X-DualSubs-Gemini"] = `translated; cues=${translation.length}`;
			} catch (error) {
				setCooldown(error);
				throw error;
			} finally {
				releaseTranslationSlot(slot.owner);
			}
		}
	} else {
		Console.info("Gemini 字幕缓存命中");
		$response.headers["X-DualSubs-Gemini-Coordinator"] = "cache";
		$response.headers["X-DualSubs-Gemini"] = `cache-hit; cues=${translation.length}`;
	}
	body.body = body.body.map((item, i) => {
		item.text = combineText(item?.text ?? "\u200b", translation?.[i], Settings?.ShowOnly, Settings?.Position);
		return item;
	});
	$response.body = VTT.stringify(body);
})()
	.catch(error => {
		Console.error(error);
		$response.headers["X-DualSubs-Gemini"] = "error";
		$response.headers["X-DualSubs-Gemini-Error"] = encodeURIComponent(String(error?.message ?? error)).slice(0, 180);
	})
	.finally(() => done($response));

async function translator(vendor = "Gemini", method = "Part", text = [], [source = "AUTO", target = "ZH"], api = {}, times = 3, interval = 100, exponential = true) {
	let length = 120;
	if (vendor === "Gemini") length = Math.max(100, Math.min(600, Number.parseInt(api?.BatchSize ?? 400, 10) || 400));
	else if (["Microsoft", "Azure"].includes(vendor)) length = 99;
	else if (vendor === "DeepL") length = 49;
	else if (vendor === "DeepLX") length = 20;
	const retries = vendor === "Gemini" ? 0 : times;
	if (method === "Row") return await Promise.all(text.map(row => retry(() => new Translate({ Source: source, Target: target, API: api })[vendor](row), retries, interval, exponential)));
	if (vendor === "Gemini") {
		// Gemini tends to improve target-language word order by moving clauses
		// between neighboring subtitle cues. IDs remain valid, but the words then
		// appear at the wrong timestamps. Distribute consecutive cues across the
		// same number of API requests and restore their original order afterwards.
		const scatteredParts = scatterForCueIsolation(text, length);
		const translatedParts = await Promise.all(scatteredParts.map(part => retry(() => new Translate({ Source: source, Target: target, API: api })[vendor](part.map(item => item.text)), retries, interval, exponential)));
		const restored = new Array(text.length);
		translatedParts.forEach((translatedPart, partIndex) => {
			scatteredParts[partIndex].forEach((item, itemIndex) => {
				restored[item.index] = translatedPart[itemIndex];
			});
		});
		return restored;
	}
	const parts = chunk(text, length);
	return await Promise.all(parts.map(part => retry(() => new Translate({ Source: source, Target: target, API: api })[vendor](part), retries, interval, exponential))).then(part => part.flat(Number.POSITIVE_INFINITY));
}

function combineText(originText, transText, showOnly = false, position = "Forward", lineBreak = "\n") {
	if (showOnly) return transText;
	return position === "Reverse" ? `${transText}${lineBreak}${originText}` : `${originText}${lineBreak}${transText}`;
}

function chunk(source, length) {
	let index = 0;
	const target = [];
	while (index < source.length) target.push(source.slice(index, (index += length)));
	return target;
}

function scatterForCueIsolation(source, length) {
	const partCount = Math.max(1, Math.ceil(source.length / length));
	const parts = Array.from({ length: partCount }, () => []);
	source.forEach((text, index) => parts[index % partCount].push({ index, text }));
	return parts;
}

async function retry(fn, retriesLeft = 3, interval = 100, exponential = true) {
	try {
		return await fn();
	} catch (error) {
		if (!retriesLeft) throw error;
		await new Promise(resolve => setTimeout(resolve, interval));
		return retry(fn, retriesLeft - 1, exponential ? interval * 2 : interval, exponential);
	}
}

async function claimTranslationSlot(cacheKey, expectedLength) {
	const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const startedAt = Date.now();
	while (Date.now() - startedAt < WAIT_TIMEOUT) {
		const cached = readPersistentTranslation(cacheKey, expectedLength);
		if (cached) return { translation: cached };
		const cooldown = Storage.getItem(COOLDOWN_KEY, {});
		if (Number(cooldown?.expiresAt ?? 0) > Date.now()) {
			const waitSeconds = Math.max(1, Math.ceil((Number(cooldown.expiresAt) - Date.now()) / 1000));
			throw new Error(`Gemini 冷却中，请约 ${waitSeconds} 秒后重试：${cooldown?.reason ?? "上次请求失败"}`);
		}
		const inFlight = Storage.getItem(IN_FLIGHT_KEY, {});
		if (Number(inFlight?.expiresAt ?? 0) <= Date.now()) {
			Storage.setItem(IN_FLIGHT_KEY, { cacheKey, owner, expiresAt: Date.now() + LOCK_TTL });
			await new Promise(resolve => setTimeout(resolve, 25));
			const confirmed = Storage.getItem(IN_FLIGHT_KEY, {});
			if (confirmed?.owner === owner && confirmed?.cacheKey === cacheKey) return { owner };
		}
		await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL));
	}
	throw new Error("同一字幕正在翻译，等待缓存超时");
}

function readPersistentTranslation(cacheKey, expectedLength) {
	const cache = readPersistentSubtitleCache();
	const translation = cache.get(cacheKey);
	return Array.isArray(translation) && translation.length === expectedLength ? translation : null;
}

function readPersistentSubtitleCache() {
	let stored = Storage.getItem(SUBTITLE_CACHE_KEY, []);
	if (typeof stored === "string") {
		try {
			stored = JSON.parse(stored);
		} catch {
			stored = [];
		}
	}
	return stored instanceof Map ? new Map(stored) : new Map(Array.isArray(stored) ? stored : []);
}

function savePersistentTranslation(cacheKey, translation) {
	// 翻译期间其他脚本可能已写入别的影片；保存前重新读取并合并，避免旧快照覆盖新缓存。
	const latest = readPersistentSubtitleCache();
	latest.delete(cacheKey);
	latest.set(cacheKey, translation);
	const serialized = setCache(latest, SUBTITLE_CACHE_LIMIT);
	const written = Storage.setItem(SUBTITLE_CACHE_KEY, serialized);
	const verified = Boolean(written) && Boolean(readPersistentTranslation(cacheKey, translation.length));
	return { cache: new Map(serialized), size: serialized.length, verified };
}

function releaseTranslationSlot(owner) {
	const inFlight = Storage.getItem(IN_FLIGHT_KEY, {});
	if (inFlight?.owner === owner) Storage.setItem(IN_FLIGHT_KEY, { cacheKey: "", owner: "", expiresAt: 0 });
}

function setCooldown(error) {
	const message = String(error?.message ?? error);
	const duration = /Gemini API 429|quota/i.test(message) ? 60000 : 8000;
	Storage.setItem(COOLDOWN_KEY, { expiresAt: Date.now() + duration, reason: message.slice(0, 120) });
}

function clearCooldown() {
	Storage.setItem(COOLDOWN_KEY, { expiresAt: 0, reason: "" });
}
