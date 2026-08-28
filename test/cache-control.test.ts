import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { priceAt } from "../src/cost/forecast.ts";
import { planCacheBreakpoints } from "../src/router/cache-control.ts";
import { planCompaction } from "../src/router/compaction.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";
import type { NormRequest } from "../src/wire/types.ts";

const FIXTURE = (await Bun.file("test/fixtures/openrouter-models.json").json()) as { data: unknown[] };
const MODELS: CatalogModel[] = FIXTURE.data.map(normalizeCatalogModel).filter((m): m is CatalogModel => m !== null);
// Breakpoints are only planned for models that publish a cache-read price.
const CACHING = MODELS.find((m) => priceAt(m, 100_000).cacheRead !== undefined);
if (CACHING === undefined) throw new Error("fixture has no model with a published cache-read price");
const MODEL: CatalogModel = CACHING;

const BASE = loadConfig({});
function cfg(over: Partial<RouterConfig["cache"]> = {}): RouterConfig {
	return { ...BASE, cache: { ...BASE.cache, ...over } };
}

const RESULT_BYTES = 8_000;
const result = (turn: number): string => `result ${turn}:${"x".repeat(RESULT_BYTES)}`;

/** A tool-loop conversation: system, one user ask, then `turns` call/result pairs. */
function loop(turns: number): NormRequest {
	const messages: Record<string, unknown>[] = [
		{ role: "system", content: `You are a coding agent.${"!".repeat(4_000)}` },
		{ role: "user", content: "find the bug" },
	];
	for (let t = 0; t < turns; t++) {
		messages.push({
			role: "assistant",
			content: null,
			tool_calls: [{ id: `c${t}`, type: "function", function: { name: "read", arguments: `{"path":"f${t}.ts"}` } }],
		});
		messages.push({ role: "tool", tool_call_id: `c${t}`, content: result(t) });
	}
	return parseChatRequest({ model: "auto", messages }, new Headers());
}

describe("planCacheBreakpoints", () => {
	test("marks the tail so the next turn can read this turn's whole prompt", () => {
		const req = loop(12);
		const picks = planCacheBreakpoints(req, MODEL, cfg());
		expect(picks).toContain(req.messages.length - 1);
	});

	test("marks the system prefix", () => {
		const req = loop(12);
		const picks = planCacheBreakpoints(req, MODEL, cfg());
		expect(picks).toContain(0);
	});

	test("mid-history boundaries are stable as the conversation grows", () => {
		// Uncapped so the comparison is about placement, not slot eviction.
		const uncapped = cfg({ maxBreakpoints: 64, milestoneTokens: 4_000 });
		const mid = (turns: number): number[] => {
			const req = loop(turns);
			const tail = req.messages.length - 1;
			return planCacheBreakpoints(req, MODEL, uncapped).filter((i) => i !== 0 && i !== tail);
		};
		const early = mid(10);
		expect(early.length).toBeGreaterThan(1);
		for (const turns of [11, 12, 13, 20]) {
			// Every boundary the earlier turn wrote is still a boundary later, so
			// the later turn reads what the earlier one paid to write.
			expect(mid(turns)).toEqual(expect.arrayContaining(early));
		}
	});

	test("boundaries are spaced by the milestone size, not by message position", () => {
		const req = loop(30);
		const tail = req.messages.length - 1;
		const coarse = planCacheBreakpoints(req, MODEL, cfg({ maxBreakpoints: 64, milestoneTokens: 20_000 })).filter(
			(i) => i !== 0 && i !== tail,
		);
		const fine = planCacheBreakpoints(req, MODEL, cfg({ maxBreakpoints: 64, milestoneTokens: 4_000 })).filter(
			(i) => i !== 0 && i !== tail,
		);
		expect(fine.length).toBeGreaterThan(coarse.length);
	});

	test("keeps the system prefix and the tail when slots are scarce", () => {
		const req = loop(30);
		const picks = planCacheBreakpoints(req, MODEL, cfg({ maxBreakpoints: 2, milestoneTokens: 4_000 }));
		expect(picks).toEqual([0, req.messages.length - 1]);
	});

	test("milestones follow post-compaction sizes", () => {
		const req = loop(30);
		const tail = req.messages.length - 1;
		const plan = planCompaction(req.messages, BASE.compaction, req.promptBytes * 0.3, req.promptBytes);
		expect(plan.edits.length).toBeGreaterThan(0);
		const options = cfg({ maxBreakpoints: 64, milestoneTokens: 4_000 });
		const raw = planCacheBreakpoints(req, MODEL, options).filter((i) => i !== 0 && i !== tail);
		const compacted = planCacheBreakpoints(req, MODEL, options, plan.edits).filter((i) => i !== 0 && i !== tail);
		// Shrinking early results pushes each byte milestone later in the history.
		expect(compacted.length).toBeLessThan(raw.length);
		expect(Math.min(...compacted)).toBeGreaterThan(Math.min(...raw));
	});

	test("injects nothing below the minimum prompt size, or when disabled", () => {
		const small = parseChatRequest({ model: "auto", messages: [{ role: "user", content: "hi" }] }, new Headers());
		expect(planCacheBreakpoints(small, MODEL, cfg())).toEqual([]);
		expect(planCacheBreakpoints(loop(12), MODEL, cfg({ injectBreakpoints: false }))).toEqual([]);
	});
});
