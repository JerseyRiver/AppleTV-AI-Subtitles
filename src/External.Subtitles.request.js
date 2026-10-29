// Copyright 2026 JerseyRiver. GPL-3.0-only.
import { Storage } from "@nsnanocat/util";
import { URL } from "@nsnanocat/url";
import Retranslate from "./function/retranslate.mjs";

// Loon request-script response API: https://nsloon.app/docs/Script/script_api/
// This local route never contacts Apple. Redirects preserve the gateway's
// playlist base URL, so its relative VTT links continue to resolve correctly.
let result;
try {
	const url = new URL($request.url);
	const asset = url.pathname.match(/^\/dualsubs-external\/apple\/(\d{4,20})\/playlist\.m3u8$/)?.[1];
	if (url.hostname !== "hls.itunes.apple.com" || !asset) throw new Error("Invalid local subtitle route");
	const args = typeof $argument === "object" && $argument ? $argument : {};
	const gateway = String(args.GatewayURL || "").trim().replace(/\/+$/, "");
	if (!/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/v1\/[a-z0-9_-]{8,}$/i.test(gateway)) throw new Error("Missing gateway");
	const retry = new Retranslate(Storage, args.RetranslateNext, args.RetranslateRequest);
	// Do not trust a token advertised by an earlier/preloaded master playlist.
	const token = retry.select(`apple:${asset}`);
	const fields = ["title", "year", "duration", "type", "season", "episode", "discontinuity", "frame_rate", "gateway_version"]
		.map(key => [key, url.searchParams.get(key)])
		.filter(([, value]) => value !== undefined && value !== null && value !== "");
	fields.push(["subtype", "External"]);
	if (token) fields.push(["retry", token]);
	const query = fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
	result = { response: { status: 302, headers: { Location: `${gateway}/apple/${asset}/playlist.m3u8?${query}`, "Cache-Control": "no-store" }, body: "" } };
} catch {
	// Never send the synthetic path upstream or print gateway credentials.
	result = { response: { status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }, body: "外部字幕入口暂不可用，请检查插件参数。" } };
}
$done(result);
