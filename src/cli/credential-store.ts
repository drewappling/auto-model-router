/**
 * Where the refresh token lives on a member's machine.
 *
 * The access key has to sit in harness config files (a harness needs a literal
 * bearer), and it is short-lived. The refresh token is the long-lived secret,
 * so it goes to the operating system's credential store instead of a file:
 *
 *   Windows  DPAPI (CurrentUser scope): the token is encrypted so that only
 *            this Windows user on this machine can decrypt it, and the
 *            ciphertext is kept in `<router home>/refresh.dpapi`. Built in;
 *            no module to install. The plaintext passes to PowerShell through
 *            an environment variable, never an argument.
 *   macOS    the login keychain, through `security` (service
 *            `auto-model-router`, one account per remote user).
 *   Linux    the Secret Service through `secret-tool` when it is installed.
 *   file     `<router home>/refresh.token`, owner-readable only — the fallback
 *            when none of the above works, and the choice on CI boxes.
 *
 * `remote.json` records which store holds it (`refreshTokenStore`) and the
 * account name; it never holds the token itself once a store other than
 * `file` is in use. A remote.json written before this existed may still carry
 * the token inline; reading honours that until the next refresh moves it.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StoreKind = "dpapi" | "keychain" | "secret-service" | "file";

const SERVICE = "auto-model-router";

/** The store this platform offers, given which tools are on PATH. */
export function pickStore(platform: string, pathHas: (bin: string) => boolean): StoreKind {
	if (platform === "win32") return pathHas("powershell") || pathHas("pwsh") ? "dpapi" : "file";
	if (platform === "darwin") return pathHas("security") ? "keychain" : "file";
	if (platform === "linux") return pathHas("secret-tool") ? "secret-service" : "file";
	return "file";
}

const powershell = (pathHas: (bin: string) => boolean): string => (pathHas("pwsh") ? "pwsh" : "powershell");

function dpapiProtect(secret: string, pathHas: (bin: string) => boolean): string {
	const r = spawnSync(
		powershell(pathHas),
		["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:AMR_SECRET), $null, 'CurrentUser'))"],
		{ encoding: "utf8", env: { ...process.env, AMR_SECRET: secret } },
	);
	if (r.status !== 0 || r.stdout.trim() === "") throw new Error(`DPAPI protect failed: ${r.stderr.trim() || r.status}`);
	return r.stdout.trim();
}

function dpapiUnprotect(blob: string, pathHas: (bin: string) => boolean): string {
	const r = spawnSync(
		powershell(pathHas),
		["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:AMR_BLOB), $null, 'CurrentUser'))"],
		{ encoding: "utf8", env: { ...process.env, AMR_BLOB: blob } },
	);
	if (r.status !== 0) throw new Error(`DPAPI unprotect failed: ${r.stderr.trim() || r.status}`);
	return r.stdout.replace(/\r?\n$/, "");
}

const filePath = (routerHome: string): string => join(routerHome, "refresh.token");
const dpapiPath = (routerHome: string): string => join(routerHome, "refresh.dpapi");

export interface StoreDeps {
	pathHas?: (bin: string) => boolean;
	/** Injected in tests to stand in for the platform tools. */
	backend?: { save(account: string, secret: string): void; load(account: string): string | null; remove(account: string): void };
}

/**
 * Saves the refresh token and returns the store that took it. A store that
 * fails (keychain locked, tool missing) falls back to the file, so a member is
 * never left without a refresh token; the caller records what was used.
 */
export function saveRefreshToken(routerHome: string, account: string, secret: string, kind: StoreKind, deps: StoreDeps = {}): StoreKind {
	const pathHas = deps.pathHas ?? ((bin) => Bun.which(bin) !== null);
	mkdirSync(routerHome, { recursive: true });
	try {
		if (deps.backend !== undefined) {
			deps.backend.save(account, secret);
			return kind;
		}
		switch (kind) {
			case "dpapi":
				writeFileSync(dpapiPath(routerHome), `${dpapiProtect(secret, pathHas)}\n`, { encoding: "utf8", mode: 0o600 });
				rmSync(filePath(routerHome), { force: true });
				return "dpapi";
			case "keychain": {
				const r = spawnSync("security", ["add-generic-password", "-U", "-a", account, "-s", SERVICE, "-w", secret], { encoding: "utf8" });
				if (r.status !== 0) throw new Error(r.stderr.trim());
				rmSync(filePath(routerHome), { force: true });
				return "keychain";
			}
			case "secret-service": {
				const r = spawnSync("secret-tool", ["store", `--label=${SERVICE} ${account}`, "service", SERVICE, "account", account], { encoding: "utf8", input: secret });
				if (r.status !== 0) throw new Error(r.stderr.trim());
				rmSync(filePath(routerHome), { force: true });
				return "secret-service";
			}
			case "file":
				break;
		}
	} catch {
		// fall through to the file
	}
	writeFileSync(filePath(routerHome), `${secret}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(filePath(routerHome), 0o600);
	} catch {
		/* Windows */
	}
	return "file";
}

/** The refresh token from the store `remote.json` names, or null when it is gone. */
export function loadRefreshToken(routerHome: string, account: string, kind: StoreKind, deps: StoreDeps = {}): string | null {
	const pathHas = deps.pathHas ?? ((bin) => Bun.which(bin) !== null);
	try {
		if (deps.backend !== undefined) return deps.backend.load(account);
		switch (kind) {
			case "dpapi": {
				const p = dpapiPath(routerHome);
				if (!existsSync(p)) return null;
				return dpapiUnprotect(readFileSync(p, "utf8").trim(), pathHas);
			}
			case "keychain": {
				const r = spawnSync("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"], { encoding: "utf8" });
				return r.status === 0 ? r.stdout.replace(/\r?\n$/, "") : null;
			}
			case "secret-service": {
				const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], { encoding: "utf8" });
				return r.status === 0 && r.stdout !== "" ? r.stdout.replace(/\r?\n$/, "") : null;
			}
			case "file": {
				const p = filePath(routerHome);
				return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
			}
		}
	} catch {
		return null;
	}
	return null;
}

/** Forgets the token everywhere it might be. */
export function removeRefreshToken(routerHome: string, account: string, deps: StoreDeps = {}): void {
	rmSync(filePath(routerHome), { force: true });
	rmSync(dpapiPath(routerHome), { force: true });
	if (deps.backend !== undefined) {
		deps.backend.remove(account);
		return;
	}
	if (process.platform === "darwin") spawnSync("security", ["delete-generic-password", "-a", account, "-s", SERVICE], { encoding: "utf8" });
	if (process.platform === "linux") spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account], { encoding: "utf8" });
}
