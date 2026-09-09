/**
 * Applying config changes to a RUNNING router, in place.
 *
 * The rule that makes live reconfiguration possible: every block object keeps
 * its identity. Consumers hold references into the config — the Ollama client
 * binds `cfg.ollama`, the OpenRouter client reads `cfg.openrouter.apiKey` per
 * request — so a change must be written INTO those objects, never by replacing
 * them. Assigning `cfg.ollama = next` would leave every holder on the old
 * object, which is exactly why those blocks used to be restart-only.
 *
 * Arrays are replaced wholesale: they are read through their parent
 * (`cfg.filters.allow`) rather than captured, and element-wise patching would
 * make a shorter list impossible to express.
 */

import type { RouterConfig } from "./types.ts";
import { completeUpstreams } from "./upstreams.ts";
import type { DeepPartial } from "./load.ts";

type Rec = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Writes `source` into `target`, keeping every existing object's identity, and
 * returns the dotted paths whose value actually changed. Keys absent from
 * `source` are left alone, so this works for both a full config (a file reload)
 * and a patch (one dashboard setting).
 */
export function assignInPlace(target: Rec, source: Rec, prefix = "", opts: { prune?: boolean } = {}): string[] {
	const changed: string[] = [];
	// A whole-config apply (a file reload) must mirror a restart: a knob deleted
	// from the file goes away rather than lingering at its last live value. A
	// patch (one setting from a dashboard) touches only what it names.
	if (opts.prune === true) {
		for (const key of Object.keys(target)) {
			if (key in source) continue;
			delete target[key];
			changed.push(prefix === "" ? key : `${prefix}.${key}`);
		}
	}
	for (const key of Object.keys(source)) {
		const path = prefix === "" ? key : `${prefix}.${key}`;
		const next = source[key];
		const current = target[key];
		if (isPlainObject(next) && isPlainObject(current)) {
			changed.push(...assignInPlace(current, next, path, opts));
			continue;
		}
		if (JSON.stringify(current) === JSON.stringify(next)) continue;
		// A fresh object (or array) is cloned in, so the caller's patch cannot
		// alias live config and mutate it from outside later.
		target[key] = isPlainObject(next) || Array.isArray(next) ? structuredClone(next) : next;
		changed.push(path);
	}
	return changed;
}

/** `assignInPlace` over a typed config. Returns the dotted paths that changed. */
export function applyConfigPatch(live: RouterConfig, patch: DeepPartial<RouterConfig>): string[] {
	const changed = assignInPlace(live as unknown as Rec, patch as Rec);
	// A patched upstream list arrives sparse (what the author set); clients read complete records.
	if (changed.some((c) => c === "upstreams" || c.startsWith("upstreams."))) completeUpstreams(live);
	return changed;
}

/** True when any changed path falls inside `block` (`"ollama"` matches `ollama.apiKey`). */
export function touched(changed: readonly string[], ...blocks: readonly string[]): boolean {
	return changed.some((c) => blocks.some((b) => c === b || c.startsWith(`${b}.`)));
}
