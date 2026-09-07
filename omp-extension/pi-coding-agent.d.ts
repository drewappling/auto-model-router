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

	/** A TUI component: rows at a width, optional key handling and teardown. */
	export interface Component {
		render(width: number): readonly string[];
		handleInput?(data: string): void;
		invalidate?(): void;
		dispose?(): void;
	}

	/** The subset of omp's theme the report hub paints with. */
	export interface Theme {
		fg(color: string, text: string): string;
		bg(color: string, text: string): string;
		bold(text: string): string;
		boxRound: {
			topLeft: string;
			topRight: string;
			bottomLeft: string;
			bottomRight: string;
			horizontal: string;
			vertical: string;
			teeDown: string;
			teeUp: string;
			teeLeft: string;
			teeRight: string;
		};
		nav: { cursor: string };
	}

	export interface TUI {
		terminal?: { rows: number; columns: number };
		requestRender(): void;
	}

	export interface KeybindingsManager {
		matches(data: string, keybinding: string): boolean;
	}

	export interface OverlayOptions {
		width?: number | string;
		maxHeight?: number | string;
		anchor?: string;
		fullscreen?: boolean;
	}

	/** Mirrors `ConfigUi` in configure-logic.ts, which is what /router drives. */
	export interface ExtensionUI {
		/** Returns the chosen label; an option may carry a dimmed description. */
		select(title: string, options: Array<string | { label: string; description?: string }>): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		notify(text: string, level?: "info" | "warn" | "error"): void;
		/** Show a custom component with keyboard focus; `overlay: true` floats it over the transcript. */
		custom<T>(
			factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
			options?: { overlay?: boolean; overlayOptions?: OverlayOptions },
		): Promise<T>;
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

	/**
	 * A custom transcript message. `display: true` renders it in the TUI;
	 * `content` is markdown. (Real type: `CustomMessagePayload<T>`.)
	 */
	export interface CustomMessagePayload {
		customType?: string;
		content?: string;
		display?: boolean;
		details?: unknown;
	}

	/** A tool result's content parts (text and images). */
	export interface ToolResultPart {
		type: string;
		text?: string;
	}

	/** What a `tool_result` handler may return to replace the result. */
	export interface ToolResultEventResult {
		content?: ToolResultPart[];
		isError?: boolean;
	}

	export interface ExtensionAPI {
		setLabel(label: string): void;
		/** Handlers may return an event result (e.g. a `tool_result` replacement); omp ignores it where none applies. */
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
		registerProvider(id: string, registration: ProviderRegistration): void;
		unregisterProvider(id: string): void;
		registerCommand(name: string, command: CommandDefinition): void;
		/** Appends a custom message to the session; `triggerTurn: false` leaves the agent idle. */
		sendMessage(message: CustomMessagePayload | string, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
	}
}

/**
 * LOCAL stub for omp's TUI toolkit, which omp resolves for extensions at load
 * time (its bundled example extensions import it the same way). Only the
 * helpers the report hub uses are declared.
 */
declare module "@oh-my-pi/pi-tui" {
	/** Columns a string occupies on screen, ignoring ANSI styling. */
	export function visibleWidth(text: string): number;
	/** Cuts a (possibly styled) string to at most `width` columns. */
	export function truncateToWidth(text: string, width: number, ellipsis?: string): string;
	/** Matches raw terminal input against a key id such as `"left"` or `"ctrl+c"`. */
	export function matchesKey(data: string, keyId: string): boolean;
}
