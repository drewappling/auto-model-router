/**
 * LOCAL ambient stub for omp's extension API — not the vendor's types.
 *
 * `@oh-my-pi/pi-coding-agent` is injected by the omp process at runtime and is
 * not an installed dependency, so without this declaration every extension file
 * fails to resolve it, TS gives up, and the whole `omp-extension/` directory
 * goes unchecked. That gap was not theoretical: two user-visible port bugs
 * shipped from these files while `tsconfig.json` only included `src` and `test`.
 *
 * Deliberately minimal — it declares the surface these extensions actually use.
 * It buys checking of OUR logic (control flow, ports, async, config shapes), not
 * validation against omp's real signatures; treat a change here as a claim about
 * omp's API that only a live session can confirm.
 */
declare module "@oh-my-pi/pi-coding-agent" {
	export interface ProviderModelCost {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
	}

	export interface ProviderModel {
		id: string;
		name: string;
		api: string;
		reasoning?: boolean;
		input?: string[];
		contextWindow?: number;
		maxTokens?: number;
		cost?: ProviderModelCost;
	}

	export interface ProviderRegistration {
		baseUrl: string;
		api: string;
		apiKey?: string;
		headers?: Record<string, string>;
		models: ProviderModel[];
	}

	export interface SessionManager {
		getSessionId(): string;
	}

	/** Mirrors `ConfigUi` in configure-logic.ts, which is what /router drives. */
	export interface ExtensionUI {
		select(title: string, options: string[], selected?: number): Promise<string | undefined>;
		input(title: string, placeholder?: string, initial?: string): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		notify(text: string, level?: "info" | "warn" | "error"): void;
	}

	export interface ExtensionContext {
		/** False for subagents and headless (`-p`) runs: the discriminator the embed extension keys on. */
		hasUI: boolean;
		sessionManager: SessionManager;
		ui: ExtensionUI;
		/** Interval whose errors omp isolates, and whose handle `clearTimer` cancels. */
		setInterval(handler: () => void | Promise<void>, ms: number): unknown;
		clearTimer(timer: unknown): void;
	}

	export interface CommandDefinition {
		description: string;
		handler(args: string, ctx: ExtensionContext): void | Promise<void>;
	}

	export interface ExtensionAPI {
		setLabel(label: string): void;
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
		registerProvider(id: string, registration: ProviderRegistration): void;
		unregisterProvider(id: string): void;
		registerCommand(name: string, command: CommandDefinition): void;
	}
}
