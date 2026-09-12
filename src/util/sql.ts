/**
 * One SQL handle for both engines.
 *
 * The ledger has to live in the same database as the rest of a deployment's
 * state when that state is shared (spend read from a file that lags the
 * database it must agree with is a cap that silently over-admits), and in a
 * local file when it is not. `Bun.SQL` speaks both, so the ledger is written
 * once against this shim rather than twice.
 *
 * Only three things actually differ, and they are the three things here:
 *
 *  1. **JSON access.** `json_extract(usage, '$.promptTokens')` against
 *     `(usage->>'promptTokens')::numeric`.
 *  2. **Numeric results.** Postgres returns `COUNT(*)` and `SUM(BIGINT)` as
 *     STRINGS. Arithmetic on those silently produces wrong answers rather than
 *     throwing — a measured trust score came out 0.9756 instead of 0.9726 this
 *     way — so every numeric read goes through `num`.
 *  3. **Column types.** `JSONB`/`DOUBLE PRECISION` against `TEXT`/`REAL`.
 *
 * Everything else — parameters, `IN ${sql(array)}`, window functions,
 * `ON CONFLICT`, `DELETE ... RETURNING`, bulk insert, transactions — is
 * identical on both, verified by `tools/dialect-probe.ts`.
 */

import { SQL } from "bun";

export type Dialect = "sqlite" | "postgres";

export interface SqlDb {
	readonly sql: SQL;
	readonly dialect: Dialect;
	/** A JSON member as a NUMBER-typed SQL expression, for aggregates and comparisons. */
	jsonNum(column: string, key: string): string;
	/** A JSON member as TEXT, for equality against string values. */
	jsonText(column: string, key: string): string;
	/**
	 * A NESTED JSON member as a number, e.g. `features.anatomy.messages`.
	 *
	 * `jsonNum` cannot express this: SQLite takes a whole path in one string
	 * (`'$.anatomy.messages'`), while Postgres' `->>` reads a SINGLE key, so a
	 * dotted key silently reads NULL there — a whole report section came back
	 * null rather than failing.
	 */
	jsonPathNum(column: string, path: readonly string[]): string;
	/**
	 * A JSON member that holds a BOOLEAN, as 1/0.
	 *
	 * The engines disagree twice over: SQLite's `json_extract` yields the
	 * INTEGER 1 for JSON `true`, Postgres' `->>` yields the TEXT 'true', and
	 * SQLite's `IN` does not coerce between them. Comparing the wrong way round
	 * silently misclassifies every row — it counted router-ESTIMATED cache hits
	 * as measured ones and inflated cache reliability samples by 2%.
	 */
	jsonBool(column: string, key: string): string;
	/**
	 * Substring test as a boolean expression. SQLite has `instr(haystack,
	 * needle) > 0`; Postgres spells it `position(needle in haystack) > 0`.
	 */
	contains(haystack: string, needle: string): string;
	/**
	 * An epoch-millisecond column as a `YYYY-MM-DD` UTC day. SQLite has
	 * `strftime(..., 'unixepoch')`; Postgres needs `to_timestamp` plus an
	 * explicit UTC conversion, or the server's timezone silently decides which
	 * day a turn was billed on.
	 */
	utcDay(msColumn: string): string;
	/** Whether a table exists, without reading engine-specific catalog tables. */
	tableExists(name: string): Promise<boolean>;
	/**
	 * Runs SQL written with `$name` placeholders, whichever way the engine
	 * wants them numbered.
	 *
	 * The reporting queries are assembled from optional filters (a harness
	 * scope, an upper time bound), which a tagged template cannot express — the
	 * shape of the statement is decided at runtime. Rewriting them as string
	 * concatenation with positional parameters would renumber every bind by
	 * hand, which is how a filter ends up reading the wrong column.
	 */
	query<T>(text: string, binds?: Record<string, unknown>): Promise<T[]>;
	/** `query`, for a statement that yields at most one row. */
	one<T>(text: string, binds?: Record<string, unknown>): Promise<T | null>;
	/** A column type that differs between engines. */
	type(kind: "json" | "float" | "bigint"): string;
	/**
	 * Cast suffix for a parameter that may be NULL. Postgres refuses to infer a
	 * type for a bare NULL placeholder ("could not determine data type of
	 * parameter $2"), which the `(${x} IS NULL OR col = ${x})` idiom for an
	 * optional filter relies on; SQLite has no cast syntax to add. Empty there.
	 */
	readonly nullableText: string;
	/**
	 * Two-argument scalar minimum. SQLite spells it `MIN(a, b)`; Postgres
	 * reserves `MIN` for the aggregate and needs `LEAST(a, b)`.
	 */
	least(a: string, b: string): string;
	close(): Promise<void>;
}

/**
 * `sqlite://` (or a bare path) and `postgres://`/`postgresql://` URLs. A bare
 * path is accepted because the router's config has always taken
 * `ledger.path`, and a deployment that never opts into Postgres should not
 * have to learn a URL scheme.
 */
export function dialectOf(url: string): Dialect {
	return url.startsWith("postgres://") || url.startsWith("postgresql://") ? "postgres" : "sqlite";
}

