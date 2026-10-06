import fs from "node:fs";
import vm from "node:vm";

const bundle = fs.readFileSync("plugin/scripts/Manifest.response.bundle.js", "utf8");
const storage = new Map();
const outboundRequests = [];

async function run(url, body, userAgent = "com.apple.tv/1.0 iOS/26.5 iPhone", gatewayURL = "https://subtitles.example.com/v1/test-token") {
	let doneResolve;
	const completion = new Promise(resolve => {
		doneResolve = resolve;
	});
	const context = vm.createContext({
		console: { log() {}, error() {}, warn() {} },
		setTimeout,
		clearTimeout,
		URL,
		$loon: {},
		$script: { startTime: Date.now() },
		$request: {
			url,
				headers: { "User-Agent": userAgent },
		},
		$response: {
			headers: { "Content-Type": "application/vnd.apple.mpegurl" },
			body,
		},
		$argument: {
			Types: "Official,Translate",
			GatewayURL: gatewayURL,
			"Languages[0]": "EN",
			"Languages[1]": "ZH-HANS",
			LogLevel: "ERROR",
		},
		$persistentStore: {
			read: key => storage.get(key) ?? null,
			write: (value, key) => {
				storage.set(key, value);
				return true;
			},
		},
		$httpClient: {
			get: () => {
				throw new Error("测试不应发起额外网络请求");
			},
			post: (request, callback) => {
				outboundRequests.push(request);
				callback(null, { status: 200, headers: {} }, '{"ok":true}');
			},
		},
		$done: value => doneResolve(value),
	});
	vm.runInContext(bundle, context);
	return completion;
}

const master = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,STABLE-RENDITION-ID="source-track",URI="en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="中文（简体）",LANGUAGE="zh-Hans",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,STABLE-RENDITION-ID="target-track",URI="zh.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,SUBTITLES="subs"
video.m3u8
`;
const masterResult = await run("https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8", master);
const translateLine = masterResult.body.split(/\r?\n/).find(line => line.includes("翻译字幕"));
if (!translateLine) throw new Error("没有生成翻译字幕轨");
if (!translateLine.includes("AUTOSELECT=NO")) throw new Error("翻译字幕轨仍会自动选择");
if (!translateLine.includes("DEFAULT=NO")) throw new Error("翻译字幕轨仍是默认轨");

const macResult = await run(
	"https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8",
	master,
	"TV/1.6.4 (Macintosh; OS X 26.4.1) AppleWebKit/624.1.16.11.4 build/88",
);
const macTranslateLine = macResult.body.split(/\r?\n/).find(line => line.includes("翻译字幕"));
if (!macTranslateLine) throw new Error("macOS 没有生成翻译字幕轨");
if (!macTranslateLine.includes('LANGUAGE="zh"')) throw new Error("macOS 翻译轨没有使用可识别的中文标签");
if (macTranslateLine.includes("x-dualsubs")) throw new Error("macOS 翻译轨仍包含 Apple TV 不接受的私有语言扩展");
if (!macTranslateLine.includes('STABLE-RENDITION-ID="source-track"')) throw new Error("macOS 翻译轨改坏了 Apple 原有稳定 ID 格式");
if (!macTranslateLine.includes("subtype=Translate")) throw new Error("macOS 翻译轨丢失 subtype 参数");

const subtitleURL = "https://vod-ap-aoc.tv.apple.com/itunes-assets/test/movie_subtitles_V2.m3u8?subtype=Translate&lang=EN";
const live = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:6.000,
segment10.webvtt
#EXTINF:6.000,
segment11.webvtt
`;
const liveResult = await run(subtitleURL, live);
if (liveResult.headers?.["X-DualSubs-Gemini-Live"] !== "disabled") throw new Error("直播字幕没有标记为禁用");
if (/subtype=Translate/.test(liveResult.body)) throw new Error("直播 WebVTT 仍会触发 Gemini");

const vod = `${live}#EXT-X-ENDLIST
`;
const vodResult = await run(subtitleURL, vod);
if (!/segment10\.webvtt\?subtype=Translate&lang=EN/.test(vodResult.body)) throw new Error("VOD 翻译字幕没有正常启用");

