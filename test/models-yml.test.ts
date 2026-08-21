import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

import { loadConfig } from "../src/config/load.ts";
import {
	BEGIN_GUARD,
	END_GUARD,
	assertUsableModelsYaml,
	renderProviderBlock,
	spliceProviderBlock,
} from "../src/cli/config-cmd.ts";

const cfg = loadConfig({});
const BLOCK = renderProviderBlock(cfg, null);

/** A models.yml with other providers, comments, and non-default indentation. */
const EXISTING = `providers:
    fastflowlm:
        api: openai-completions
        auth: none
        baseUrl: http://127.0.0.1:52625/v1
        models:
            # contextWindow must match FLM's runtime KV cache, NOT the
            # model's architectural limit.
            - contextWindow: 32768
              id: qwen3.6-moe:35b-a3b
              name: Qwen3.6 MoE 35B-A3B (NPU)
    ollama:
        api: openai-responses
        auth: none
        baseUrl: http://127.0.0.1:11434/v1
        discovery:
            type: ollama
`;

function providersOf(text: string): Record<string, unknown> {
	const parsed: unknown = parseYaml(text);
	if (typeof parsed !== "object" || parsed === null || !("providers" in parsed)) {
		throw new Error("no providers mapping");
	}
	const providers = parsed.providers;
	if (typeof providers !== "object" || providers === null) throw new Error("providers is not a mapping");
	return providers as Record<string, unknown>;
}

function countOf(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

describe("renderProviderBlock", () => {
	test("emits costs in USD per MILLION tokens, not per token", () => {
		const providers = providersOf(`providers:\n${BLOCK.split("\n").map((l) => (l === "" ? "" : `  ${l}`)).join("\n")}\n`);
		const router = providers["omp-router"];
		expect(typeof router).toBe("object");
		const parsed: unknown = parseYaml(BLOCK);
		expect(typeof parsed).toBe("object");
		// Fallback blend is dollars-per-million; a per-token figure would be ~1e-6.
		expect(cfg.ledger.fallbackBlend.inputPerMtok).toBeGreaterThan(0.01);
		expect(BLOCK).toContain(`input: ${cfg.ledger.fallbackBlend.inputPerMtok}`);
	});

	test("declares one model per configured profile", () => {
		for (const profile of cfg.profiles) expect(BLOCK).toContain(`id: ${profile.id}`);
	});

	test("advertises a keyless openai-compatible provider", () => {
		expect(BLOCK).toContain("api: openai-completions");
		expect(BLOCK).toContain("auth: none");
		expect(BLOCK).toContain("/v1");
	});
});

describe("spliceProviderBlock", () => {
	test("preserves every original line and comment", () => {
		const result = spliceProviderBlock(EXISTING, BLOCK);
		expect(result.action).toBe("inserted");
		const after = result.text.split("\n");
		for (const line of EXISTING.split("\n")) {
			if (line.trim() === "") continue;
			expect(after).toContain(line);
		}
		expect(result.text).toContain("# model's architectural limit.");
	});

	test("leaves the pre-existing providers intact and adds ours", () => {
		const result = spliceProviderBlock(EXISTING, BLOCK);
		const providers = providersOf(result.text);
		expect(Object.keys(providers).sort()).toEqual(["fastflowlm", "ollama", "omp-router"]);
	});

	test("is idempotent: a second run replaces rather than duplicates", () => {
		const once = spliceProviderBlock(EXISTING, BLOCK);
		const twice = spliceProviderBlock(once.text, BLOCK);
		expect(twice.action).toBe("replaced");
		expect(countOf(twice.text, BEGIN_GUARD)).toBe(1);
		expect(countOf(twice.text, END_GUARD)).toBe(1);
		expect(countOf(twice.text, "omp-router:")).toBe(1);
		providersOf(twice.text);
	});

	test("refreshed cost figures replace the old ones in place", () => {
		const first = spliceProviderBlock(EXISTING, renderProviderBlock(cfg, null));
		const updated = spliceProviderBlock(
			first.text,
			renderProviderBlock(cfg, {
				inputPerMtok: 0.4242,
				outputPerMtok: 1.2345,
				cacheReadPerMtok: 0.0424,
				cacheWritePerMtok: 0.5303,
				sampleCount: 99,
				windowDays: 7,
			}),
		);
		expect(updated.text).toContain("0.4242");
		expect(countOf(updated.text, BEGIN_GUARD)).toBe(1);
		providersOf(updated.text);
	});

	test("adds a providers mapping when the file has none", () => {
		const result = spliceProviderBlock("# just a comment\n", BLOCK);
		expect(result.text).toContain("# just a comment");
		expect(countOf(result.text, "providers:")).toBe(1);
		expect(Object.keys(providersOf(result.text))).toContain("omp-router");
	});

	test("creates a whole file from empty input", () => {
		const result = spliceProviderBlock("", BLOCK);
		expect(result.action).toBe("created");
		expect(Object.keys(providersOf(result.text))).toContain("omp-router");
	});

	test("survives a UTF-8 BOM without producing a duplicate providers key", () => {
		// A BOM made the first line read as "\uFEFFproviders:", so the top-level
		// key was missed and a second one appended -- which makes omp discard the
		// entire file.
		const result = spliceProviderBlock(`\uFEFF${EXISTING}`, BLOCK);
		expect(result.text.startsWith("\uFEFF")).toBe(true);
		const lines = result.text.split("\n");
		expect(lines.filter((l) => /^\uFEFF?providers\s*:/.test(l))).toHaveLength(1);
		expect(Object.keys(providersOf(result.text)).sort()).toEqual(["fastflowlm", "ollama", "omp-router"]);
	});

	test("preserves CRLF line endings", () => {
		const crlf = EXISTING.replaceAll("\n", "\r\n");
		const result = spliceProviderBlock(crlf, BLOCK);
		expect(result.text).toContain("\r\n");
		// No stray bare LF introduced by the inserted block.
		expect(result.text.replaceAll("\r\n", "")).not.toContain("\n");
		providersOf(result.text);
	});

	test("matches the existing child indentation", () => {
		// EXISTING indents providers' children by four spaces; mixing widths
		// under one mapping is invalid YAML.
		const result = spliceProviderBlock(EXISTING, BLOCK);
		const begin = result.text.split("\n").find((l) => l.includes(BEGIN_GUARD));
		expect(begin).toBeDefined();
		expect(begin?.startsWith("    #")).toBe(true);
	});

	test("a two-space file gets two-space children", () => {
		const twoSpace = "providers:\n  ollama:\n    auth: none\n";
		const result = spliceProviderBlock(twoSpace, BLOCK);
		const begin = result.text.split("\n").find((l) => l.includes(BEGIN_GUARD));
		expect(begin?.startsWith("  #")).toBe(true);
		providersOf(result.text);
	});
});

describe("assertUsableModelsYaml", () => {
	test("accepts a correctly spliced result", () => {
		expect(() => assertUsableModelsYaml(spliceProviderBlock(EXISTING, BLOCK).text)).not.toThrow();
	});

	test("rejects a duplicate providers key, which YAML treats as fatal", () => {
		expect(() => assertUsableModelsYaml("providers:\n  a:\n    auth: none\nproviders:\n  b:\n    auth: none\n")).toThrow();
	});

	test("rejects a file without our provider", () => {
		expect(() => assertUsableModelsYaml("providers:\n  ollama:\n    auth: none\n")).toThrow();
	});

	test("rejects a file with no providers mapping", () => {
		expect(() => assertUsableModelsYaml("something: else\n")).toThrow();
	});
});
