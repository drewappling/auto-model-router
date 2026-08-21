import type { RouterConfig } from "../config/types.ts";

export type LogLevel = RouterConfig["logLevel"];

export interface Logger {
	error(msg: string, fields?: Record<string, unknown>): void;
	warn(msg: string, fields?: Record<string, unknown>): void;
	info(msg: string, fields?: Record<string, unknown>): void;
	debug(msg: string, fields?: Record<string, unknown>): void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
	silent: Number.POSITIVE_INFINITY,
	error: 40,
	warn: 30,
	info: 20,
	debug: 10,
};

function formatField(v: unknown): string {
	if (typeof v === "string") return /[\s=]/.test(v) ? JSON.stringify(v) : v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
	try {
		return JSON.stringify(v) ?? "null";
	} catch {
		return String(v);
	}
}

/**
 * Single-line stderr logger. Suppressed levels return before any formatting
 * or allocation, so debug calls on the hot path are effectively free.
 */
export function createLogger(level: LogLevel): Logger {
	const threshold = LEVEL_RANK[level];
	const emit = (rank: number, tag: string, msg: string, fields?: Record<string, unknown>): void => {
		if (rank < threshold) return;
		let line = `${new Date().toISOString()} ${tag} ${msg}`;
		if (fields !== undefined) {
			for (const [k, v] of Object.entries(fields)) {
				if (v === undefined) continue;
				line += ` ${k}=${formatField(v)}`;
			}
		}
		process.stderr.write(line + "\n");
	};
	return {
		error: (msg, fields) => emit(LEVEL_RANK.error, "ERROR", msg, fields),
		warn: (msg, fields) => emit(LEVEL_RANK.warn, "WARN", msg, fields),
		info: (msg, fields) => emit(LEVEL_RANK.info, "INFO", msg, fields),
		debug: (msg, fields) => emit(LEVEL_RANK.debug, "DEBUG", msg, fields),
	};
}
