// Copyright 2026 JerseyRiver. GPL-3.0-only.
const CACHE = "@DualSubs.Translate.Caches.Subtitles";
const ACCESS = "AppleTVAI.SubtitleAccess.v1";
const PROGRESS = "AppleTVAI.SubtitleProgress.v1";
const DAY = 86400000;

export const hasText = value => typeof value === "string" && value.replace(/[\s\u200b-\u200d\ufeff]/g, "").length > 0;
export const validTranslation = (value, source) => Array.isArray(value) && value.length === source.length && source.every((text, i) => typeof value[i] === "string" && (!hasText(text) || hasText(value[i])));
export function byteLength(value) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 128) bytes++;
		else if (c < 2048) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
		else bytes += 3;
	}
	return bytes;
}
function object(value) {
	try { if (typeof value === "string") value = JSON.parse(value); } catch { return {}; }
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export default class SubtitleCache {
	constructor(store, { limit = 100, maxBytes = 12 * 1024 * 1024 } = {}) {
		this.store = store;
		this.limit = Math.max(1, Math.min(500, Number(limit) || 100));
		this.maxBytes = maxBytes;
	}
	readMap() {
		let value = this.store.getItem(CACHE, []);
		try { if (typeof value === "string") value = JSON.parse(value); } catch { value = []; }
		try { return value instanceof Map ? new Map(value) : new Map(Array.isArray(value) ? value : []); } catch { return new Map(); }
	}
	get(key, source, aliases = []) {
		const cache = this.readMap();
		for (const candidate of [key, ...aliases]) {
			const value = cache.get(candidate);
			if (!validTranslation(value, source)) continue;
			if (candidate !== key) this.set(key, value, [candidate]);
			else this.touch(key);
			return value;
		}
		return null;
	}
	touch(key) {
		const access = object(this.store.getItem(ACCESS, {}));
		access.clock = Math.max(Date.now(), Number(access.clock || 0) + 1);
		access.entries = object(access.entries);
		access.entries[key] = access.clock;
		this.store.setItem(ACCESS, access);
	}
	set(key, value, aliases = []) {
		// An oversized new entry must not evict every other movie.
		if (byteLength([[key, value]]) > this.maxBytes) return { verified: false, reason: "oversize", size: this.readMap().size };
		const latest = this.readMap();
		for (const alias of aliases) latest.delete(alias);
		latest.delete(key);
		latest.set(key, value);
		this.touch(key);
		const access = object(this.store.getItem(ACCESS, {}));
		const times = object(access.entries);
		const rows = [...latest].map(([id, text], index) => ({ id, text, time: Number(times[id]) || index, bytes: byteLength([id, text]) + 1 }));
		rows.sort((a, b) => a.time - b.time);
		let bytes = rows.reduce((sum, row) => sum + row.bytes, 2);
		while (rows.length > this.limit || bytes > this.maxBytes) bytes -= rows.shift().bytes;
		const serialized = rows.map(row => [row.id, row.text]);
		const written = this.store.setItem(CACHE, serialized);
		access.entries = Object.fromEntries(rows.map(row => [row.id, times[row.id] || row.time]));
		this.store.setItem(ACCESS, access);
		const saved = this.readMap().get(key);
		return { verified: Boolean(written) && Array.isArray(saved) && JSON.stringify(saved) === JSON.stringify(value), size: rows.length };
	}
	progress(key, part) {
		const all = object(this.store.getItem(PROGRESS, {}));
		const entry = all[key];
		if (!entry || Date.now() - Number(entry.updatedAt || 0) > DAY) return undefined;
		return entry.parts?.[part];
	}
	saveProgress(key, part, value) {
		if (!Array.isArray(value) || !value.some(hasText)) return;
		const all = object(this.store.getItem(PROGRESS, {}));
		const entry = object(all[key]);
		entry.parts = object(entry.parts);
		entry.parts[part] = value;
		entry.updatedAt = Date.now();
		all[key] = entry;
		const rows = Object.entries(all).filter(([, v]) => Date.now() - Number(v?.updatedAt || 0) <= DAY).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
		while (rows.length > 8 || byteLength(Object.fromEntries(rows)) > 4 * 1024 * 1024) rows.shift();
		this.store.setItem(PROGRESS, Object.fromEntries(rows));
	}
	clearProgress(key) {
		const all = object(this.store.getItem(PROGRESS, {}));
		delete all[key];
		this.store.setItem(PROGRESS, all);
	}
}
