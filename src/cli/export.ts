/**
 * `auto-model-router export`: the ledger as one row per day, harness and
 * model (dispatches, tokens, spend, escalations, errors), CSV by default or
 * `--json`. The same rows back `GET /v1/router/export`.
 */

import { existsSync } from "node:fs";
import { openSqlDb } from "../util/sql.ts";
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
	// The shim opens the ledger wherever it lives; an export must never create
	// or migrate it, so nothing here calls migrateLedger.
	const db = openSqlDb(cfg.ledger.path);
	try {
		const rows = await exportRows(db, Date.now() - days * 86_400_000, harness === "" ? null : harness.split(",").map((s) => s.trim()).filter((s) => s !== ""));
		process.stdout.write(args.flags.has("json") ? `${JSON.stringify(rows, null, 2)}\n` : exportCsv(rows));
	} finally {
		await db.close();
	}
}
