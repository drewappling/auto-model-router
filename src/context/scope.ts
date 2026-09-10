/**
 * The agentdox scope a request names, and where omp's main model gets it from.
 *
 * omp resolves its MAIN model from `models.yml` at startup, before any extension
 * loads, so the `X-Agentdox-Scope` header on that provider entry cannot be set
 * by the extension per workspace — but omp resolves a header VALUE that names
 * an environment variable from the environment on every request, and the
 * extension runs inside omp's process. So `connect` (and the local sync) write
 * the header's value as the NAME below, and the extension sets that variable
 * from the workspace folder when it loads. One machine-wide file, one scope
 * per repository.
 */
export const SCOPE_ENV = "AUTO_MODEL_ROUTER_SCOPE";

/**
 * A scope is an agentdox project slug: lowercase, starting alphanumeric. The
 * shape matters because omp sends the header's literal value when the variable
 * it names is unset — `AUTO_MODEL_ROUTER_SCOPE` itself — and that must never
 * become a project. Uppercase never passes, so the sentinel cannot.
 */
export function isScopeSlug(value: string): boolean {
	return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

/** The scope to trust from a request header: a slug, or "" for anything else. */
export function acceptScope(raw: string | null | undefined): string {
	const s = (raw ?? "").trim();
	return isScopeSlug(s) ? s : "";
}

/**
 * The workspace's ORIGIN travels the same road as the scope: `connect` and
 * `config --write` put this NAME in the managed provider entry, the embed
 * extension sets the variable from the workspace's git remote as it loads, and
 * omp resolves it per request. Where the scope names a FOLDER, the origin
 * names the REPOSITORY, so a front door with a project registry (the team
 * edition) can tell two unrelated `api` folders apart and recognise one repo
 * cloned into two differently named folders. A router on its own has no such
 * registry and ignores it.
 */
export const ORIGIN_ENV = "AUTO_MODEL_ROUTER_ORIGIN";

/**
 * A repository fingerprint: `<host>/<path>` — lowercase, no scheme, no
 * credentials, no port, no trailing `.git`, no trailing slash — so the same
 * repository cloned over https and over ssh yields one value. Uppercase never
 * passes, so `ORIGIN_ENV` itself, which omp sends verbatim when the variable is
 * unset, can never become a fingerprint.
 */
export function isOrigin(value: string): boolean {
	return /^[a-z0-9][a-z0-9.-]{0,127}(\/[a-z0-9._~-]{1,64}){1,8}$/.test(value);
}

/**
 * Reduces a git remote URL to its fingerprint, or "" when it names no host —
 * a local path (`/srv/repo`, `C:\repo`) or `file://` — or does not reduce to a
 * valid origin. Every form git accepts for `origin` is covered: `scheme://`
 * with optional credentials and port, and the scp-like `[user@]host:path`.
 */
export function normalizeOrigin(url: string): string {
	const raw = url.trim();
	let host: string;
	let path: string;
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
	if (scheme !== null) {
		if (scheme[1]!.toLowerCase() === "file") return "";
		const rest = raw.slice(scheme[0].length);
		const slash = rest.search(/[/\\]/);
		host = slash < 0 ? rest : rest.slice(0, slash);
		path = slash < 0 ? "" : rest.slice(slash + 1);
	} else {
		// scp-like `[user@]host:path`. A Windows drive (`C:\repo`, `C:/repo`)
		// has the same shape with a one-letter "host" and is a local path.
		const scp = /^(?:[^@/\\:]+@)?([^/\\:]+):(.*)$/.exec(raw);
		if (scp === null || /^[a-z]$/i.test(scp[1]!)) return "";
		host = scp[1]!;
		path = scp[2]!;
	}
	// Credentials first (a password may contain digits and a colon), then the port.
	host = host.slice(host.lastIndexOf("@") + 1).replace(/:\d+$/, "");
	const segments = path.split(/[/\\]/).filter((s) => s !== "");
	const last = segments.length - 1;
	if (last >= 0) segments[last] = segments[last]!.replace(/\.git$/i, "");
	const value = [host, ...segments.filter((s) => s !== "")].join("/").toLowerCase();
	return isOrigin(value) ? value : "";
}

/** The origin to trust from a request header: a fingerprint, or "" for anything else. */
export function acceptOrigin(raw: string | null | undefined): string {
	const s = (raw ?? "").trim();
	return isOrigin(s) ? s : "";
}
