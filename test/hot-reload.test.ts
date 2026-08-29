import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { readValidatedConfig, watchConfig, type ConfigWatcher } from "../src/config/hot-reload.ts";

const DIR = join(import.meta.dir, ".tmp-hot-reload");
const CFG = join(DIR, "config.yml");

beforeAll(() => {
	rmSync(DIR, { recursive: true, force: true });
	mkdirSync(DIR, { recursive: true });
});
afterAll(() => {
	rmSync(DIR, { recursive: true, force: true });
});

/** A clone of the shipped defaults serialized as YAML via JSON (the schema accepts JSON). */
function yamlOf(partial: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [k, v] of Object.entries(partial)) {
		if (typeof v === "object" && v !== null) {
			lines.push(`${k}:`);
			for (const [k2, v2] of Object.entries(v)) {
				lines.push(`  ${k2}: ${JSON.stringify(v2).replaceAll('"', v2 === true || v2 === false || typeof v2 === "number" ? "" : '"')}`);
			}
		} else {
			lines.push(`${k}: ${JSON.stringify(v)}`);
		}
	}
	return lines.join("\n");
}

/** Waits out the watcher's debounce. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

describe("readValidatedConfig", () => {
	test("accepts a valid partial and merges over defaults (removed knobs revert)", () => {
		writeFileSync(CFG, yamlOf({ filters: { latencyWeight: 0.5 } }));
		const result = readValidatedConfig(CFG);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.cfg.filters.latencyWeight).toBe(0.5);
		// Untouched knobs carry the shipped default, not garbage.
		expect(result.cfg.filters.contextHeadroom).toBe(DEFAULT_CONFIG.filters.contextHeadroom);
		// A tier not mentioned in the file keeps its default shape.
		expect(result.cfg.tiers.simple).toEqual(DEFAULT_CONFIG.tiers.simple);
	});

	test("rejects a schema violation and names the path", () => {
		writeFileSync(CFG, yamlOf({ tiers: { hard: { capabilityFloorUsd: -5 } } }));
		const result = readValidatedConfig(CFG);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("capabilityFloorUsd");
	});

	test("rejects malformed YAML", () => {
		writeFileSync(CFG, "filters: [unclosed");
		const result = readValidatedConfig(CFG);
		expect(result.ok).toBe(false);
	});

	test("reports a missing file", () => {
		const result = readValidatedConfig(join(DIR, "nope.yml"));
		expect(result.ok).toBe(false);
	});
});

describe("watchConfig", () => {
	const live: RouterConfig = structuredClone(DEFAULT_CONFIG);
	let watcher: ConfigWatcher | null = null;
	const reloads: string[][] = [];
	const errors: string[] = [];

	beforeAll(() => {
		writeFileSync(CFG, "");
		watcher = watchConfig(CFG, live, structuredClone(DEFAULT_CONFIG), ["server", "openrouter", "context", "ledger"], {
			onReload: ({ changed }) => reloads.push(changed),
			onError: (message) => errors.push(message),
		});
	});
	afterAll(() => watcher?.close());

	test("a valid edit mutates the live object in place, no restart", async () => {
		writeFileSync(CFG, yamlOf({ tiers: { hard: { capabilityFloorUsd: 0.35 } } }));
		await settle();
		expect(live.tiers.hard.capabilityFloorUsd).toBe(0.35);
		expect(reloads.flat()).toContain("tiers");
	});

	test("a second edit replaces the value and reverting restores the default", async () => {
		writeFileSync(CFG, yamlOf({ tiers: { hard: { capabilityFloorUsd: 0.65 } } }));
		await settle();
		expect(live.tiers.hard.capabilityFloorUsd).toBe(0.65);
		// Deleting the knob reverts to the shipped default, mirroring a restart.
		writeFileSync(CFG, yamlOf({ filters: { latencyWeight: 0.4 } }));
		await settle();
		expect(live.tiers.hard.capabilityFloorUsd).toBeUndefined();
		expect(live.filters.latencyWeight).toBe(0.4);
	});

	test("frozen blocks are pinned: file edits to them cannot reach the live object", async () => {
		writeFileSync(CFG, yamlOf({ server: { port: 1, host: "10.9.9.9" }, filters: { latencyWeight: 0.3 } }));
		await settle();
		expect(live.server.port).toBe(DEFAULT_CONFIG.server.port);
		expect(live.server.host).toBe(DEFAULT_CONFIG.server.host);
		// The non-frozen sibling still applied.
		expect(live.filters.latencyWeight).toBe(0.3);
	});

	test("an invalid file is rejected and the running config keeps serving", async () => {
		const before = structuredClone(live.filters);
		const tierBefore = structuredClone(live.tiers.hard);
		// capabilityFloorUsd must be strictly positive: -1 is a schema violation.
		writeFileSync(CFG, yamlOf({ tiers: { hard: { capabilityFloorUsd: -1 } } }));
		await settle();
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.at(-1)).toContain("capabilityFloorUsd");
		// The live object keeps the last-good values.
		expect(live.tiers.hard.capabilityFloorUsd).toBe(tierBefore.capabilityFloorUsd);
		expect(live.filters.latencyWeight).toBe(before.latencyWeight);
	});
	test("close() stops watching: later edits are ignored", async () => {
		watcher?.close();
		writeFileSync(CFG, yamlOf({ filters: { latencyWeight: 9.9 } }));
		await settle();
		expect(live.filters.latencyWeight).not.toBe(9.9);
	});
});
