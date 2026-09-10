/**
 * The harness configurations `connect` writes beyond the five it has always
 * written (omp, Hermes, Codex, Aider, Claude Code), and the snippets it prints
 * for the ones it deliberately does not write.
 *
 * The line between the two is confidence, not effort. A harness whose config
 * FILE and keys are documented — and, where the harness could be run here, seen
 * to read them — gets an automated path: a pure merge over the file's text, so
 * `connect` edits its own keys and leaves every other one alone. A harness
 * whose provider settings live in application state (an editor's `globalState`
 * database, a vendor's web account page) has no file to edit honestly, so it
 * gets a snippet the user pastes into its settings UI instead. An invented key
 * writes a file that silently does nothing and then reports success, which is
 * worse for the user than a printed instruction that works.
 *
 * Every merge returns `null` when nothing changes — so a second `connect` is a
 * no-op — and also when the file cannot be parsed: a file we do not understand
 * is not ours to rewrite, and the caller says so rather than guessing.
 */

import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLSeq } from "yaml";

import { SCOPE_ENV } from "../context/scope.ts";

/** The provider id every automated harness registers the router under. */
export const PROVIDER_ID = "auto-model-router";

/** The virtual models a router serves; `auto` is the one each harness is pointed at. */
export const PROFILE_IDS = ["auto", "auto-cheap", "auto-max"] as const;

/**
 * The headers a harness's provider entry sends on every turn.
 *
 * `X-Omp-Harness` is what splits budgets, reports and toasts per harness, so it
 * is always here. The agentdox scope is not: these files hold LITERAL header
 * values — unlike omp's models.yml, none of these harnesses resolves a value
 * that names an environment variable — so a machine-wide file could only pin one
 * project onto every workspace. It is written only when `connect --scope` asked
 * for exactly that; otherwise the scope is left to the remote's own default.
 */
export function harnessHeaders(harness: string, scope: string): Record<string, string> {
	return { "X-Omp-Harness": harness, ...(scope !== "" && scope !== SCOPE_ENV ? { "X-Agentdox-Scope": scope } : {}) };
}

/** A harness `connect` will not write a file for: what to set, and where. */
export interface ManualSnippet {
	/** The harness's display name, as it appears in the report. */
	harness: string;
	/** Why there is no file to write — one line, shown beside the name. */
	reason: string;
	/** The instruction lines, already formatted for a terminal. */
	lines: string[];
}

// ---------------------------------------------------------------------------
// OpenCode — automated
// ---------------------------------------------------------------------------

/**
 * Merges the router into OpenCode's `opencode.json`.
 *
 * OpenCode reaches any OpenAI-compatible endpoint through a `provider` entry
 * backed by the `@ai-sdk/openai-compatible` npm package, which it installs
 * itself; `options` is handed to that package verbatim, which is where the base
 * URL, the key and the per-request headers go. This is the shape the README
 * documents, verified live against opencode 1.18 — the captured request,
 * `test/fixtures/harness/opencode.json`, carries the `X-Omp-Harness` header
 * that `options.headers` put there.
 *
 * `model` is pointed at our `auto` so the harness comes up on the router rather
 * than leaving the user to find it in the picker; every other key in the file —
 * `$schema`, the theme, MCP servers, other providers — is carried through.
 */
export function mergeOpenCodeConfig(before: string, url: string, key: string, scope = ""): string | null {
	const root = parseJsonObject(before);
	if (root === null) return null;
	const providers = { ...((root.provider as Record<string, unknown> | undefined) ?? {}) };
	providers[PROVIDER_ID] = {
		npm: "@ai-sdk/openai-compatible",
		name: "auto-model-router",
		options: { baseURL: `${url}/v1`, apiKey: key, headers: harnessHeaders("opencode", scope) },
		models: Object.fromEntries(PROFILE_IDS.map((id) => [id, { name: id }])),
	};
	const next = { ...root, provider: providers, model: `${PROVIDER_ID}/auto` };
	const after = `${JSON.stringify(next, null, 2)}\n`;
	return after === before ? null : after;
}

// ---------------------------------------------------------------------------
// Cline — automated
// ---------------------------------------------------------------------------

/** The provider id Cline files an OpenAI-compatible endpoint under; `cline auth -p openai` resolves to it. */
const CLINE_PROVIDER = "openai-compatible";

