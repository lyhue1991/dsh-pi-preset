/**
 * dsh-pi-preset bootstrap — the bundle's host-side row.
 *
 * DSH hosts come in two roster shapes, and this bootstrap bridges both. Both
 * paths serve the preset from a MATERIALIZED COPY under the roster's user
 * root (`${DSH_HOME:-~/.dsh}/.agent-presets/pi`):
 *
 *   1. DECLARATIVE REGISTRY (DSH Desktop 0.8+, `@deepseek-ai/dsh-agent-preset-
 *      registry`): presets are registered by calling `ctx.agentPresets.
 *      register({ id, name, description, plugins })`; there is no filesystem
 *      scan. Package rows (`@deepseek-ai/*`) keep their specifiers and mount
 *      against the registry's own baseUrl, exactly like a shipped preset;
 *      this package's bridge plugins cross as absolute `file:` URLs into the
 *      materialized copy (see ./preset/pi-preset-registration.js).
 *   2. FILESYSTEM ROSTER (dsh web 0.1.x, legacy dsh-desktop, `@deepseek-ai/
 *      dsh-agent-presets`): a preset is a directory under the user root
 *      holding an agent.cordis.yml, and a plugin package cannot register a
 *      preset root directly (`config.roots` is force-overwritten by the
 *      profile composer) — so the materialized copy IS the registration.
 *
 * Why a copy rather than links into the installed package: the Desktop host
 * installs a resolution-interception layer keyed by each bundle's declaring
 * directory, and a module whose URL resolves under this package gets its bare
 * imports rerouted to the host's newer copies (`@deepseek-ai/dsh-llm` without
 * `CallId`, ...), which breaks the vendored dependency set. Files under the
 * user root sit outside every declared layer and resolve the vendored
 * dependencies natively.
 *
 * Both paths first materialize the vendored `preset/node_modules` (`npm
 * install --ignore-scripts`) on first boot — pnpm does not run dependency
 * lifecycle scripts, so the package cannot rely on a postinstall.
 */
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PI_PRESET } from "./preset/pi-preset-registration.js";

const name = "dsh-pi-preset-bootstrap";

/** Marker file proving the mirror directory is ours to replace wholesale. */
const MARKER = ".dsh-pi-preset-mirror";

/** Files never copied into the mirror: node_modules has its own stamp flow. */
const SKIP = new Set(["node_modules", "package-lock.json", "pi-preset-registration.js"]);

/** The package's own preset/ directory. */
function presetDir() {
	return fileURLToPath(new URL("./preset/", import.meta.url));
}

/** The roster's user root: `$DSH_HOME/.agent-presets`, defaulting to `~/.dsh`. */
function userRoot() {
	const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ""
		? resolve(process.env.DSH_HOME)
		: join(homedir(), ".dsh");
	return join(dshHome, ".agent-presets");
}

/** Relative paths of every preset file to copy, in stable order. */
function listFiles(dir, base = dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path, base));
		else if (entry.isFile()) files.push(relative(base, path));
	}
	return files;
}

/** Materialize `preset/node_modules` once; the steady-state boot only stats. */
function ensureDependencies() {
	const dir = presetDir();
	const marker = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
	if (existsSync(marker)) return;
	console.log(`[dsh-pi-preset] materializing preset dependencies (npm install --ignore-scripts) ...`);
	execSync("npm install --ignore-scripts --no-audit --no-fund", {
		cwd: dir,
		stdio: ["ignore", "ignore", "pipe"],
	});
	console.log(`[dsh-pi-preset] preset dependencies ready`);
}

/**
 * Copy the preset into the user root, shared by both roster paths.
 *
 * Preset files are refreshed on every boot; node_modules (150M+) is copied
 * once and stamped with the vendored lockfile's identity, so steady-state
 * boots only rewrite the small files.
 */