storage.set("DualSubs.Gemini.ExternalSubtitle.Metadata.v1", JSON.stringify({
	6794539309: {
		assetId: "6794539309",
		title: "Rocketman",
		year: 2019,
		duration: 7260,
		playbackDuration: 7334,
		type: "Movie",
	},
}));
const ccOnlyMaster = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs-ap",NAME="English (forced)",LANGUAGE="en",AUTOSELECT=YES,FORCED=YES,STABLE-RENDITION-ID="forced123",PATHWAY-ID="ap",URI="forced.m3u8"
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="English",LANGUAGE="en",AUTOSELECT=YES,INSTREAM-ID="CC1"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1000000,BANDWIDTH=1200000,SUBTITLES="subs-ap",CLOSED-CAPTIONS="cc",PATHWAY-ID="ap"
stream/playlist.m3u8?a=1848971751+1896844565+1653672574+6794539309+6799709562&mainAssetAdamId=6794539309
`;
const externalResult = await run(
	"https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?a=6794539309",
	ccOnlyMaster,
);
const externalLine = externalResult.body.split(/\r?\n/).find(line => line.includes("外部中文字幕"));
if (!externalLine) throw new Error("CC-only 影片没有生成外部字幕轨");
if (!externalLine.includes("AUTOSELECT=NO") || !externalLine.includes("DEFAULT=NO")) throw new Error("外部字幕轨不是手动选择");
if (!externalLine.includes("subtitles.example.com")) throw new Error("外部字幕轨没有指向 VPS");
if (!externalLine.includes("title=Rocketman") || !externalLine.includes("year=2019")) throw new Error("外部字幕轨缺少匹配元数据");
if (!externalLine.includes("duration=7334")) throw new Error("外部字幕轨缺少完整播放时长");
if (!externalLine.includes("discontinuity=3")) throw new Error("外部字幕轨没有对齐 Apple 正片 discontinuity sequence");
if (!externalLine.includes("gateway_version=0.11.0")) throw new Error("外部字幕轨没有携带网关缓存版本");
if (!externalLine.includes('STABLE-RENDITION-ID="ds4539309v110"')) throw new Error("外部字幕轨没有升级稳定 ID");
if (externalLine.includes("offset=")) throw new Error("外部字幕轨不应再平移 cue 时间");
const registration = outboundRequests.find(request => request.url?.includes("/apple/6794539309/reference.json"));
if (!registration) throw new Error("没有向 VPS 注册 Apple CC 参考播放列表");
if (!registration.body?.includes("play-edge.itunes.apple.com")) throw new Error("Apple CC 参考播放列表没有使用真实回源主机");
if (!registration.body?.includes("/hls/subscription/stream/playlist.m3u8")) throw new Error("Apple CC 相对播放列表路径解析错误");
if (!registration.body?.includes("mainAssetAdamId=6794539309")) throw new Error("Apple CC 参考播放列表缺少正片 ID");
if (externalResult.headers?.["X-DualSubs-External-Sync"] !== "registered") throw new Error("Apple CC 参考播放列表没有注册成功");

const requestCountBeforeDisabled = outboundRequests.length;
for (const gateway of ["", "http://subtitles.example.com/v1/test-token", "https://user:password@subtitles.example.com/v1/test-token"]) {
	const disabled = await run("https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?a=6794539309", ccOnlyMaster, undefined, gateway);
	if (disabled.body.includes("外部中文字幕")) throw new Error("未配置或不安全的网关仍生成了外部字幕轨");
}
if (outboundRequests.length !== requestCountBeforeDisabled) throw new Error("未配置网关仍发送了参考流地址");

console.log(JSON.stringify({
	translateAutoselect: false,
	translateDefault: false,
	macTranslateLanguage: "zh",
	macStableRendition: "apple-compatible",
	liveTranslation: "disabled",
	vodTranslation: "enabled",
	externalCCOnly: "enabled-manual",
}));
