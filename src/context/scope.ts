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