export function openSqlDb(url: string): SqlDb {
	const dialect = dialectOf(url);
	const target = dialect === "sqlite" && !url.startsWith("sqlite:") ? `sqlite://${url}` : url;
	const sql = new SQL(target);
	const pg = dialect === "postgres";
	return {
		sql,
		dialect,
		jsonNum: (column, key) => (pg ? `(${column}->>'${key}')::numeric` : `json_extract(${column}, '$.${key}')`),
		jsonText: (column, key) => (pg ? `(${column}->>'${key}')` : `json_extract(${column}, '$.${key}')`),
		jsonPathNum: (column, path) =>
			pg
				? `(${column}#>>'{${path.join(",")}}')::numeric`
				: `json_extract(${column}, '$.${path.join(".")}')`,
		jsonBool: (column, key) =>
			pg
				? `CASE WHEN (${column}->>'${key}') IN ('true', '1') THEN 1 ELSE 0 END`
				: `CASE WHEN json_extract(${column}, '$.${key}') IN (1, 'true', '1') THEN 1 ELSE 0 END`,
		type: (kind) => {
			if (kind === "json") return pg ? "JSONB" : "TEXT";
			if (kind === "float") return pg ? "DOUBLE PRECISION" : "REAL";
			return pg ? "BIGINT" : "INTEGER";
		},
		nullableText: pg ? "::text" : "",
		least: (a, b) => (pg ? `LEAST(${a}, ${b})` : `MIN(${a}, ${b})`),
		// The haystack is cast to text: a JSON column is `jsonb` on Postgres and
		// `position()` refuses it, while sqlite stores the same column as TEXT.
		contains: (haystack, needle) => (pg ? `position(${needle} in (${haystack})::text) > 0` : `instr(${haystack}, ${needle}) > 0`),
		utcDay: (msColumn) =>
			pg
				? `to_char(to_timestamp(${msColumn} / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
				: `strftime('%Y-%m-%d', ${msColumn} / 1000, 'unixepoch')`,
		tableExists: async (name) => {
			// Cheaper and more portable than either catalog table: ask for nothing
			// from it and see whether the statement plans.
			try {
				await sql.unsafe(`SELECT 1 FROM ${name} WHERE 1 = 0`);
				return true;
			} catch {
				return false;
			}
		},
		query: async <T>(text: string, binds: Record<string, unknown> = {}): Promise<T[]> => {
			const { text: prepared, values } = bindNamed(text, binds, pg);
			return (await sql.unsafe(prepared, values)) as T[];
		},
		one: async <T>(text: string, binds: Record<string, unknown> = {}): Promise<T | null> => {
			const { text: prepared, values } = bindNamed(text, binds, pg);
			const rows = (await sql.unsafe(prepared, values)) as T[];
			return rows[0] ?? null;
		},
		close: async () => {
			await sql.end();
		},
	};
}


/**
 * Rewrites `$name` placeholders to the engine's positional form, in order of
 * first appearance, and returns the matching value array.
 *
 * A name may repeat — `created_at_ms >= $since` and a `CASE` on `$since` in
 * the same statement is normal — and repeats must reuse one parameter slot on
 * Postgres. JSON paths (`'$.isSubagent'`) are not placeholders: the pattern
 * requires a letter or underscore after the `$`, which `$.` fails.
 */
export function bindNamed(text: string, binds: Record<string, unknown>, pg: boolean): { text: string; values: unknown[] } {
	// Callers that were written against bun:sqlite pass their binds keyed WITH
	// the sigil (`{ $since: 0 }`), which is how every reporting query in this
	// repo already builds them; both forms resolve.
	const valueOf = (name: string): unknown => {
		if (name in binds) return binds[name];
		const sigil = `$${name}`;
		if (sigil in binds) return binds[sigil];
		throw new Error(`sql: no value bound for $${name}`);
	};
	const order: string[] = [];
	const prepared = text.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
		valueOf(name);
		let index = order.indexOf(name);
		if (index === -1) {
			order.push(name);
			index = order.length - 1;
		}
		return pg ? `$${index + 1}` : "?";
	});
	if (!pg) {
		// SQLite's positional `?` cannot reuse a slot, so a repeated name is
		// bound once per occurrence rather than once per name.
		const values: unknown[] = [];
		text.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
			values.push(valueOf(name));
			return "";
		});
		return { text: prepared, values };
	}
	return { text: prepared, values: order.map(valueOf) };
}

/**
 * Coerces a value Postgres may have returned as a string. Applied at every
 * numeric read: `Number(null)` is 0, which is wrong for a nullable aggregate,
 * so null and undefined are preserved.
 */
export function num(value: unknown): number {
	return typeof value === "number" ? value : Number(value ?? 0);
}

/** `num`, but a missing value stays missing rather than becoming 0. */
export function numOrNull(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	return typeof value === "number" ? value : Number(value);
}

/**
 * JSON for a `json` column. Postgres' driver encodes a JS string destined for
 * `JSONB` as a JSON *string* — `jsonb_typeof` reads `'string'` and every
 * `->>` on it returns NULL — so an object must be passed through unstringified
 * there, while SQLite's TEXT column needs the serialised form.
 */
export function jsonParam(db: SqlDb, value: unknown): unknown {
	if (value === null || value === undefined) return null;
	return db.dialect === "postgres" ? value : JSON.stringify(value);
}

/** Reads a `json` column back, whichever way it was stored. */
export function jsonValue<T>(value: unknown): T | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		try {
			return JSON.parse(value) as T;
		} catch {
			return null;
		}
	}
	return value as T;
}
