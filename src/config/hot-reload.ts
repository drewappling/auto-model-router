/**
 * Hot reload for `config.yml`.
 *
 * The router is long-lived (an omp session embeds it), and the ranking knobs —
 * tiers, filters, escalation, budgets, hysteresis — are exactly what a tuning
 * session wants to change without restarting the harness. This module watches
 * the config file, re-validates it through the same schema `loadConfig` uses,
 * and mutates the SHARED config object in place.
 *
 * In-place mutation is the design: every consumer reads `cfg.tiers`,
 * `cfg.filters`, `cfg.escalation` … at call time through the same object
 * reference, so field assignment makes every per-turn read live with zero
 * call-site changes. What is deliberately NOT reloaded is anything captured at
 * construction — the listening socket (server.*), the OpenRouter client
 * (openrouter.*), and the agentdox bridge (context.*). Those still require a
 * restart; the watcher re-pinns them from the live object and reports skips.
 *
 * Safety properties:
 *  - Schema validation BEFORE any mutation; an invalid file leaves the running
 *    config untouched and logs the zod issues, exactly like loadConfig.
 *  - fs.watch fires several times per save; a trailing debounce collapses them.
 *  - A half-written or invalid file never throws into the watcher: the reload
 *    is skipped and the previous config keeps serving.
 *  - A deleted or emptied knob reverts to its DEFAULT, mirroring loadConfig's
 *    merge order (defaults <- file): the file is the source of truth, so
 *    disabling a feature by deleting its key works.
 */

import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { parse as parseYaml } from "yaml";
import { configInputSchema } from "./schema.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { deepMerge, resolveTilde } from "./load.ts";
import type { RouterConfig } from "./types.ts";

/** Milliseconds of quiet after the last fs event before a reload actually runs. */
const DEBOUNCE_MS = 250;

/** The validated file input, or why it could not be used. */
export type ConfigRead =
	| { ok: true; cfg: RouterConfig }
	| { ok: false; error: string };

/**
 * Re-reads and schema-validates the config file. Exported for tests: this is
 * the exact gate a file must pass before it may touch the running config.
 *
 * The result is merged over DEFAULT_CONFIG — the file is the full source of
 * truth, so a knob REMOVED from the file reverts to its default, matching what
 * a restart would do. `server`/`openrouter`/`context` come back too, but the
 * applier re-pinns those blocks from the live object, since they were captured
 * by construction.
 */
export function readValidatedConfig(path: string): ConfigRead {
	try {
		if (!existsSync(path)) return { ok: false, error: "file missing" };
		const raw: unknown = parseYaml(readFileSync(path, "utf8"));
		if (raw === null || raw === undefined) return { ok: false, error: "file empty" };
		const parsed = configInputSchema.safeParse(raw);
		if (!parsed.success) {
			const lines = parsed.error.issues
				.slice(0, 5)
				.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
				.join("\n");
			return { ok: false, error: `schema validation failed:\n${lines}` };
		}
		return { ok: true, cfg: deepMerge(DEFAULT_CONFIG, parsed.data) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** What changed in a reload, for logging. */
export interface ReloadSummary {
	changed: string[];
}

/** A live config file watcher. */
export interface ConfigWatcher {
	/** Stops watching. Idempotent. */
	close(): void;
}

/** Options for watchConfig. */
export interface WatchConfigOptions {
	/** Called after a successful in-place reload that changed something. */
	onReload?: (summary: ReloadSummary) => void;
	/** Called when a file could not be applied (invalid, unreadable). */
	onError?: (message: string) => void;
}

/**
 * Watches `path` and applies valid changes to `live` in place. `frozen` blocks
 * (top-level names) are re-copied from `pinned` after every reload so file
 * edits to construction-captured blocks cannot silently diverge.
 */
export function watchConfig(
	path: string,
	live: RouterConfig,
	pinned: RouterConfig,
	frozen: readonly (keyof RouterConfig)[],
	opts: WatchConfigOptions = {},
): ConfigWatcher {
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastError = "";

	const apply = (): void => {
		if (closed) return;
		const result = readValidatedConfig(path);
		if (!result.ok) {
			// A half-written file is normal (editors truncate-then-write): stay on
			// the current config. Report each distinct error once.
			if (result.error !== lastError) {
				lastError = result.error;
				opts.onError?.(result.error);
			}
			return;
		}
		lastError = "";

		const frozenSet = new Set(frozen);
		const changed: string[] = [];
		const next = result.cfg as unknown as Record<string, unknown>;
		for (const key of Object.keys(next)) {
			// Frozen blocks belong to construction: keep the pinned values.
			const value = frozenSet.has(key as keyof RouterConfig)
				? (pinned as unknown as Record<string, unknown>)[key]
				: next[key];
			const before = JSON.stringify((live as unknown as Record<string, unknown>)[key]);
			const after = JSON.stringify(value);
			if (before !== after) changed.push(key);
			(live as unknown as Record<string, unknown>)[key] = value;
		}
		if (changed.length > 0) opts.onReload?.({ changed });
	};

	const schedule = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			apply();
		}, DEBOUNCE_MS);
	};

	let watcher: FSWatcher | null = null;
	try {
		watcher = watch(resolveTilde(path), { persistent: false }, schedule);
	} catch {
		// Unwatchable file is not fatal: the router keeps its boot config.
	}

	return {
		close() {
			closed = true;
			clearTimeout(timer);
			timer = undefined;
			watcher?.close();
			watcher = null;
		},
	};
}

