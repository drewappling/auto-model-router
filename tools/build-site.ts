#!/usr/bin/env bun
/**
 * Static site generator for the auto-model-router GitHub Pages site.
 *
 * Dependency-free by design: content is authored as HTML in this file and the
 * only dynamic input is `site/data/benchmarks.json`, which the head-to-head
 * suite tables render from and which `tools/export-benchmarks.ts` regenerates
 * from a live ledger at release time. Emits `site/dist/`, ready for
 * `actions/upload-pages-artifact`.
 *
 * Run by hand: `bun tools/build-site.ts` (then open site/dist/index.html).
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SITE = join(ROOT, "site");
const DIST = join(SITE, "dist");
const REPO = "https://github.com/drewappling/auto-model-router";

// ---------------------------------------------------------------------------
// Benchmark data
// ---------------------------------------------------------------------------

interface SuiteTable {
	title: string;
	note: string;
	columns: string[];
	rows: string[][];
	winnerCol?: number;
}
interface LedgerSnapshot {
	generatedAt: string;
	windowDays: number | null;
	requests: number;
	spendAllTimeUsd: number;
	spend7dUsd: number;
	perTurnUsd: number;
	escalationRatePct: number;
	perModel: { slug: string; requests: number; sharePct: number }[];
}
interface Benchmarks {
	generatedAt: string;
	baseline: string;
	headline: {
		coreCostMultiple: string;
		coreCostMultipleLabel: string;
		realWorldMultiple: string;
		realWorldSavedPct: string;
	};
	suites: { core: SuiteTable; ladder: SuiteTable; routed: SuiteTable; realWorld: SuiteTable };
	ledgerSnapshot: LedgerSnapshot | null;
}

const bench = JSON.parse(readFileSync(join(SITE, "data", "benchmarks.json"), "utf8")) as Benchmarks;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function suiteTable(t: SuiteTable): string {
	const head = t.columns.map((c) => `<th>${esc(c)}</th>`).join("");
	const body = t.rows
		.map((row) => {
			const cells = row
				.map((cell, i) => {
					const win = t.winnerCol !== undefined && i === t.winnerCol && i > 0;
					return `<td${win ? ' class="win"' : ""}>${esc(cell)}</td>`;
				})
				.join("");
			return `<tr>${cells}</tr>`;
		})
		.join("\n");
	return `<h3>${esc(t.title)}</h3>
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
<p class="note">${esc(t.note)}</p>`;
}

function ledgerPanel(s: LedgerSnapshot | null): string {
	if (s === null) {
		return `<p class="note">No live ledger snapshot is bundled with this build. Maintainers regenerate one with <code>bun tools/export-benchmarks.ts</code> against a real install before a release.</p>`;
	}
	const window = s.windowDays === null ? "all time" : `last ${s.windowDays} days`;
	const rows = s.perModel
		.map((m) => `<tr><td><code>${esc(m.slug)}</code></td><td>${m.requests}</td><td>${m.sharePct.toFixed(1)}%</td></tr>`)
		.join("\n");
	return `<p class="note">Generated ${esc(s.generatedAt)} from a real install's ledger (${window}).</p>
<div class="stats">
  <div class="stat"><div class="n">${s.requests.toLocaleString()}</div><div class="l">billed turns</div></div>
  <div class="stat"><div class="n">$${s.perTurnUsd.toFixed(4)}</div><div class="l">per turn</div></div>
  <div class="stat"><div class="n">$${s.spend7dUsd.toFixed(2)}</div><div class="l">spend, 7 days</div></div>
  <div class="stat"><div class="n">${s.escalationRatePct.toFixed(1)}%</div><div class="l">escalation rate</div></div>
</div>
<table>
<thead><tr><th>Model</th><th>Requests</th><th>Spend share</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface Page {
	slug: string; // "" for index
	title: string;
	nav: string;
	body: string;
}

const NAV: { href: string; label: string; key: string }[] = [
	{ href: "index.html", label: "Overview", key: "home" },
	{ href: "install.html", label: "Install", key: "install" },
	{ href: "config.html", label: "Configuration", key: "config" },
	{ href: "benchmarks.html", label: "Benchmarks", key: "benchmarks" },
];

function layout(p: Page): string {
	const nav = NAV.map(
		(n) => `<a href="${n.href}"${n.key === p.nav ? ' class="active"' : ""}>${esc(n.label)}</a>`,
	).join("\n        ");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="A local cost/complexity-aware model router for Oh My Pi, backed by OpenRouter. Well over an order of magnitude cheaper at equal correctness.">
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<header class="nav">
  <div class="inner">
    <a class="brand" href="index.html">auto-model-router</a>
    <div class="spacer"></div>
    <nav>
        ${nav}
        <a href="${REPO}">GitHub</a>
    </nav>
  </div>
</header>
<main>
${p.body}
</main>
<footer>
  <div class="inner">
    <span>auto-model-router \u2014 MIT licensed</span>
    <div class="spacer"></div>
    <a href="${REPO}">GitHub</a>
    <a href="https://www.npmjs.com/package/auto-model-router">npm</a>
    <a href="${REPO}/issues">Issues</a>
  </div>
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const indexBody = `<section class="hero">
  <h1>The right model for every turn</h1>
  <p class="tagline">A local, keyless model router for <a href="https://github.com/oh-my-pi">Oh My Pi</a>. One OpenAI-compatible provider that picks a concrete OpenRouter model <strong>per turn</strong> from measured price and estimated task complexity \u2014 including mid-conversation.</p>
  <div class="cta">
    <a class="btn primary" href="install.html">Get started</a>
    <a class="btn ghost" href="benchmarks.html">See the benchmarks</a>
  </div>
</section>

<div class="stats">
  <div class="stat"><div class="n">${esc(bench.headline.coreCostMultiple)}</div><div class="l">${esc(bench.headline.coreCostMultipleLabel)}</div></div>
  <div class="stat"><div class="n">${esc(bench.headline.realWorldMultiple)}</div><div class="l">cheaper on a real week of traffic</div></div>
  <div class="stat"><div class="n">${esc(bench.headline.realWorldSavedPct)}</div><div class="l">of spend saved</div></div>
</div>

<h2>Why this exists when OpenRouter already ships routers</h2>
<p>OpenRouter has <code>openrouter/auto</code> and <code>openrouter/pareto-code</code>. Both are opaque, server-side, and \u2014 per Pareto's own docs \u2014 <em>"you can't directly cap cost or latency per request."</em> This router does the things a prompt classifier structurally cannot:</p>
<div class="card">
  <h3>Agent-loop awareness</h3>
  <p class="note">OpenRouter sees a prompt. We see omp's tool array, tool-result depth, and whether the previous tool call failed. Most agent turns are mechanical post-tool-result continuations \u2014 the largest cost lever in agent traffic, and invisible upstream.</p>
</div>
<div class="card">
  <h3>Budget enforcement</h3>
  <p class="note">Per-turn, per-conversation, and rolling-24h caps, checked against a <strong>cold-cache forecast</strong> before dispatch, with forced downgrade at the ceiling.</p>
</div>
<div class="card">
  <h3>Mid-stream escalation</h3>
  <p class="note">Hold the first N tokens; on a malformed tool call, refusal, empty completion, or repeated tool call, abort and re-dispatch upward. omp never observes the failure.</p>
</div>
<div class="card">
  <h3>Cache-aware hysteresis</h3>
  <p class="note">Switching models forfeits the warm prompt cache. The decision is arithmetic, not vibes: expected saving must beat the forfeited cache-read discount by a configured margin.</p>
</div>
<div class="card">
  <h3>Closed-loop trust</h3>
  <p class="note">Per-model escalation and error rates from <em>your</em> traffic demote cheap-but-flaky models automatically.</p>
</div>
<div class="card">
  <h3>Explainability</h3>
  <p class="note">Every decision \u2014 candidates, rejections, forecasts, reasons \u2014 is persisted and replayable via <code>auto-model-router explain</code>.</p>
</div>

<h2>How it runs</h2>
<p>auto-model-router runs <strong>embedded inside the omp process</strong> as an extension \u2014 no separate server, no orphaned process. It binds a free OS-assigned port and lives and dies with the omp session. For non-omp harnesses (Hermes, Claude, any OpenAI-compatible client), run it standalone with <code>auto-model-router serve --port &lt;n&gt;</code>.</p>
<p><a href="install.html">Install it &rarr;</a></p>`;

const installBody = `<h2>Installing</h2>
<p>No separate Bun install is needed for the embedded path. The standalone <code>serve</code> binary bundles Bun.</p>

<h3>Via npm (recommended)</h3>
<pre><code>npm install -g auto-model-router</code></pre>
<p>Then add the shipped extensions to omp's <code>~/.omp/agent/config.yml</code> (<code>$PI_CODING_AGENT_DIR/config.yml</code> when that env var relocates the agent dir):</p>
<pre><code># ~/.omp/agent/config.yml
extensions:
  - auto-model-router/omp-extension/router-embed.ts
  - auto-model-router/omp-extension/router-toast.ts      # optional: chosen-model toasts
  - auto-model-router/omp-extension/router-configure.ts  # optional: /router command</code></pre>

<h3>From the repo (cross-platform installer)</h3>
<pre><code>bun tools/install.ts</code></pre>
<p>It wires the extensions into omp's <code>~/.omp/agent/config.yml</code>, backing up the previous file first. It is idempotent. Use <code>--no-toast --no-configure</code> for only the required embed extension.</p>

<h3>From the marketplace</h3>
<p>This repo doubles as its own marketplace. Add it as a source, then install:</p>
<pre><code>omp plugin marketplace add drewappling/auto-model-router
omp plugin install auto-model-router@auto-model-router</code></pre>
<p>Or in the TUI: <code>/marketplace add drewappling/auto-model-router</code> then <code>/marketplace install auto-model-router@auto-model-router</code>.</p>

<h3>As a Pi package</h3>
<pre><code>pi install npm:auto-model-router
# or from git:
pi install git:github.com/drewappling/auto-model-router</code></pre>

<h2>Setup \u2014 the OpenRouter key</h2>
<p>There is exactly one OpenRouter key on the machine, owned by omp. Once you have run <code>/login openrouter</code> inside omp, auto-model-router borrows that key with no config and no second copy to rotate or leak. Alternatively set <code>OPENROUTER_API_KEY</code> in the environment, or <code>openrouter.apiKey</code> in <code>config.yml</code>.</p>
<p class="note">The catalog and the <code>config</code> command work keyless; only dispatch needs a key.</p>

<h2>Available models &amp; guardrails</h2>
<p>The router never ships a hand-curated model list. When an OpenRouter key is configured it fetches the key-scoped catalog (<code>GET /models/user</code>) \u2014 the exact set of models that key is <strong>entitled to</strong> under your account's active <a href="https://openrouter.ai/docs/guides/features/guardrails">guardrails</a>, provider preferences, and data policies \u2014 and routes only within it. Keyless, it falls back to the public catalog for pricing and capability discovery, but dispatch still needs a key.</p>
<p>This means your OpenRouter <a href="https://openrouter.ai/docs/guides/features/guardrails">guardrails</a> \u2014 model and provider allowlists, budget limits, Zero-Data-Retention and privacy rules \u2014 are the router's outer boundary: a model your key cannot reach is never a routing candidate. The catalog is refetched in the background every few minutes, so tightening or relaxing a guardrail is picked up without a restart.</p>
<div class="card">
  <p class="note"><strong>Narrow guardrails still route.</strong> If a guardrail shrinks the eligible set so far that a complexity tier's quality floor admits nothing, <code>adaptiveTierFloors</code> (on by default) relaxes that tier's economic envelope to the best available models rather than leaving it empty \u2014 so the router keeps working on a tightly restricted key instead of stalling on the cheapest tier.</p>
</div>

<h2>Activating it</h2>
<p>After installing, <strong>restart the omp session</strong> (extensions load at session start), then run <code>/model</code> and pick <code>auto-model-router/auto</code>.</p>
<div class="card">
  <p class="note"><strong>Note on updates.</strong> The embedded router is long-lived per omp session and reads its config and code at boot. Config changes to hot-reloadable knobs apply live; changes to the listening socket, the OpenRouter client, or the agentdox bridge require a session restart.</p>
</div>

<h2>Standalone (Hermes / any OpenAI-compatible client)</h2>
<pre><code>auto-model-router serve --port 8788</code></pre>
<p>Register it as a plain OpenAI-compatible provider pointing at <code>http://127.0.0.1:8788/v1</code>. No API key is enforced unless you set <code>server.apiKey</code>.</p>

<h2>Configuring behaviour</h2>
<p>Every routing lever lives in <code>$AUTO_MODEL_ROUTER_HOME/config.yml</code>. See the <a href="config.html">configuration reference</a> for the knobs and their shipped defaults.</p>`;

const configBody = `<h2>Configuration reference</h2>
<p>auto-model-router is configured through <code>$AUTO_MODEL_ROUTER_HOME/config.yml</code> (defaults to <code>~/.auto-model-router/config.yml</code>). The file is a deep-partial overlay on the built-in defaults: set only the keys you want to change. Most per-turn knobs <strong>hot-reload</strong> \u2014 edits apply on the next turn with no restart. The listening socket (<code>server.*</code>), the OpenRouter client (<code>openrouter.*</code>), and the agentdox bridge (<code>context.*</code>) are captured at boot and need a session restart.</p>
<p class="pill">All values below are the shipped defaults.</p>

<h3>openrouter \u2014 upstream &amp; attribution</h3>
<dl class="knobs">
  <dt>openrouter.apiKey</dt><dd>OpenRouter key. The router routes only within the models this key is entitled to under your <a href="https://openrouter.ai/docs/guides/features/guardrails">OpenRouter guardrails</a> (fetched via <code>/models/user</code>). <span class="default">Default: empty \u2014 borrowed from omp's credential store, or <code>OPENROUTER_API_KEY</code>.</span></dd>
  <dt>openrouter.title / openrouter.referer</dt><dd>App attribution for OpenRouter's Activity/Apps ranking. <code>title</code> is the display name; <code>referer</code> is the identity requests are grouped by. <span class="default">Default: <code>auto-model-router</code> and the project URL.</span></dd>
  <dt>openrouter.timeoutMs</dt><dd>Per-request timeout. Agent turns are long. <span class="default">Default: 600000 (10 min).</span></dd>
</dl>

<h3>tiers \u2014 the complexity ladder</h3>
<p>Each complexity tier sets a quality floor and a price ceiling. A model priced above a tier's ceiling is excluded before ranking; within the tier, <code>score = (quality/100) ^ qualityExponent / effectiveUsd</code> picks the winner. <code>hard</code> has no ceiling \u2014 quality is the point of the top tier.</p>
<dl class="knobs">
  <dt>tiers.trivial</dt><dd>minQuality 0, maxInputPerMtok $0.30, qualityExponent 0 <span class="default">(cheapest above the floor).</span></dd>
  <dt>tiers.simple</dt><dd>minQuality 40, maxInputPerMtok $1.50, qualityExponent 0.</dd>
  <dt>tiers.moderate</dt><dd>minQuality 60, maxInputPerMtok $4.00, qualityExponent 1.</dd>
  <dt>tiers.hard</dt><dd>minQuality 72, no price ceiling, qualityExponent 3.</dd>
  <dt>tiers.&lt;tier&gt;.capabilityFloorUsd</dt><dd>Optional. Pick the highest-quality candidate whose cold-cache cost fits this cap, ignoring quality-per-dollar. Buys quality with money deliberately. <span class="default">Default: unset.</span></dd>
  <dt>tiers.&lt;tier&gt;.pin</dt><dd>Force a specific slug set for the tier. <span class="default">Default: none.</span></dd>
</dl>

<h3>filters \u2014 the eligible catalog</h3>
<dl class="knobs">
  <dt>filters.includeFree</dt><dd>Include $0 models. <span class="default">Default: false \u2014 free models are rate-limited enough that retries cost more than they save.</span></dd>
  <dt>filters.requireToolSupport</dt><dd><span class="default">Default: true.</span></dd>
  <dt>filters.minTrust / minTrustSamples</dt><dd>Demote models whose measured reliability falls below the floor once enough samples exist. <span class="default">Default: 0.7 over 12 samples.</span></dd>
  <dt>filters.contextHeadroom</dt><dd>Require a context window this multiple of the estimated prompt. <span class="default">Default: 1.25.</span></dd>
  <dt>filters.latencyWeight</dt><dd>Inflate a model's effective cost by expected wait (TTFT + completion time). <span class="default">Default: 0 (off) \u2014 opt in after establishing a baseline.</span></dd>
  <dt>filters.maxExpectedWaitMs</dt><dd>Absolute expected-wait ceiling: a hard drop for models <em>proven</em> slower than this (≥ latencyMinSamples), regardless of price \u2014 the soft penalty above is multiplicative and capped, so it cannot demote a slow-but-cheap model. New models keep their cold-start turns. <span class="default">Default: unset (off).</span></dd>
</dl>

<h3>escalation \u2014 mid-stream recovery</h3>
<dl class="knobs">
  <dt>escalation.enabled</dt><dd><span class="default">Default: true.</span></dd>
  <dt>escalation.probeTokens</dt><dd>Hold this many tokens before committing, to catch a bad start. <span class="default">Default: 48.</span></dd>
  <dt>escalation.maxAttempts</dt><dd>Original try plus retries. Each retry beyond the first can abandon generated tokens. <span class="default">Default: 3.</span></dd>
  <dt>escalation.triggers</dt><dd>malformed_tool_args, refusal, empty_completion, repeat_tool_call, missing_expected_tool_call.</dd>
  <dt>escalation.probeTiers</dt><dd>trivial, simple, moderate \u2014 never <code>hard</code>, which has nowhere to escalate to.</dd>
</dl>

<h3>hysteresis \u2014 cache-aware stickiness</h3>
<dl class="knobs">
  <dt>hysteresis.holdTurns / holdTurnsAfterEscalation</dt><dd>Hold the current tier for N turns to protect the warm cache. <span class="default">Default: 2, and 4 after an escalation.</span></dd>
  <dt>hysteresis.switchMargin</dt><dd>Expected saving must beat the forfeited cache discount by this factor to switch. <span class="default">Default: 1.3.</span></dd>
  <dt>hysteresis.maxDowngradePerTurn</dt><dd>Step tiers down at most this fast. <span class="default">Default: 1.</span></dd>
  <dt>hysteresis.breakHoldOnMechanical</dt><dd>Let a mechanical tool-result continuation break a hold that sits above the fresh classification. <span class="default">Default: false.</span></dd>
</dl>

<h3>budget \u2014 spend caps</h3>
<dl class="knobs">
  <dt>budget.perTurnUsd / perConversationUsd / rolling24hUsd</dt><dd>Optional ceilings, checked against the cold-cache forecast before dispatch. <span class="default">Default: no caps.</span></dd>
  <dt>budget.onExceeded</dt><dd><code>downgrade</code> or <code>fail</code> at the ceiling. <span class="default">Default: downgrade.</span></dd>
</dl>

<h3>context \u2014 agentdox bridge (restart to change)</h3>
<dl class="knobs">
  <dt>context.enabled</dt><dd>Inject one shared project-context block per conversation. <span class="default">Default: false \u2014 needs a URL and token.</span></dd>
  <dt>context.baseUrl / token / defaultScope</dt><dd>agentdox endpoint, bearer, and fallback project scope.</dd>
  <dt>context.memoryLimit / docsLimit / sessionLimit / briefChars</dt><dd>Bound what the server selects, so the block is ranked rather than byte-truncated. <span class="default">Default: 8 / 2 / 6 / 12000, inside a 24000-char cap.</span></dd>
</dl>

<h3>compaction \u2014 prompt shrinking</h3>
<dl class="knobs">
  <dt>compaction.enabled</dt><dd>Shrink stale, low-value context before dispatch. <span class="default">Default: false \u2014 elision is lossy, never implicit.</span></dd>
  <dt>compaction.budgetTokens</dt><dd>Fire above this prompt size. <span class="default">Default: 40000.</span></dd>
  <dt>compaction.floorRatio</dt><dd>Compact to this fraction of the budget. Below 1 overshoots and holds the plan (cache-friendly); 1 re-tightens every turn. <span class="default">Default: 1; 0.75 recommended once you have watched your ledger.</span></dd>
</dl>

<h2>Inspecting decisions</h2>
<pre><code>auto-model-router stats            # spend and per-model distribution
auto-model-router explain          # candidates, rejections, forecasts for the last turn
auto-model-router models           # the eligible catalog per tier</code></pre>
<p class="note">The full type surface and every field's doc-comment live in <a href="${REPO}/blob/main/src/config/types.ts"><code>src/config/types.ts</code></a>.</p>`;

const benchmarksBody = `<h2>Benchmarks</h2>
<p>Measured against Claude Opus 5 on Anthropic first-party. Each task is a real omp session working in a pristine git workspace from a written spec; hidden tests are copied in only <em>after</em> the agent exits, so they cannot be read or edited. Every task is verified to fail an untouched workspace and to pass a reference solution. Both arms are metered from omp's own event stream under an identical tool surface. The router arm routes freely \u2014 nothing pinned.</p>
<p class="pill">Data generated ${esc(bench.generatedAt)} \u00b7 baseline <code>${esc(bench.baseline)}</code></p>

${suiteTable(bench.suites.core)}
${suiteTable(bench.suites.ladder)}
${suiteTable(bench.suites.routed)}
${suiteTable(bench.suites.realWorld)}

<h2>Live ledger snapshot</h2>
${ledgerPanel(bench.ledgerSnapshot)}

<h2>Scope &amp; honesty</h2>
<p class="note">These are small, self-contained tasks of one to three files. On the core suite both engines solved everything, so it measures cost at equal correctness rather than capability; the ladder is where capability separates. The cost multiple varied between 14\u00d7 and 32\u00d7 across runs depending on which task the baseline stalled on \u2014 treat "well over an order of magnitude" as the claim, not a specific figure. Full harness, tasks, and raw per-turn data are in <a href="${REPO}/blob/main/docs/routing-benchmark-findings.md"><code>docs/routing-benchmark-findings.md</code></a>.</p>`;

const PAGES: Page[] = [
	{ slug: "index", title: "auto-model-router \u2014 the right model for every turn", nav: "home", body: indexBody },
	{ slug: "install", title: "Install \u2014 auto-model-router", nav: "install", body: installBody },
	{ slug: "config", title: "Configuration \u2014 auto-model-router", nav: "config", body: configBody },
	{ slug: "benchmarks", title: "Benchmarks \u2014 auto-model-router", nav: "benchmarks", body: benchmarksBody },
];

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function main(): void {
	rmSync(DIST, { recursive: true, force: true });
	mkdirSync(DIST, { recursive: true });
	for (const p of PAGES) {
		writeFileSync(join(DIST, `${p.slug}.html`), layout(p), "utf8");
	}
	cpSync(join(SITE, "assets"), join(DIST, "assets"), { recursive: true });
	// .nojekyll: the artifact is already built HTML; skip GitHub's Jekyll pass.
	writeFileSync(join(DIST, ".nojekyll"), "", "utf8");
	console.log(`built ${PAGES.length} pages \u2192 ${DIST}`);
}

main();
