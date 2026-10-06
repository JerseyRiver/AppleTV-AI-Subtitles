import { URLSearchParams } from "./URLSearchParams.mjs";
export class URL {
    constructor(url, base) {
        switch (typeof url) {
            case "string": {
                const urlIsValid = /^(blob:|file:)?[a-zA-z]+:\/\/.*/.test(url);
                const baseIsValid = base ? /^(blob:|file:)?[a-zA-z]+:\/\/.*/.test(base) : false;
                // If a string is passed for url instead of location or link, then set the properties of the URL instance.
                if (urlIsValid)
                    this.href = url;
                // If the url isn't valid, but the base is, then prepend the base to the url.
                else if (baseIsValid)
                    this.href = base + url;
                // If no valid url or base is given, then throw a type error.
                else
                    throw new TypeError('URL string is not valid. If using a relative url, a second argument needs to be passed representing the base URL. Example: new URL("relative/path", "http://www.example.com");');
                break;
            }
            case "object":
                break;
            default:
                throw new TypeError("Invalid argument type.");
        }
    }
    #url = {
        hash: "",
        host: "",
        hostname: "",
        href: "",
        password: "",
        pathname: "",
        port: Number.NaN,
        protocol: "",
        search: "",
        searchParams: new URLSearchParams(""),
        username: "",
    };
    // refer: http://www.ietf.org/rfc/rfc3986.txt
    static #URLRegExp = /^(?<scheme>([^:\/?#]+):)?(?:\/\/(?<authority>[^\/?#]*))?(?<path>[^?#]*)(?<query>\?([^#]*))?(?<hash>#(.*))?$/;
    static #AuthorityRegExp = /^(?<authentication>(?<username>[^:]*)(:(?<password>[^@]*))?@)?(?<hostname>[^:]+)(:(?<port>\d+))?$/;
    get hash() {
        return this.#url.hash;
    }
    set hash(value) {
        if (value.length !== 0) {
            if (value.startsWith("#"))
                value = value.slice(1);
            this.#url.hash = `#${encodeURIComponent(value)}`;
        }
    }
    get host() {
        return this.port.length > 0 ? `${this.hostname}:${this.port}` : this.hostname;
    }
    set host(value) {
        [this.hostname, this.port] = value.split(":", 2);
    }
    get hostname() {
        return encodeURIComponent(this.#url.hostname);
    }
    set hostname(value) {
        this.#url.hostname = value ?? "";
    }
    get href() {
        let authority = "";
        if (this.username.length > 0) {
            authority += this.username;
            if (this.password.length > 0)
                authority += `:${this.password}`;
            authority += "@";
        }
        return `${this.protocol}//${authority}${this.host}${this.pathname}${this.search}${this.hash}`;
    }
    set href(value) {
        if (value.startsWith("blob:") || value.startsWith("file:"))
            value = value.slice(5);
        const urlMatch = value.match(URL.#URLRegExp);
        if (!urlMatch)
            throw new TypeError("Invalid URL format.");
        this.protocol = urlMatch.groups.scheme ?? "";
        const authorityMatch = urlMatch.groups.authority.match(URL.#AuthorityRegExp);
        this.username = authorityMatch.groups.username ?? "";
        this.password = authorityMatch.groups.password ?? "";
        this.hostname = authorityMatch.groups.hostname ?? "";
        this.port = authorityMatch.groups.port ?? "";
        this.pathname = urlMatch.groups.path ?? "";
        this.search = urlMatch.groups.query ?? "";
        this.hash = urlMatch.groups.hash ?? "";
    }
    get origin() {
        return `${this.protocol}//${this.host}`;
    }
    get password() {
        return encodeURIComponent(this.#url.password);
    }
    set password(value) {
        if (this.username.length > 0)
            this.#url.password = value ?? "";
    }
    get pathname() {
        return `/${this.#url.pathname}`;
    }
    set pathname(value) {
        value = `${value}`;
        if (value.startsWith("/"))
            value = value.slice(1);
        this.#url.pathname = value;
    }
    get port() {
        if (Number.isNaN(this.#url.port))
            return "";
        const port = this.#url.port.toString();
        if (this.protocol === "ftp:" && port === "21")
            return "";
        if (this.protocol === "http:" && port === "80")
            return "";
        if (this.protocol === "https:" && port === "443")
            return "";
        return port;
    }
    set port(value) {
        switch (value) {
            case "":
                this.#url.port = Number.NaN;
                break;
            default: {
                const port = Number.parseInt(value, 10);
                if (port >= 0 && port < 65535)
                    this.#url.port = port;
            }
        }
    }
    get protocol() {
        return `${this.#url.protocol}:`;
    }
    set protocol(value) {
        if (value.endsWith(":"))
            value = value.slice(0, -1);
        this.#url.protocol = value;
    }
    get search() {
        this.#url.search = this.searchParams.toString();
        if (this.#url.search.length > 0)
            return `?${this.#url.search}`;
        else
            return "";
    }
    set search(value) {
        value = `${value}`;
        if (value.startsWith("?"))
            value = value.slice(1);
        this.#url.search = value;
        this.#url.searchParams = new URLSearchParams(this.#url.search);
    }
    get searchParams() {
        return this.#url.searchParams;
    }
    get username() {
        return encodeURIComponent(this.#url.username);
    }
    set username(value) {
        this.#url.username = value ?? "";
    }
    static parse = (url, base) => new URL(url, base);
    /**
     * Returns the string representation of the URL.
     *
     * @returns {string} The href of the URL.
     */
    toString = () => this.href;
    /**
     * Converts the URL object properties to a JSON string.
     *
     * @returns {string} A JSON string representation of the URL object.
     */
    toJSON = () => JSON.stringify({
        hash: this.hash,
        host: this.host,
        hostname: this.hostname,
        href: this.href,
        origin: this.origin,
        password: this.password,
        pathname: this.pathname,
        port: this.port,
        protocol: this.protocol,
        search: this.search,
        searchParams: this.searchParams,
        username: this.username,
    });
}
