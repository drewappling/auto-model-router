import { describe, expect, test } from "bun:test";

/**
 * The Hermes native plugin is Python, which this suite cannot import. Its
 * pure functions (identity headers, digest gate and replacement, /router
 * rendering) are exercised by hermes-plugin/native/selftest.py; this test
 * runs it when a Python interpreter is on PATH and is skipped otherwise, so
 * a machine without Python still passes the suite but a machine with one
 * catches a regression.
 */

const python = Bun.which("python") ?? Bun.which("python3");
const ROOT = `${import.meta.dir}/..`;

describe("hermes native plugin", () => {
	(python === null ? test.skip : test)("the Python self-test passes", () => {
		const run = Bun.spawnSync([python!, "hermes-plugin/native/selftest.py"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
		const out = `${run.stdout.toString()}\n${run.stderr.toString()}`;
		expect(out).toContain("ok test_identity_headers");
		expect(out).toContain("ok test_digest");
		expect(out).toContain("ok test_router_command");
		expect(run.exitCode).toBe(0);
	});

	test("the plugin files parse as Python and declare the standalone kind", async () => {
		const manifest = await Bun.file(`${ROOT}/hermes-plugin/native/plugin.yaml`).text();
		expect(manifest).toContain("kind: standalone");
		const src = await Bun.file(`${ROOT}/hermes-plugin/native/__init__.py`).text();
		expect(src).toContain("def register(ctx");
		for (const hook of ['register_hook("pre_llm_call"', 'register_middleware("llm_request"', 'register_middleware("tool_execution"', 'register_command("router"']) expect(src).toContain(hook);
	});
});
