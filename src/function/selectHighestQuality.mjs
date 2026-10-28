/**
 * Optional Apple HLS quality lock. Copyright 2026 JerseyRiver. GPL-3.0-only.
 * Keep original variant/rendition objects and signed URIs. Media playlists,
 * encryption, interstitial boundaries and subtitle timing are never rewritten.
 */
export default function selectHighestQuality(items, enabled = false) {
	if (![true, "true", 1, "1"].includes(enabled)) return { body: items, state: "off" };
	if (!Array.isArray(items)) return { body: items, state: "skipped-invalid" };
	const streams = items.filter(item => item?.TAG === "#EXT-X-STREAM-INF");
	if (!streams.length) return { body: items, state: "skipped-media" };
	const media = items.filter(item => item?.TAG === "#EXT-X-MEDIA");
	const candidates = [];
	for (const item of streams) {
		const a = item.OPTION || {};
		const size = /^(\d+)x(\d+)$/.exec(String(a.RESOLUTION || ""));
		if (!size || !item.URI || !Number(a.BANDWIDTH)) return { body: items, state: "skipped-incomplete" };
		const width = Number(size[1]), height = Number(size[2]);
		if (!width || !height) return { body: items, state: "skipped-incomplete" };
		for (const type of ["AUDIO", "VIDEO", "SUBTITLES", "CLOSED-CAPTIONS"]) {
			if (a[type] && a[type] !== "NONE" && !media.some(m => m.OPTION?.TYPE === type && m.OPTION?.["GROUP-ID"] === a[type])) {
				return { body: items, state: "skipped-missing-group" };
			}
		}
		const codecs = String(a.CODECS || "");
		const supplemental = String(a["SUPPLEMENTAL-CODECS"] || "");
		const dolby = /(?:^|,)(?:dvh1|dvhe|dav1)\./i.test(codecs) || /(?:dvh1|dvhe|dav1)\./i.test(supplemental);
		const range = String(a["VIDEO-RANGE"] || "SDR").toUpperCase();
		const hdrRank = dolby ? 4 : range === "PQ" ? 3 : range === "HLG" ? 2 : 1;
		const codecRank = /(?:^|,)(?:dvh1|dvhe|hvc1|hev1|av01)\./i.test(codecs) ? 2 : /(?:^|,)avc[13]\./i.test(codecs) ? 1 : 0;
		if (!codecRank) return { body: items, state: "skipped-unknown-codec" };
		const audio = media.filter(m => m.OPTION?.TYPE === "AUDIO" && m.OPTION?.["GROUP-ID"] === a.AUDIO);
		const preferred = audio.filter(m => m.OPTION.DEFAULT === "YES" && !/describes-video/.test(m.OPTION.CHARACTERISTICS || ""));
		const audioEvidence = preferred.length ? preferred : audio.filter(m => !/describes-video/.test(m.OPTION.CHARACTERISTICS || ""));
		const joc = audioEvidence.some(m => /JOC/i.test(String(m.OPTION.CHANNELS || ""))) || /(?:^|,)ec\+3(?:,|$)/i.test(codecs);
		const lossless = /(?:^|,)(?:alac|fLaC)(?:,|$)/i.test(codecs);
		const audioRank = joc ? 5 : lossless ? 4 : /(?:^|,)ec-3(?:,|$)/i.test(codecs) ? 3 : /(?:^|,)ac-3(?:,|$)/i.test(codecs) ? 2 : /(?:^|,)mp4a\./i.test(codecs) ? 1 : 0;
		const channels = Math.max(0, ...audioEvidence.map(m => Number.parseInt(m.OPTION.CHANNELS || "0", 10) || 0));
		candidates.push({ item, width, height, range: dolby ? "DolbyVision" : range, audio: joc ? "Atmos" : lossless ? "Lossless" : audioRank === 3 ? "DDPlus" : audioRank === 2 ? "DolbyDigital" : audioRank === 1 ? "AAC" : "embedded", rank: [width * height, hdrRank, codecRank, Number(a["FRAME-RATE"]) || 0, audioRank, channels], average: Number(a["AVERAGE-BANDWIDTH"]) || Number(a.BANDWIDTH), peak: Number(a.BANDWIDTH) });
	}
	const compare = (a, b) => {
		for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
		return 0;
	};
	const best = candidates.reduce((a, b) => compare(a, b) >= 0 ? a : b);
	const top = candidates.filter(v => compare(v, best) === 0);
	const pathways = new Map();
	for (const v of top) {
		// Alternate CDNs stay available; each receives its best matching bitrate.
		const key = v.item.OPTION["PATHWAY-ID"] || "default";
		const previous = pathways.get(key);
		if (!previous || v.average > previous.average || (v.average === previous.average && v.peak > previous.peak)) pathways.set(key, v);
	}
	const winners = [...pathways.values()];
	const retained = new Set(winners.map(v => v.item));
	const groups = new Set();
	for (const v of winners) for (const type of ["AUDIO", "VIDEO", "SUBTITLES", "CLOSED-CAPTIONS"]) {
		if (v.item.OPTION[type] && v.item.OPTION[type] !== "NONE") groups.add(`${type}:${v.item.OPTION[type]}`);
	}
	const body = items.filter(item => {
		if (item?.TAG === "#EXT-X-STREAM-INF") return retained.has(item);
		if (item?.TAG === "#EXT-X-MEDIA") return groups.has(`${item.OPTION?.TYPE}:${item.OPTION?.["GROUP-ID"]}`);
		return true;
	});
	return { body, state: "locked", resolution: `${best.width}x${best.height}`, video: best.range, audio: best.audio, channels: best.rank[5], averageBandwidth: Math.max(...winners.map(v => v.average)), before: streams.length, after: winners.length };
}
