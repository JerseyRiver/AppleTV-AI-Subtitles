import { Console, done, fetch, Lodash as _, Storage } from "@nsnanocat/util";
import { URL } from "@nsnanocat/url";
import M3U8 from "./EXTM3U/EXTM3U.mjs";
import AttrList from "./class/AttrList.mjs";
import database from "./function/database.mjs";
import detectPlatform from "./function/detectPlatform.mjs";
import setENV from "./function/setENV.mjs";
import isStandard from "./function/isStandard.mjs";
import detectPlaylist from "./function/detectPlaylist.mjs";
import setCache from "./function/setCache.mjs";
import aPath from "./function/aPath.mjs";

// Modified by JerseyRiver: opt-in gateway configuration, never a private built-in endpoint.
const EXTERNAL_SUBTITLE_BASE_URL = configuredGatewayURL();
const EXTERNAL_SUBTITLE_GATEWAY_VERSION = "0.11.0";
const EXTERNAL_METADATA_CACHE_KEY = "DualSubs.Gemini.ExternalSubtitle.Metadata.v1";
/***************** Processing *****************/
// 解构URL
const url = new URL($request.url);
Console.info(`url: ${url.toJSON()}`);
// 获取连接参数
const PATHs = url.pathname.split("/").filter(Boolean);
Console.info(`PATHs: ${PATHs}`);
// 解析格式
const FORMAT = ($response.headers?.["Content-Type"] ?? $response.headers?.["content-type"])?.split(";")?.[0];
Console.info(`FORMAT: ${FORMAT}`);
// 获取平台
const PLATFORM = detectPlatform($request.url);
Console.info(`PLATFORM: ${PLATFORM}`);
(async () => {
	/**
	 * 设置
	 * @type {{Settings: import('./types').Settings}}
	 */
	const { Settings, Caches, Configs } = setENV("DualSubs", [["YouTube", "Netflix", "BiliBili", "Spotify"].includes(PLATFORM) ? PLATFORM : "Universal", "Composite"], database);
	Console.logLevel = Settings.LogLevel;
	// 创建属性列表
	const attrList = new AttrList(FORMAT, PLATFORM);
	// 获取字幕类型与语言
	const Type = url.searchParams?.get("subtype") ?? Settings.Type,
		Languages = [url.searchParams?.get("lang")?.toUpperCase?.() ?? Settings.Languages[0], (url.searchParams?.get("tlang") ?? Caches?.tlang)?.toUpperCase?.() ?? Settings.Languages[1]];
	Console.info(`Type: ${Type}`, `Languages: ${Languages}`);
	// 兼容性判断
	const { standard: STANDARD, device: DEVICE } = isStandard(url, $request.headers, PLATFORM);
	// 创建空数据
	let body = {};
	// 格式判断
	switch (FORMAT) {
		case undefined: // 视为无body
			break;
		case "application/x-www-form-urlencoded":
		case "text/plain":
		default:
			break;
		case "application/x-mpegURL":
		case "application/x-mpegurl":
		case "application/vnd.apple.mpegurl":
		case "audio/x-mpegurl":
		case "audio/mpegurl":
			// 序列化M3U8
			body = M3U8.parse($response.body);
			//Console.debug(`M3U8.parse($response.body): ${JSON.stringify(body)}`);
			// 获取播放列表类型
			switch (detectPlaylist(body)) {
				case "Multivariant Playlist": {
					// 读取已存数据
					const playlistCache = Caches.Playlists.Master.get($request.url) || {};
					// 获取特定语言的字幕
					playlistCache[Languages[0]] = attrList.get($request.url, body, "SUBTITLES", Configs.Languages[Languages[0]]);
					playlistCache[Languages[1]] = attrList.get($request.url, body, "SUBTITLES", Configs.Languages[Languages[1]]);
					// 写入选项
					body = attrList.set(body, playlistCache, Settings.Types, Languages, STANDARD, DEVICE);
					// CC-only titles have no downloadable dialogue subtitle for Gemini. Add a
					// manual external Chinese track backed by the user's optional gateway.
					body = await addExternalSubtitleTrack(body, url);
					// 写入数据
					Caches.Playlists.Master.set($request.url, playlistCache);
					// 格式化缓存
					Caches.Playlists.Master = setCache(Caches.Playlists.Master, Settings.CacheSize);
					// 写入持久化储存
					Storage.setItem(`@DualSubs.${"Composite"}.Caches.Playlists.Master`, Caches.Playlists.Master);
					break;
				}
				case "Media Playlist": {
					// VOD 字幕列表结束时必须包含 EXT-X-ENDLIST；直播/进行中的 EVENT 列表没有该标记。
					// 直播字幕通常按数秒一个 WebVTT 片段持续刷新，不适合整片 Gemini 翻译与持久缓存。
					const isLiveTranslate = Type === "Translate" && !body.some(item => item?.TAG === "#EXT-X-ENDLIST");
					if (isLiveTranslate) {
						$response.headers["X-DualSubs-Gemini-Live"] = "disabled";
						Console.info("检测到直播字幕播放列表，跳过 Gemini 翻译");
					}
					// 处理类型
					switch (Type) {
						case "Official": {
							Console.info("官方字幕");
							// 获取字幕播放列表m3u8缓存（map）
							const { subtitlesPlaylist, subtitlesPlaylistIndex } = getPlaylistCache($request.url, Caches.Playlists.Master, Languages[0]) ?? getPlaylistCache($request.url, Caches.Playlists.Master, Languages[1]);
							// 写入字幕文件地址vtt缓存（map）
							Caches.Playlists.Subtitle = await setSubtitlesCache(Caches.Playlists.Subtitle, subtitlesPlaylist, Languages[0], subtitlesPlaylistIndex, PLATFORM);
							Caches.Playlists.Subtitle = await setSubtitlesCache(Caches.Playlists.Subtitle, subtitlesPlaylist, Languages[1], subtitlesPlaylistIndex, PLATFORM);
							// 格式化缓存
							Caches.Playlists.Subtitle = setCache(Caches?.Playlists.Subtitle, Settings.CacheSize);
							// 写入缓存
							Storage.setItem(`@DualSubs.${"Composite"}.Caches.Playlists.Subtitle`, Caches.Playlists.Subtitle);
							break;
						}
						case "Translate":
						default:
							Console.info("翻译字幕");
							break;
						case "External":
							Console.info("外挂字幕");
							break;
					}
					// WebVTT.m3u8加参数
					body = body.map((item, i) => {
						if (/^.+\.((web)?vtt|ttml2?|xml|smi)(\?.+)?$/.test(item?.URI)) {
							const symbol = item.URI.includes("?") ? "&" : "?";
							if (!isLiveTranslate && !/empty|blank|default/.test(item.URI)) {
								item.URI += `${symbol}subtype=${Type}`;
								if (url.searchParams?.has("lang")) item.URI += `&lang=${url.searchParams.get("lang")}`;
							}
							if (item.TAG === "#EXT-X-BYTERANGE")
								body[i - 1].URI = item.URI; // 删除BYTERANGE
							else return item;
						} else if (item?.URI && PLATFORM === "MGM+") {
							item.URI += `?subtype=${Type}`;
							if (url.searchParams?.has("lang")) item.URI += `&lang=${url.searchParams.get("lang")}`;
							return item;
						} else return item;
					});
					break;
				}
			}
			// 字符串M3U8
			$response.body = M3U8.stringify(body);
			break;
		case "text/xml":
		case "text/html":
		case "text/plist":
		case "application/xml":
		case "application/plist":
		case "application/x-plist":
			//body = XML.parse($response.body);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//$response.body = XML.stringify(body);
			break;
		case "text/vtt":
		case "application/vtt":
			//body = VTT.parse($response.body);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//$response.body = VTT.stringify(body);
			break;
		case "text/json":
		case "application/json": {
			body = JSON.parse($response.body ?? "{}");
			//Console.debug(`body: ${JSON.stringify(body)}`);
			// 读取已存数据
			const playlistCache = Caches.Playlists.Master.get($request.url) || {};
			// 判断平台
			switch (PLATFORM) {
				case "PrimeVideo":
					if (body?.subtitleUrls) {
						// 获取特定语言的字幕
						playlistCache[Languages[0]] = attrList.get($request.url, body, "subtitleUrls", Configs.Languages[Languages[0]]);
						playlistCache[Languages[1]] = attrList.get($request.url, body, "subtitleUrls", Configs.Languages[Languages[1]]);
						//Console.debug(`playlistCache[Languages[0]]: ${JSON.stringify(playlistCache[Languages[0]])}`);
						body.subtitleUrls = attrList.set(body.subtitleUrls, playlistCache, Settings.Types, Languages, STANDARD, DEVICE);
					}
					break;
			}
			// 写入数据
			Caches.Playlists.Master.set($request.url, playlistCache);
			// 格式化缓存
			Caches.Playlists.Master = setCache(Caches.Playlists.Master, Settings.CacheSize);
			// 写入持久化储存
			Storage.setItem(`@DualSubs.${"Composite"}.Caches.Playlists.Master`, Caches.Playlists.Master);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			$response.body = JSON.stringify(body);
			break;
		}
		case "application/protobuf":
		case "application/x-protobuf":
		case "application/vnd.google.protobuf":
		case "application/grpc":
		case "application/grpc+proto":
		case "application/octet-stream":
			break;
	}
})()
	.catch(e => Console.error(e))
	.finally(() => done($response));

