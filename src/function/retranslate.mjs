// Copyright 2026 JerseyRiver. GPL-3.0-only.
import MD5 from "crypto-js/md5.js";

const KEY = "AppleTVAI.Retranslate.v1";
const validFilm = value => typeof value === "string" && /^(apple:\d{4,20}|source:[a-f0-9]{32})$/.test(value);
export const validRetry = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

export default class Retranslate {
	constructor(store, enabled, request = "1") {
		this.store = store;
		this.enabled = enabled === true || enabled === "true";
		this.request = String(request || "1").slice(0, 64);
		const state = this.read();
		if (!this.enabled) {
			if (state.enabled || state.pending) {
				state.enabled = false;
				delete state.pending;
				this.write(state);
			}
		} else if (!state.enabled || state.request !== this.request) {
			state.enabled = true;
			state.request = this.request;
			state.pending = MD5(`${Date.now()}|${Math.random()}|${this.request}`).toString();
			this.write(state);
		}
	}
	read() {
		let state = this.store.getItem(KEY, {});
		try { if (typeof state === "string") state = JSON.parse(state); } catch { state = {}; }
		if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
		if (!state.films || typeof state.films !== "object" || Array.isArray(state.films)) state.films = {};
		return state;
	}
	write(state) {
		if (!this.store.setItem(KEY, state)) throw new Error("重译操作状态保存失败；为避免重复消耗，未执行重译");
	}
	preview(film) {
		if (!validFilm(film)) return "";
		const state = this.read();
		// Change the advertised URL to bypass player caches, but do not bind the
		// action to a title until the generated subtitle is actually requested.
		if (this.enabled && state.enabled && state.request === this.request && validRetry(state.pending)) return state.pending;
		return this.select(film, false);
	}
	select(film, consume = true) {
		if (!validFilm(film)) return "";
		const state = this.read();
		if (consume && this.enabled && state.enabled && state.request === this.request && validRetry(state.pending)) {
			state.films[film] = state.pending;
			delete state.pending;
			this.write(state);
		}
		return validRetry(state.films[film]) ? state.films[film] : "";
	}
}

export function filmFromURL(url, fallback = "") {
	const tagged = url.searchParams?.get("dsfilm");
	if (validFilm(tagged)) return tagged;
	const asset = url.searchParams?.get("mainAssetAdamId") || url.searchParams?.get("a");
	if (/^\d{4,20}$/.test(asset || "")) return `apple:${asset}`;
	// Fallback excludes CDN hosts and signed queries. Normal paths are tagged at the master.
	const path = fallback ? fallback.replace(/^https?:\/\/[^/]+/i, "").split("?")[0] : url.pathname || String(url).split("?")[0];
	return `source:${MD5(path).toString()}`;
}
