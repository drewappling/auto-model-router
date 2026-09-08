import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { applyRequestPolicy, resolveProfile } from "../src/router/index.ts";
import { parseChatRequest, parsePolicyHeader } from "../src/wire/openai/request.ts";

/**
 * The per-request routing policy (X-Omp-Policy): parsed defensively from the
 * header, then applied on top of the profile and filters — tiers only narrow,
 * an allow list replaces the configured one, a deny list adds to it, and a
 * pin forces a slug unless a session override already did.
 */

describe("parsePolicyHeader", () => {
	test("accepts the documented fields, drops junk, and never rejects a turn", () => {
		expect(parsePolicyHeader(null)).toBeUndefined();
		expect(parsePolicyHeader("not json")).toBeUndefined();
		expect(parsePolicyHeader("[]")).toBeUndefined();
		expect(parsePolicyHeader("{}")).toBeUndefined();
		expect(parsePolicyHeader(JSON.stringify({ allow: ["anthropic/*", " x/y "], deny: [1, "", "openai/*"], minTier: "simple", maxTier: "nope", pin: " z/w " }))).toEqual({ allow: ["anthropic/*", "x/y"], deny: ["openai/*"], minTier: "simple", pin: "z/w" });
		const req = parseChatRequest({ model: "auto", messages: [{ role: "user", content: "hi" }] }, new Headers({ "X-Omp-Policy": '{"maxTier":"moderate"}' }));
		expect(req.policy).toEqual({ maxTier: "moderate" });
		expect("policy" in parseChatRequest({ model: "auto", messages: [{ role: "user", content: "hi" }] }, new Headers())).toBe(false);
	});
});

describe("applyRequestPolicy", () => {
	const cfg = DEFAULT_CONFIG;
	const profile = resolveProfile(cfg, "auto");

	test("narrows the tier envelope, never widens it", () => {
		const r = applyRequestPolicy(profile, cfg, { maxTier: "moderate", minTier: "trivial" }, undefined);
		expect(r.profile.maxTier).toBe("moderate");
		expect(r.profile.minTier).toBe(profile.minTier);
		expect(r.profile.id).toBe(`${profile.id}+policy`);
		expect(r.reasons[0]).toContain("tiers narrowed");
		// A cheap profile cannot be raised past its own ceiling.
		const cheap = resolveProfile(cfg, "auto-cheap");
		const up = applyRequestPolicy(cheap, cfg, { minTier: "hard" }, undefined);
		expect(up.profile.minTier).toBe(cheap.maxTier);
		expect(up.profile.maxTier).toBe(cheap.maxTier);
	});

	test("allow replaces, deny adds, and a pin forces unless a session override already did", () => {
		const base = { ...cfg, filters: { ...cfg.filters, allow: ["x/*"], deny: ["bad/*"] } };
		const r = applyRequestPolicy(profile, base, { allow: ["anthropic/*"], deny: ["openai/*"], pin: "anthropic/claude-sonnet-5" }, undefined);
		expect(r.cfg.filters.allow).toEqual(["anthropic/*"]);
		expect(r.cfg.filters.deny).toEqual(["bad/*", "openai/*"]);
		expect(r.forceSlug).toBe("anthropic/claude-sonnet-5");
		expect(r.profile).toBe(profile); // tiers untouched ⇒ same object
		expect(applyRequestPolicy(profile, base, { pin: "a/b" }, "session/pin").forceSlug).toBe("session/pin");
		expect(applyRequestPolicy(profile, base, undefined, undefined)).toEqual({ profile, cfg: base, forceSlug: undefined, reasons: [] });
		// Untouched config object when the policy carries no filters.
		expect(applyRequestPolicy(profile, base, { maxTier: "hard" }, undefined).cfg).toBe(base);
	});
});