function materializeMirror() {
	const root = userRoot();
	const mirror = join(root, "pi");
	const source = presetDir();
	mkdirSync(root, { recursive: true });

	const state = (() => {
		try {
			const stat = lstatSync(mirror);
			if (stat.isSymbolicLink()) return "symlink";
			if (stat.isDirectory() && existsSync(join(mirror, MARKER))) return "mirror";
			return "foreign";
		} catch {}
		return "absent";
	})();
	if (state === "symlink") rmSync(mirror);
	if (state === "foreign") {
		const backup = `${mirror}.pre-dsh-pi-preset-${Date.now()}`;
		renameSync(mirror, backup);
		console.log(`[dsh-pi-preset] existing preset directory moved to ${backup}`);
	}
	mkdirSync(mirror, { recursive: true });

	// Preset files: small, so copied on every boot. Remove each target first —
	// a leftover symlink from an older boot would make copyFileSync write
	// THROUGH the link, leaving the mirror pointing at the package checkout
	// whose module URLs the interception layer reroutes (see the header).
	let copied = 0;
	for (const file of listFiles(source)) {
		const target = join(mirror, file);
		mkdirSync(join(target, ".."), { recursive: true });
		rmSync(target, { force: true });
		copyFileSync(join(source, file), target);
		copied += 1;
	}

	// node_modules: copied only when the vendored lockfile changes. The
	// marker carries the stamp, so one read both proves ownership and
	// compares versions; a missing marker (first boot) reads as no stamp.
	const lock = join(source, "package-lock.json");
	const stamp = `${statSync(lock).size}:${Math.floor(statSync(lock).mtimeMs)}`;
	const stamped = existsSync(join(mirror, MARKER)) ? readFileSync(join(mirror, MARKER), "utf8") : "";
	const vendored = join(mirror, "node_modules");
	if (stamped !== stamp || !existsSync(vendored)) {
		console.log(`[dsh-pi-preset] copying vendored node_modules into the mirror ...`);
		rmSync(vendored, { recursive: true, force: true });
		cpSync(join(source, "node_modules"), vendored, { recursive: true });
		console.log(`[dsh-pi-preset] vendored node_modules copied`);
	}
	writeFileSync(join(mirror, MARKER), stamp);
	console.log(`[dsh-pi-preset] preset materialized at ${mirror} (${copied} file(s))`);
}

/** Register the preset with the declarative registry (DSH Desktop 0.8+). */
function registerWithRegistry(ctx) {
	if (typeof ctx.inject !== "function") return;
	ctx.inject(["agentPresets"], (rosterCtx) => {
		const roster = rosterCtx.agentPresets;
		if (typeof roster?.register !== "function") return;

		// The bridge files cross as absolute file: URLs into the materialized
		// copy (the registry mounts plugins against its own baseUrl, where
		// this package's relative names would not resolve).
		const mirrorUrl = new URL(`${pathToFileURL(join(userRoot(), "pi")).href}/`);
		const definition = {
			...PI_PRESET,
			plugins: PI_PRESET.plugins.map((row) =>
				typeof row.name === "string" && row.name.startsWith("./")
					? { ...row, name: new URL(row.name, mirrorUrl).href }
					: row,
			),
		};

		rosterCtx.effect(() => {
			const settled = roster
				.register(definition)
				.then((unregister) => {
					console.log(`[dsh-pi-preset] Pi preset registered with the agent-preset registry`);
					return unregister;
				})
				.catch((error) => {
					console.error(`[dsh-pi-preset] registry registration failed: ${String(error?.stack ?? error)}`);
					return undefined;
				});
			return () => {
				void settled.then((unregister) => unregister?.()).catch(() => {});
			};
		}, "dsh-pi-preset.register()");
	}, "dsh-pi-preset.registry()");
}

function apply(ctx) {
	ctx.effect(() => {
		try {
			ensureDependencies();
			materializeMirror();
			registerWithRegistry(ctx);
		} catch (error) {
			console.error(`[dsh-pi-preset] bootstrap failed: ${String(error?.stack ?? error)}`);
		}
	}, "dsh-pi-preset.bootstrap()");
}

export { apply, name };
