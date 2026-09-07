/**
 * LOCAL ambient stub for OpenCode's plugin API — not the vendor's types.
 *
 * `@opencode-ai/plugin` is resolved by OpenCode when it loads the plugin; it
 * is not a dependency of this repo. This declares only the surface
 * auto-model-router.ts uses, so the plugin is type-checked with the rest of
 * the tree (tsconfig.all.json). The real types live in the package OpenCode
 * installs under ~/.config/opencode/node_modules/@opencode-ai/plugin; treat a
 * change here as a claim about that API that only a live session confirms.
 */
declare module "@opencode-ai/plugin" {
	export interface SessionInfo {
		id: string;
		parentID?: string;
	}
	export interface OpencodeClient {
		session: {
			get(options: { path: { id: string } }): Promise<{ data?: SessionInfo }>;
		};
		tui: {
			showToast(options: { body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number } }): Promise<unknown>;
		};
	}
	export interface PluginInput {
		client: OpencodeClient;
		directory: string;
		worktree: string;
	}
	export type Event =
		| { type: "session.created"; properties: { info: SessionInfo } }
		| { type: "session.idle"; properties: { sessionID: string } }
		| { type: string; properties?: unknown };
	export interface Hooks {
		event?: (input: { event: Event }) => Promise<void>;
		"chat.headers"?: (input: { sessionID: string; agent: string; model: { providerID?: string; id?: string } }, output: { headers: Record<string, string> }) => Promise<void>;
		"tool.execute.after"?: (input: { tool: string; sessionID: string; callID: string; args: unknown }, output: { title: string; output: string; metadata: unknown }) => Promise<void>;
	}
	export type Plugin = (input: PluginInput) => Promise<Hooks>;
}