/***************** Function *****************/
/**
 * Get Playlist Cache
 * @author VirgilClyne
 * @param {String} url - Request URL / Master Playlist URL
 * @param {Map} cache - Playlist Cache
 * @param {String} language - Language
 * @return {Promise<Object>} { masterPlaylistURL, subtitlesPlaylist, subtitlesPlaylistIndex }
 */
function getPlaylistCache(url, cache, language) {
	Console.log("☑️ getPlaylistCache", `language: ${language}`);
	let masterPlaylistURL = "";
	let subtitlesPlaylist = {};
	let subtitlesPlaylistIndex = 0;
	cache?.forEach((Value, Key) => {
		//Console.debug(`Key: ${Key}, Value: ${JSON.stringify(Value)}`);
		if (Array.isArray(Value?.[language])) {
			const array = Value?.[language];
			//Console.debug(`array: ${JSON.stringify(array)}`);
			if (
				array?.some((object, index) => {
					if (url.includes(object?.URI ?? object?.OPTION?.URI ?? null)) {
						subtitlesPlaylistIndex = index;
						Console.debug(`subtitlesPlaylistIndex: ${subtitlesPlaylistIndex}`);
						return true;
					} else return false;
				})
			) {
				masterPlaylistURL = Key;
				subtitlesPlaylist = Value;
				//Console.debug(`masterPlaylistURL: ${masterPlaylistURL}`, `subtitlesPlaylist: ${JSON.stringify(subtitlesPlaylist)}`);
			}
		}
	});
	Console.log("✅ getPlaylistCache", `masterPlaylistURL: ${JSON.stringify(masterPlaylistURL)}`);
	return { masterPlaylistURL, subtitlesPlaylist, subtitlesPlaylistIndex };
}

