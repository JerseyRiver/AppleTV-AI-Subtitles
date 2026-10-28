import { Console, getStorage, Lodash as _ } from "@nsnanocat/util";

/**
 * Set Environment Variables
 * @author VirgilClyne
 * @param {String} name - Persistent Store Key
 * @param {Array} platforms - Platform Names
 * @param {Object} database - Default DataBase
 * @return {Object} { Settings, Caches, Configs }
 */
export default function setENV(name, platforms, database) {
	Console.log("☑️ Set Environment Variables");
	const { Settings, Caches, Configs } = getStorage(name, platforms, database);
	/***************** Settings *****************/
	if (!Array.isArray(Settings?.Types)) Settings.Types = Settings.Types ? [Settings.Types] : []; // 只有一个选项时，无逗号分隔
	// Modified by JerseyRiver: settings can contain credentials. Never log the full object.
	Console.info(`typeof Settings: ${typeof Settings}`);
	/***************** Caches *****************/
	if (typeof Caches?.Playlists !== "object" || Array.isArray(Caches?.Playlists)) Caches.Playlists = {}; // 创建Playlists缓存
	Caches.Playlists.Master = cacheMap(Caches?.Playlists?.Master);
	Caches.Playlists.Subtitle = cacheMap(Caches?.Playlists?.Subtitle);
	Caches.Subtitles = cacheMap(Caches?.Subtitles);
	if (typeof Caches?.Metadatas !== "object" || Array.isArray(Caches?.Metadatas)) Caches.Metadatas = {}; // 创建Playlists缓存
	Caches.Metadatas.Tracks = cacheMap(Caches?.Metadatas?.Tracks);
	//Console.debug(`typeof Caches: ${typeof Caches}`, `Caches: ${JSON.stringify(Caches, null, 2)}`);
	/***************** Configs *****************/
	Console.log("✅ Set Environment Variables");
	return { Settings, Caches, Configs };
}

function cacheMap(value) {
	try {
		if (value instanceof Map) return value;
		if (typeof value === "string") value = JSON.parse(value);
		return new Map(Array.isArray(value) ? value.filter(item => Array.isArray(item) && item.length === 2) : []);
	} catch { return new Map(); }
}
