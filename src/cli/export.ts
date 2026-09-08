/**
 * `auto-model-router export`: the ledger as one row per day, harness and
 * model (dispatches, tokens, spend, escalations, errors), CSV by default or
 * `--json`. The same rows back `GET /v1/router/export`.
 */

import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { loadConfig } from "../config/load.ts";
import { exportCsv, exportRows } from "../cost/views.ts";
import { configOpts, flagInt, flagString, type CliArgs } from "./args.ts";

export async function exportCommand(args: CliArgs): Promise<void> {
	const days = flagInt(args, "days") ?? 30;
	const harness = flagString(args, "harness") ?? "";
	const cfg = loadConfig(configOpts(args));
	if (!existsSync(cfg.ledger.path)) {
		process.stdout.write(args.flags.has("json") ? "[]\n" : exportCsv([]));
		return;
	}
	// Read-only: an export must never create or migrate the ledger.
	const db = new Database(cfg.ledger.path, { readonly: true });
	try {
		const rows = exportRows(db, Date.now() - days * 86_400_000, harness === "" ? null : harness.split(",").map((s) => s.trim()).filter((s) => s !== ""));
		process.stdout.write(args.flags.has("json") ? `${JSON.stringify(rows, null, 2)}\n` : exportCsv(rows));
	} finally {
		db.close();
	}
}