/**
 * Add a manual external Chinese subtitle rendition only when the title has
 * closed captions/forced text but no normal downloadable subtitle rendition.
 */
async function addExternalSubtitleTrack(body, url) {
	if (!EXTERNAL_SUBTITLE_BASE_URL.startsWith("https://")) return body;
	const media = body.filter(item => item?.TAG === "#EXT-X-MEDIA");
	const subtitles = media.filter(item => item?.OPTION?.TYPE === "SUBTITLES");
	const normalSubtitles = subtitles.filter(item => item?.OPTION?.FORCED !== "YES" && item?.OPTION?.URI);
	const closedCaptions = media.filter(item => item?.OPTION?.TYPE === "CLOSED-CAPTIONS");
	if (normalSubtitles.length || (!subtitles.length && !closedCaptions.length)) return body;

	const assetId = url.searchParams?.get("mainAssetAdamId") || url.searchParams?.get("a") || nestedAssetId(url.searchParams?.get("mainAssetEncodedQueryParams"));
	if (!/^\d{4,20}$/.test(assetId || "")) return body;
	const metadata = readExternalMetadata(assetId);
	if (!metadata?.title) {
		$response.headers["X-DualSubs-External"] = "metadata-miss";
		return body;
	}

	const discontinuitySequence = mainAssetDiscontinuitySequence(body, assetId);
	const frameRate = mainAssetFrameRate(body, assetId);
	await registerAppleReference(body, url, assetId);
	const endpoint = externalPlaylistURL(assetId, metadata, discontinuitySequence, frameRate);
	const stableId = `ds${assetId.slice(-7)}v110`;
	const templates = [];
	const seenGroups = new Set();
	subtitles.forEach(item => {
		const group = item?.OPTION?.["GROUP-ID"];
		if (group && !seenGroups.has(group)) {
			seenGroups.add(group);
			templates.push(item);
		}
	});

	if (templates.length) {
		const additions = templates.map(template => {
			const option = { ...template.OPTION };
			option.LANGUAGE = "zh";
			option.NAME = "外部中文字幕";
			option.AUTOSELECT = "NO";
			option.DEFAULT = "NO";
			option.FORCED = "NO";
			option["STABLE-RENDITION-ID"] = stableId;
			option.URI = endpoint;
			delete option.CHARACTERISTICS;
			return { TAG: "#EXT-X-MEDIA", OPTION: option };
		});
		const lastSubtitle = body.reduce((last, item, index) => item?.TAG === "#EXT-X-MEDIA" && item?.OPTION?.TYPE === "SUBTITLES" ? index : last, -1);
		body.splice(lastSubtitle + 1, 0, ...additions);
	} else {
		// Rare CC-only manifests without a subtitle group: create one per pathway
		// and attach it to the matching video variants.
		const pathways = new Set(body.filter(item => item?.TAG === "#EXT-X-STREAM-INF").map(item => item?.OPTION?.["PATHWAY-ID"] || "default"));
		const additions = [];
		pathways.forEach(pathway => {
			const group = `dualsubs-external-${pathway}`;
			additions.push({
				TAG: "#EXT-X-MEDIA",
				OPTION: {
					TYPE: "SUBTITLES",
					"GROUP-ID": group,
					LANGUAGE: "zh",
					NAME: "外部中文字幕",
					AUTOSELECT: "NO",
					DEFAULT: "NO",
					FORCED: "NO",
					"STABLE-RENDITION-ID": stableId,
					...(pathway !== "default" ? { "PATHWAY-ID": pathway } : {}),
					URI: endpoint,
				},
			});
			body.forEach(item => {
				if (item?.TAG === "#EXT-X-STREAM-INF" && (item?.OPTION?.["PATHWAY-ID"] || "default") === pathway) item.OPTION.SUBTITLES = group;
			});
		});
		const firstStream = body.findIndex(item => item?.TAG === "#EXT-X-STREAM-INF");
		body.splice(firstStream < 0 ? body.length : firstStream, 0, ...additions);
	}
	$response.headers["X-DualSubs-External"] = `injected; asset=${assetId}`;
	return body;
}

