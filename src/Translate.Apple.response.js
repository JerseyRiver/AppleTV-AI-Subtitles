import { Console, done, Lodash as _, Storage } from "@nsnanocat/util";
import { URL } from "@nsnanocat/url";
import MD5 from "crypto-js/md5.js";
import VTT from "./WebVTT/WebVTT.mjs";
import database from "./function/database.mjs";
import setENV from "./function/setENV.mjs";
import detectFormat from "./function/detectFormat.mjs";
import Translate from "./class/Translate.mjs";
import SubtitleCache, { hasText, validTranslation } from "./function/subtitleCache.mjs";

const IN_FLIGHT_KEY = "AppleTVAI.Translate.InFlight.v2";
const CACHE_REVISION = "cue-text-v1";
const PROMPT_REVISION = "cue-isolation-v2";
const started = Date.now();
const scriptTime = typeof $script === "object" ? Number($script.startTime) : 0;
const startedAt = scriptTime > 1e12 ? Math.min(started, scriptTime) : started;
const DEADLINE = startedAt + 53000;
const url = new URL($request.url);
let credential = "";
let format = ($response.headers?.["Content-Type"] ?? $response.headers?.["content-type"])?.split(";")?.[0];
if (format === "application/octet-stream" || format === "text/plain") format = detectFormat(url, $response?.body, format);

