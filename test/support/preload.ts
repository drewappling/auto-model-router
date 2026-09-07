/**
 * Test preload (bunfig.toml `[test] preload`): isolate every test from the
 * developer's live router home BEFORE any module loads.
 *
 * Five test files build their config with `loadConfig({})`, which layers
 * `$AUTO_MODEL_ROUTER_HOME/config.yml` over the defaults. Run alone they read
 * the real config and fail on whatever the developer has tuned; run in the
 * full suite they happened to pass because an earlier file had already
 * pointed the home at a temp dir. Doing it here makes both cases the same.
 * Tests that want a specific home (config.test.ts, embed-lifecycle) still
 * set their own; this only supplies the default.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.AUTO_MODEL_ROUTER_HOME === undefined) {
	process.env.AUTO_MODEL_ROUTER_HOME = mkdtempSync(join(tmpdir(), "amr-test-home-"));
}