async function registerAppleReference(body, masterURL, assetId) {
	const variants = body
		.filter(item => item?.TAG === "#EXT-X-STREAM-INF" && item?.URI && streamContainsAsset(item.URI, assetId))
		.sort((left, right) => streamBandwidth(left) - streamBandwidth(right));
	if (!variants.length) {
		$response.headers["X-DualSubs-External-Sync"] = "reference-miss";
		return;
	}
	try {
		let playlistURL = resolvePlaylistURL(masterURL, variants[0].URI);
		playlistURL = playlistURL
			.replace("//play-edge-cdn.itunes.apple.com/", "//play-edge.itunes.apple.com/")
			.replace("//play-cdn.itunes.apple.com/", "//play.itunes.apple.com/");
		const response = await fetch({
			url: `${EXTERNAL_SUBTITLE_BASE_URL}/apple/${assetId}/reference.json`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ playlist_url: playlistURL }),
			timeout: 8,
		});
		$response.headers["X-DualSubs-External-Sync"] = response?.ok ? "registered" : `http-${response?.status || "error"}`;
	} catch (error) {
		Console.warn("Apple CC reference registration failed");
		$response.headers["X-DualSubs-External-Sync"] = "registration-failed";
	}
}

function configuredGatewayURL() {
	let value = typeof $argument === "object" && $argument ? $argument.GatewayURL : "";
	if (typeof $argument === "string") {
		const field = $argument.split("&").find(item => item.startsWith("GatewayURL="));
		value = field ? field.slice("GatewayURL=".length).replace(/^"|"$/g, "") : "";
	}
	const endpoint = String(value || "").trim().replace(/\/+$/, "");
	// Token is part of the path; require HTTPS and reject credentials, queries and fragments.
	return /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/v1\/[a-z0-9_-]{8,}$/i.test(endpoint) ? endpoint : "";
}