(async () => {
	if (format !== "text/vtt" && format !== "application/vtt") return;
	Console.logLevel = "ERROR";
	const { Settings, Caches } = setENV("DualSubs", [["Universal", "Translate", "API"]], database);
	const argumentValue = (...keys) => {
		if (typeof $argument !== "object" || !$argument) return undefined;
		for (const key of keys) {
			const direct = $argument[key], nested = _.get($argument, key);
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
	credential = Settings.Gemini.APIKey;
	$response.headers["X-DualSubs-Gemini-Key-Source"] = liveAPIKey ? "argument" : credential ? "storage" : "missing";
	$response.headers["X-DualSubs-Gemini-Model"] = Settings.Gemini.Model;
	Console.logLevel = Settings.LogLevel;
	const languages = [url.searchParams?.get("lang")?.toUpperCase?.() ?? Settings.Languages[0], (url.searchParams?.get("tlang") ?? Caches?.tlang)?.toUpperCase?.() ?? Settings.Languages[1]];
	const body = VTT.parse($response.body);
	const fullText = body.body.map(item => (item?.text ?? "").replace(/<\/?[^<>]+>/g, ""));
	if (!fullText.some(hasText)) return;
	const identity = `${Settings.Vendor}|${Settings.Gemini.Model ?? ""}|${languages.join("|")}`;
	const cacheKey = MD5(JSON.stringify([CACHE_REVISION, PROMPT_REVISION, identity, fullText])).toString();
	const oldKey = MD5(`${identity}|${$response.body}`).toString();
	const legacyKeys = [MD5(`${PROMPT_REVISION}|${oldKey}`).toString()];
	const cache = new SubtitleCache(Storage, {
		limit: argumentValue("SubtitleCacheSize") || Settings.SubtitleCacheSize || 100,
		maxBytes: Math.max(1, Math.min(64, Number(argumentValue("SubtitleCacheMB") || Settings.SubtitleCacheMB || 12))) * 1024 * 1024,
	});
	const quotaKey = `AppleTVAI.Translate.Quota.${MD5(credential || "missing").toString()}`;
	const contentCooldownKey = `${quotaKey}.${cacheKey}`;
	$response.headers["X-DualSubs-Gemini-Cache-Revision"] = CACHE_REVISION;
	let translation = cache.get(cacheKey, fullText, legacyKeys);
	if (!translation) {
		const slot = await claimTranslationSlot(cache, cacheKey, fullText, legacyKeys, [quotaKey, contentCooldownKey]);
		if (slot.translation) {
			translation = slot.translation;
			$response.headers["X-DualSubs-Gemini-Coordinator"] = "wait-cache-hit";
			$response.headers["X-DualSubs-Gemini"] = `cache-hit; cues=${translation.length}`;
		} else {
			$response.headers["X-DualSubs-Gemini-Coordinator"] = "leader";
			try {
				translation = await translator(Settings.Vendor, fullText, languages, Settings?.[Settings.Vendor], cache, cacheKey);
				if (!validTranslation(translation, fullText)) throw new Error("翻译结果不完整，未覆盖原字幕或成品缓存");
				const saved = cache.set(cacheKey, translation, legacyKeys);
				$response.headers["X-DualSubs-Gemini-Cache"] = `${saved.verified ? "write-ok" : saved.reason === "oversize" ? "oversize-not-cached" : "write-failed"}; entries=${saved.size}`;
				if (saved.verified) cache.clearProgress(cacheKey);
				Storage.setItem(contentCooldownKey, {});
				$response.headers["X-DualSubs-Gemini"] = `translated; cues=${translation.length}`;
			} catch (error) {
				const message = errorText(error);
				const quota = /Gemini API 429|quota/i.test(message);
				Storage.setItem(quota ? quotaKey : contentCooldownKey, { expiresAt: Date.now() + (quota ? 60000 : 8000), reason: message.slice(0, 120) });
				throw error;
			} finally { releaseTranslationSlot(slot.owner); }
		}
	} else {
		$response.headers["X-DualSubs-Gemini-Coordinator"] = "cache";
		$response.headers["X-DualSubs-Gemini"] = `cache-hit; cues=${translation.length}`;
	}
	body.body.forEach((item, i) => {
		const original = item.text ?? "";
		item.text = Settings.ShowOnly ? translation[i] : Settings.Position === "Reverse" ? `${translation[i]}\n${original}` : `${original}\n${translation[i]}`;
	});
	$response.body = VTT.stringify(body);
})()
	.catch(error => {
		const message = errorText(error);
		Console.error(message);
		$response.headers["X-DualSubs-Gemini"] = "error";
		$response.headers["X-DualSubs-Gemini-Error"] = encodeURIComponent(message).slice(0, 180);
	})
	.finally(() => done($response));

function errorText(error) {
	const message = String(error?.message ?? error);
	return credential ? message.split(credential).join("[redacted]") : message;
}

async function translator(vendor, text, languages, api = {}, cache, cacheKey) {
	if (vendor !== "Gemini") throw new Error("此 Apple TV 翻译入口仅支持 Gemini");
	const length = Math.max(100, Math.min(600, Number.parseInt(api?.BatchSize ?? 400, 10) || 400));
	// Short subtitles also use two alternating batches, except for a single cue.
	const partCount = Math.max(text.length > 1 ? 2 : 1, Math.ceil(text.length / length));
	const parts = Array.from({ length: partCount }, () => []);
	text.forEach((value, index) => parts[index % partCount].push({ index, text: value }));
	const restored = new Array(text.length);
	let cursor = 0, resumed = 0;
	const failures = [];
	async function worker() {
		while (cursor < parts.length && !failures.length) {
			const part = parts[cursor++];
			const source = part.map(item => item.text);
			const partKey = MD5(JSON.stringify(source)).toString();
			const previous = cache.progress(cacheKey, partKey);
			try {
				let translated;
				if (validTranslation(previous, source)) { translated = previous; resumed++; }
				else {
					if (Date.now() + 2000 >= DEADLINE) throw new Error("Gemini 翻译总时限已到；已完成进度已保留，请稍后重试");
					translated = await new Translate({ Source: languages[0], Target: languages[1], API: { ...api, Deadline: DEADLINE, InitialTranslations: previous, OnProgress: snapshot => cache.saveProgress(cacheKey, partKey, snapshot) } }).Gemini(source);
					cache.saveProgress(cacheKey, partKey, translated);
				}
				part.forEach((item, i) => { restored[item.index] = translated[i]; });
			} catch (error) { failures.push(error); }
		}
	}
	await Promise.all(Array.from({ length: Math.min(2, parts.length) }, worker));
	$response.headers["X-DualSubs-Gemini-Progress"] = `batches=${parts.length}; resumed=${resumed}`;
	if (failures.length) throw failures.find(error => /429|quota/i.test(errorText(error))) || failures[0];
	return restored;
}

async function claimTranslationSlot(cache, cacheKey, source, aliases, cooldownKeys) {
	const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	let lastCacheCheck = 0;
	while (Date.now() + 1500 < DEADLINE) {
		const inFlight = Storage.getItem(IN_FLIGHT_KEY, {});
		if (Date.now() - lastCacheCheck > 1000 || !inFlight?.owner) {
			const translation = cache.get(cacheKey, source, aliases);
			if (translation) return { translation };
			lastCacheCheck = Date.now();
		}
		for (const key of cooldownKeys) {
			const cooldown = Storage.getItem(key, {});
			if (Number(cooldown?.expiresAt || 0) > Date.now()) throw new Error(`Gemini 冷却中，请稍后重试：${cooldown.reason || "上次请求失败"}`);
		}
		if (Number(inFlight?.expiresAt || 0) <= Date.now()) {
			Storage.setItem(IN_FLIGHT_KEY, { cacheKey, owner, expiresAt: DEADLINE + 2000 });
			await new Promise(resolve => setTimeout(resolve, 25));
			if (Storage.getItem(IN_FLIGHT_KEY, {})?.owner === owner) return { owner };
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error("等待字幕翻译超时；下次可继续已有进度");
}

function releaseTranslationSlot(owner) {
	if (Storage.getItem(IN_FLIGHT_KEY, {})?.owner === owner) Storage.setItem(IN_FLIGHT_KEY, {});
}
