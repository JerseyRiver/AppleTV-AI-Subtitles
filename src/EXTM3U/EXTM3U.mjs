// refer: https://datatracker.ietf.org/doc/html/draft-pantos-http-live-streaming-08
export default class EXTM3U {
	static name = "EXTM3U";
	static version = "0.8.8";
	static about = () => console.log(`\n🟧 ${this.name} v${this.version}\n`);
	static #EXTM3URegex = /^(?:(?<TAG>#(?:EXT|AIV)[^#:\s\r\n]+)(?::(?<OPTION>[^\r\n]+))?(?:(?:\r\n|\r|\n)(?<URI>[^#\s\r\n]+))?|(?<NOTE>#[^\r\n]+)?)(?:\r\n|\r|\n)?$/gm;
	static #OPTIONValueRegex = /^((-?\d+[x.\d]+)|[0-9A-Z-]+)$/;

	static parse(m3u8 = new String) {
		let json = [...m3u8.matchAll(this.#EXTM3URegex)].map(item => {
			item = item?.groups || item;
			if (/=/.test(item?.OPTION)) item.OPTION = Object.fromEntries(`${item.OPTION}\,`.split(/,\s*(?![^"]*",)/).slice(0, -1).map(option => {
				option = option.split(/=(.*)/);
				option[1] = (isNaN(option[1])) ? option[1].replace(/^"(.*)"$/, "$1") : parseFloat(option[1]);
				return option;
			}));
			return item
		});
		return json;
	};

	static stringify(json = new Array, options = { lineBreak: "\n" }) {
		if (json?.[0]?.TAG !== "#EXTM3U") json.unshift({ "TAG": "#EXTM3U" })
		let m3u8 = json.map(item => {
			if (typeof item?.OPTION === "object") item.OPTION = Object.entries(item.OPTION).map(option => {
				if (item?.TAG === "#EXT-X-SESSION-DATA") option[1] = `"${option[1]}"`;
				else if (!isNaN(option[1])) option[1] = (typeof option[1] === "number") ? option[1] : `"${option[1]}"`;
				else if (option[0] === "ID" || option[0] === "INSTREAM-ID" || option[0] === "KEYFORMAT") option[1] = `"${option[1]}"`;
				else if (!this.#OPTIONValueRegex.test(option[1])) option[1] = `"${option[1]}"`;
				return option.join("=");
			}).join(",");
			return item = (item?.URI) ? item.TAG + ":" + item.OPTION + options.lineBreak + item.URI
				: (item?.OPTION) ? item.TAG + ":" + item.OPTION
					: (item?.TAG) ? item.TAG
						: (item?.NOTE) ? item.NOTE
							: "";
		}).join(options.lineBreak);
		return m3u8;
	};
};
