/* Apple UTS response bridge + local playback metadata cache for Loon. */

const CACHE_KEY = "DualSubs.Gemini.ExternalSubtitle.Metadata.v1";
const CACHE_LIMIT = 120;

try {
	let body = $response.body ?? "";
	body = body
		.replace(/("hlsUrl"\s*:\s*"https:\/\/)play\.itunes\.apple\.com/g, "$1play-cdn.itunes.apple.com")
		.replace(/("hlsUrl"\s*:\s*"https:\/\/)play-edge\.itunes\.apple\.com/g, "$1play-edge-cdn.itunes.apple.com");

	if (body.includes('"videoAssetId"')) {
		const document = JSON.parse(body);
		const cache = readCache();
		collect(document, cache);
		writeCache(cache);
	}
	$done({ body });
} catch (error) {
	console.log(`[DualSubs External Metadata] ${error}`);
	$done({ body: $response.body });
}

function readCache() {
	try {
		return JSON.parse($persistentStore.read(CACHE_KEY) || "{}");
	} catch (_) {
		return {};
	}
}

function writeCache(cache) {
	const entries = Object.entries(cache)
		.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
		.slice(0, CACHE_LIMIT);
	$persistentStore.write(JSON.stringify(Object.fromEntries(entries)), CACHE_KEY);
}

function collect(value, cache) {
	if (!value || typeof value !== "object") return;
	if (!Array.isArray(value)) {
		const assetId = String(value.videoAssetId || mediaAssetId(value) || "");
		const canonical = value.canonicalMetadata || {};
		const title = value.title || value.movieTitle || canonical.movieTitle || canonical.title;
		if (/^\d{4,20}$/.test(assetId) && typeof title === "string" && title.trim()) {
			const releaseDate = value.releaseDate || canonical.releaseDate;
			const previous = cache[assetId] || {};
			const mediaLength = numberFrom(value.playEvent?.mediaLengthInSeconds);
			cache[assetId] = {
				...previous,
				assetId,
				title: title.trim(),
				year: yearFrom(releaseDate) || previous.year,
				duration: numberFrom(value.duration || canonical.duration) || previous.duration,
				playbackDuration: mediaLength || previous.playbackDuration,
				type: value.contentType || value.type || previous.type || "Movie",
				season: numberFrom(value.seasonNumber || value.season) || previous.season,
				episode: numberFrom(value.episodeNumber || value.episode) || previous.episode,
				canonicalId: value.canonicalId || value.id || previous.canonicalId,
				updatedAt: Date.now(),
			};
		}
	}
	for (const child of Object.values(value)) collect(child, cache);
}

function mediaAssetId(value) {
	const identifier = value?.mediaMetrics?.MediaIdentifier;
	return typeof identifier === "string" ? identifier.match(/(?:^|:)a=(\d+)/)?.[1] : "";
}

function yearFrom(value) {
	if (typeof value === "number") {
		const date = new Date(value);
		return Number.isFinite(date.getTime()) ? date.getUTCFullYear() : undefined;
	}
	if (typeof value === "string") {
		const match = value.match(/(?:18|19|20|21)\d{2}/);
		return match ? Number(match[0]) : undefined;
	}
}

function numberFrom(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}