/**
 * Merges the router into Cline's `~/.cline/data/settings/providers.json`.
 *
 * The shape was captured by running `cline auth -p openai -b <base> -k <key> -m
 * auto` — the command the README documents — against an isolated `--data-dir`
 * on cline 3.0.61: a `version`, the `lastUsedProvider`, and one entry per
 * provider holding `settings`, an `updatedAt` stamp and a `tokenSource`. One
 * file serves the CLI and, since the extension's settings migration, the VS
 * Code extension too, which is also how Cline reaches the router inside an
 * editor that has no provider settings of its own (see windsurfSnippet).
 *
 * Writing the keys rather than shelling out to `cline auth` buys two things
 * the command cannot give: `--dry-run` can show the change, and `settings.headers`
 * gets written. That map is in the on-disk schema but has no CLI flag, and it is
 * what finally gives Cline a harness id — verified live by pointing cline 3.0.61
 * at a recording server, whose capture is `test/fixtures/harness/cline-cli-connected.json`.
 *
 * `updatedAt` is deliberately NOT refreshed when the settings already match: a
 * stamp that moved on every run would make `connect` write a different file each
 * time, which is the one thing every path here promises not to do.
 */
export function mergeClineProviders(before: string, url: string, key: string, nowIso: string, scope = ""): string | null {
	const root = parseJsonObject(before);
	if (root === null) return null;
	const providers = { ...((root.providers as Record<string, unknown> | undefined) ?? {}) };
	const entry = (providers[CLINE_PROVIDER] as Record<string, unknown> | undefined) ?? {};
	const settings = { provider: CLINE_PROVIDER, apiKey: key, model: "auto", baseUrl: `${url}/v1`, headers: harnessHeaders("cline", scope) };
	if (JSON.stringify(entry.settings) === JSON.stringify(settings) && root.lastUsedProvider === CLINE_PROVIDER) return null;
	providers[CLINE_PROVIDER] = { ...entry, settings, updatedAt: nowIso, tokenSource: entry.tokenSource ?? "manual" };
	// `version` leads the file cline writes; spreading root after it keeps that order on a file that has one.
	const next = { version: 1, ...root, lastUsedProvider: CLINE_PROVIDER, modes: root.modes ?? {}, providers };
	return `${JSON.stringify(next, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Continue — automated
// ---------------------------------------------------------------------------

/** The `name:` our model entries carry in Continue's config, and how they are found again on a re-run. */
const CONTINUE_PREFIX = PROVIDER_ID;

/**
 * Merges the router's three profiles into Continue's `~/.continue/config.yaml`.
 *
 * Continue's documented assistant file is a YAML map with `name`, `version` and
 * `schema` at the top and a `models:` list under it; an OpenAI-compatible
 * endpoint is a model entry with `provider: openai` and `apiBase`, `apiKey`,
 * `roles` and `requestOptions.headers` — the last is what carries the harness
 * id. Continue was not run here, so this is the documented shape rather than an
 * observed one; it is automated because the file, its location and its keys are
 * all published, which is the bar (nothing about it is inferred).
 *
 * The edit goes through the YAML *document*, not a re-serialisation of parsed
 * data, so a hand-written config keeps its comments, key order and quoting and
 * only our own entries move. Entries are matched by `name`, so a re-run with a
 * new key replaces them in place instead of appending a second copy.
 */
export function mergeContinueConfig(before: string, url: string, key: string, scope = ""): string | null {
	let doc: Document.Parsed;
	try {
		doc = parseDocument(before);
	} catch {
		return null;
	}
	if (doc.errors.length > 0) return null;
	// A new file is seeded in the schema's own order rather than assembled key by
	// key, which would leave the three required fields trailing the model list.
	if (before.trim() === "") doc = parseDocument(`name: ${PROVIDER_ID}\nversion: 0.0.1\nschema: v1\nmodels:\n`);
	if (!isMap(doc.contents)) return null;
	// Required by the schema, and only supplied when the file does not already say otherwise.
	if (doc.get("name") === undefined) doc.set("name", PROVIDER_ID);
	if (doc.get("version") === undefined) doc.set("version", "0.0.1");
	if (doc.get("schema") === undefined) doc.set("schema", "v1");
	const models = doc.get("models", true);
	// `models:` with nothing under it parses to a null SCALAR node, not to null itself.
	if (models === undefined || models === null || (isScalar(models) && models.value === null)) doc.set("models", doc.createNode([]));
	else if (!isSeq(models)) return null;
	const seq = doc.get("models", true) as YAMLSeq<unknown>;
	seq.flow = false; // an empty seq is created in flow style, which would drag every entry onto one line
	const wanted = PROFILE_IDS.map((id) =>
		doc.createNode({
			name: id === "auto" ? CONTINUE_PREFIX : `${CONTINUE_PREFIX}-${id.replace("auto-", "")}`,
			provider: "openai",
			model: id,
			apiBase: `${url}/v1`,
			apiKey: key,
			roles: ["chat", "edit", "apply", "summarize"],
			capabilities: ["tool_use", "image_input"],
			requestOptions: { headers: harnessHeaders("continue", scope) },
		}),
	);
	const nameOf = (item: unknown): string => (isMap(item) ? String(item.get("name") ?? "") : "");
	for (const node of wanted) {
		const name = nameOf(node);
		const at = seq.items.findIndex((item) => nameOf(item) === name);
		if (at >= 0) seq.items[at] = node;
		else seq.items.push(node);
	}
	const after = doc.toString();
	return after === before ? null : after;
}

// ---------------------------------------------------------------------------
// Manual paths
// ---------------------------------------------------------------------------

/**
 * The values every OpenAI-compatible settings form asks for, as lines.
 *
 * Shared by the manual harnesses because the substance is identical in each —
 * a base URL, a key and a model id — and only the form differs. One renderer
 * means the three recipes cannot drift apart from each other or from what the
 * automated paths write.
 */
function providerFields(url: string, key: string): string[] {
	return [`base URL: ${url}/v1`, `API key:  ${key}`, `model:    auto  (also auto-cheap, auto-max)`];
}

/**
 * Cursor.
 *
 * Cursor's OpenAI override is an application setting in the editor's own state
 * database, not a documented file: what lives under `~/.cursor` is MCP servers
 * and rules, and the official key documentation describes only the settings
 * pane. So the values are printed instead of written.
 *
 * The second line is the one that saves an afternoon: Cursor routes chat
 * through its own servers with the key attached, so the override only works
 * against a router the internet can reach. A loopback or LAN router cannot
 * serve Cursor however it is configured — which is worth saying plainly, since
 * every other harness here is happy with `127.0.0.1`.
 */
export function cursorSnippet(url: string, key: string): ManualSnippet {
	const reachable = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url);
	return {
		harness: "Cursor",
		reason: "its OpenAI override lives in the editor's settings, not a file",
		lines: [
			"Cursor Settings → Models → OpenAI API Key: enable the base-URL override, then",
			...providerFields(url, key),
			"Add `auto` as a custom model and select it. Cursor sends no custom header,",
			"so its turns carry no X-Omp-Harness id and share the unnamed budget.",
			...(reachable ? ["WARNING: Cursor proxies chat through its own servers, so this URL must be", "reachable from the internet — a loopback or LAN router will never answer it."] : []),
		],
	};
}

/**
 * Windsurf.
 *
 * Windsurf's own files under `~/.codeium/<channel>` cover MCP servers, rules
 * and skills; the model provider is not among them, and its bring-your-own-key
 * page takes first-party provider keys rather than an arbitrary base URL —
 * there is no field for one to write. So the useful answer is not a snippet of
 * Windsurf settings at all but the extension route: Windsurf is a VS Code fork,
 * and the Cline extension reads the same `providers.json` `connect` has already
 * written, so installing it is the whole configuration.
 */
export function windsurfSnippet(clineConfigured: boolean): ManualSnippet {
	return {
		harness: "Windsurf",
		reason: "it has no custom base-URL field; reach the router through an extension",
		lines: [
			"Windsurf's own provider settings take first-party keys, not a base URL.",
			"Install the Cline extension in Windsurf: it reads the same providers.json",
			clineConfigured ? "this connect just wrote, so it needs no further setup." : "connect writes — re-run `connect --harness cline` once Cline is installed.",
			"The Continue extension works the same way against ~/.continue/config.yaml.",
		],
	};
}

/** Parses a JSON object file, treating an empty file as `{}` and anything else as not ours. */
function parseJsonObject(before: string): Record<string, unknown> | null {
	if (before.trim() === "") return {};
	try {
		const parsed = JSON.parse(before) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}