function resolvePlaylistURL(masterURL, relative) {
	if (/^https?:\/\//i.test(relative)) return relative;
	const href = masterURL.href || String(masterURL);
	const origin = href.match(/^https?:\/\/[^/]+/i)?.[0];
	if (!origin) throw new Error("invalid Apple master URL");
	if (relative.startsWith("/")) return `${origin}${relative}`;
	const pathname = masterURL.pathname || href.split(/[?#]/, 1)[0].replace(origin, "");
	const directory = pathname.slice(0, pathname.lastIndexOf("/") + 1);
	return `${origin}${directory}${relative}`;
}

function streamContainsAsset(uri, assetId) {
	const assets = queryValue(uri, "a")?.split(/[\s+]+/).filter(Boolean) || [];
	return assets.includes(assetId) || queryValue(uri, "mainAssetAdamId") === assetId;
}

function streamBandwidth(item) {
	const value = item?.OPTION?.["AVERAGE-BANDWIDTH"] ?? item?.OPTION?.BANDWIDTH;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function nestedAssetId(encoded) {
	try {
		return new URL(`https://local.invalid/?${encoded || ""}`).searchParams.get("a");
	} catch (_) {
		return undefined;
	}
}

function readExternalMetadata(assetId) {
	try {
		const raw = typeof $persistentStore !== "undefined" ? $persistentStore.read(EXTERNAL_METADATA_CACHE_KEY) : "";
		return JSON.parse(raw || "{}")[assetId];
	} catch (_) {
		return undefined;
	}
}

function mainAssetDiscontinuitySequence(body, assetId) {
	for (const item of body) {
		if (item?.TAG !== "#EXT-X-STREAM-INF" || !item?.URI) continue;
		const assets = queryValue(item.URI, "a")
			?.split(/[\s+]+/)
			.filter(Boolean);
		const mainAsset = queryValue(item.URI, "mainAssetAdamId") || assetId;
		const index = assets?.indexOf(mainAsset);
		if (index >= 0) return index;
	}
	return 0;
}

function mainAssetFrameRate(body, assetId) {
	for (const item of body) {
		if (item?.TAG !== "#EXT-X-STREAM-INF" || !item?.URI || !streamContainsAsset(item.URI, assetId)) continue;
		const value = Number(item?.OPTION?.["FRAME-RATE"]);
		if (Number.isFinite(value) && value >= 15 && value <= 120) return value;
	}
	return undefined;
}

function queryValue(uri, key) {
	try {
		const query = uri.split("?")[1] || "";
		for (const field of query.split("&")) {
			const [name, value = ""] = field.split(/=(.*)/, 2);
			if (decodeURIComponent(name) === key) return decodeURIComponent(value.replace(/\+/g, " "));
		}
	} catch (_) {
		return undefined;
	}
	return undefined;
}

function externalPlaylistURL(assetId, metadata, discontinuitySequence = 0, frameRate) {
	const params = [
		["title", metadata.title],
		["year", metadata.year],
		["duration", metadata.playbackDuration || metadata.duration],
		["type", metadata.type],
		["season", metadata.season],
		["episode", metadata.episode],
		["discontinuity", discontinuitySequence],
		["frame_rate", frameRate],
		["gateway_version", EXTERNAL_SUBTITLE_GATEWAY_VERSION],
	]
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join("&");
	return `${EXTERNAL_SUBTITLE_BASE_URL}/apple/${assetId}/playlist.m3u8?${params}`;
}

/**
 * Set Subtitles Cache
 * @author VirgilClyne
 * @param {Map} cache - Subtitles Cache
 * @param {Object} playlist - Subtitles Playlist Cache
 * @param {Array} language - Language
 * @param {Number} index - Subtitles Playlist Index
 * @param {String} platform - Steaming Media Platform
 * @return {Promise<Object>} { masterPlaylistURL, subtitlesPlaylist, subtitlesPlaylistIndex }
 */
async function setSubtitlesCache(cache, playlist, language, index = 0, platform = "Universal") {
	Console.log("☑️ setSubtitlesCache", `language: ${language}, index: ${index}`);
	await Promise.all(
		playlist?.[language]?.map(async (val, ind, arr) => {
			//Console.debug(`setSubtitlesCache, ind: ${ind}, val: ${JSON.stringify(val)}`);
			if ((arr[index] && ind === index) || !arr[index]) {
				// 查找字幕文件地址vtt缓存（map）
				let subtitlesURLarray = cache.get(val.URL) ?? [];
				//Console.debug(`setSubtitlesCache`, `subtitlesURLarray: ${JSON.stringify(subtitlesURLarray)}`);
				//Console.debug(`setSubtitlesCache`, `val?.URL: ${val?.URL}`);
				// 获取字幕文件地址vtt/ttml缓存（按语言）
				if (subtitlesURLarray.length === 0) subtitlesURLarray = await getSubtitles(val?.URL, $request.headers, platform);
				//Console.debug(`setSubtitlesCache`, `subtitlesURLarray: ${JSON.stringify(subtitlesURLarray)}`);
				// 写入字幕文件地址vtt/ttml缓存到map
				if (subtitlesURLarray.length !== 0) cache = cache.set(val.URL, subtitlesURLarray);
				//Console.debug(`subtitlesURLarray: ${JSON.stringify(cache.get(val?.URL))}`);
				Console.log("✅ setSubtitlesCache", `val?.URL: ${val?.URL}`);
			}
		}),
	);
	return cache;
}

/**
 * Get Subtitle *.vtt URLs
 * @author VirgilClyne
 * @param {String} url - VTT URL
 * @param {String} headers - Request Headers
 * @param {String} platform - Steaming Media Platform
 * @return {Promise<*>}
 */
async function getSubtitles(url, headers, platform) {
	Console.log("☑️ Get Subtitle *.vtt *.ttml URLs");
	let subtitles = await fetch(url, { headers: headers }).then((response, error) => {
		//Console.debug(`Get Subtitle *.vtt *.ttml URLs`, `response: ${JSON.stringify(response)}`);
		const subtitlePlayList = M3U8.parse(response.body);
		return subtitlePlayList
			.filter(({ URI }) => /^.+\.((web)?vtt|ttml2?|xml|smi)(\?.+)?$/.test(URI))
			.filter(({ URI }) => !URI.includes("empty"))
			.filter(({ URI }) => !URI.includes("blank"))
			.filter(({ URI }) => !URI.includes("default"))
			.map(({ URI }) => aPath(url, URI));
	});
	switch (platform) {
		case "Disney+":
			if (subtitles.some(item => /\/.+-MAIN\//.test(item))) subtitles = subtitles.filter(item => /\/.+-MAIN\//.test(item));
			break;
		case "PrimeVideo":
			if (subtitles.some(item => /\/aiv-prod-timedtext\//.test(item))) subtitles = subtitles.filter(item => /\/aiv-prod-timedtext\//.test(item));
			//Array.from(new Set(subtitles));
			subtitles = subtitles.filter((item, index, array) => {
				// 当前元素，在原始数组中的第一个索引==当前索引值，否则返回当前元素
				return array.indexOf(item, 0) === index;
			}); // 数组去重
			break;
		default:
			break;
	}
	Console.log("✅ Get Subtitle *.vtt *.ttml URLs", `subtitles: ${subtitles}`);
	return subtitles;
}
