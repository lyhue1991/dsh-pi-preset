/**
 * dsh-pi-preset bootstrap — the bundle's host-side row.
 *
 * DSH's preset roster reads presets from configured roots plus the USER ROOT
 * (`${DSH_HOME:-~/.dsh}/.agent-presets`); the `agent-presets` row's
 * `config.roots` is force-overwritten to the shipped root by the profile
 * composer, so a plugin package cannot register a preset root directly. The
 * roster's scanner also only recognizes REAL directories (`Dirent
 * .isDirectory()`), so a symlinked preset is invisible. This bootstrap
 * therefore bridges the package into the supported channel by materializing
 * a mirror under the user root:
 *
 *   1. materialize the vendored `preset/node_modules` (npm install
 *      --ignore-scripts) on first boot — pnpm does not run dependency
 *      lifecycle scripts, so the package cannot rely on a postinstall;
 *   2. mirror every preset file (agent.cordis.yml, preset.yml, the bridge
 *      plugins, the vendored pi-codex build) from the installed package into
 *      `${userRoot}/pi`, overwriting whatever a previous mirror put there —
 *      the installed package is the single source of truth;
 *   3. symlink `${userRoot}/pi/node_modules` to the vendored one, so the
 *      preset's relative imports resolve without a second install.
 *
 * A pre-existing real `${userRoot}/pi` that is not this mirror (a
 * hand-installed copy) is renamed to `pi.pre-dsh-pi-preset-<timestamp>`
 * rather than deleted. Everything is idempotent: unchanged files are not
 * rewritten, so the steady-state boot only stats.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const name = "dsh-pi-preset-bootstrap";

/** Files never mirrored into the user-root preset. */
const SKIP = new Set(["node_modules", "package-lock.json"]);

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

function apply(ctx) {
	ctx.effect(() => {
		const packageDir = fileURLToPath(new URL(".", import.meta.url));
		const presetDir = join(packageDir, "preset");

		// 1. Dependencies for the preset's tool plugins (pi-coding-agent,
		//    dsh-tools, typebox), resolved through the mirrored node_modules.
		const marker = join(presetDir, "node_modules", "@earendil-works", "pi-coding-agent");
		if (!existsSync(marker)) {
			console.log(`[dsh-pi-preset] materializing preset dependencies (npm install --ignore-scripts) ...`);
			execSync("npm install --ignore-scripts --no-audit --no-fund", {
				cwd: presetDir,
				stdio: ["ignore", "ignore", "pipe"],
			});
			console.log(`[dsh-pi-preset] preset dependencies ready`);
		}

		// 2. Materialize the preset mirror under the roster's user root.
		const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ""
			? resolve(process.env.DSH_HOME)
			: join(homedir(), ".dsh");
		const userRoot = join(dshHome, ".agent-presets");
		const mirror = join(userRoot, "pi");
		mkdirSync(userRoot, { recursive: true });

		const mirrorState = (() => {
			try {
				const stat = lstatSync(mirror);
				if (stat.isSymbolicLink()) return "symlink";
				if (stat.isDirectory()) return existsSync(join(mirror, ".dsh-pi-preset-mirror")) ? "mirror" : "foreign";
			} catch {}
			return "absent";
		})();
		if (mirrorState === "symlink") rmSync(mirror);
		if (mirrorState === "foreign") {
			const backup = `${mirror}.pre-dsh-pi-preset-${Date.now()}`;
			renameSync(mirror, backup);
			console.log(`[dsh-pi-preset] existing preset directory moved to ${backup}`);
		}
		mkdirSync(mirror, { recursive: true });

		// 3. Mirror the preset files (idempotent: unchanged files stay).
		let written = 0;
		for (const file of listFiles(presetDir)) {
			const source = join(presetDir, file);
			const target = join(mirror, file);
			mkdirSync(join(target, ".."), { recursive: true });
			const next = readFileSync(source);
			const current = existsSync(target) ? readFileSync(target) : undefined;
			if (current === undefined || !current.equals(next)) {
				writeFileSync(target, next);
				written += 1;
			}
		}

		// 4. Point node_modules at the vendored install.
		const modulesLink = join(mirror, "node_modules");
		const modulesLinked = (() => {
			try {
				return lstatSync(modulesLink).isSymbolicLink() && readlinkSync(modulesLink) === join(presetDir, "node_modules");
			} catch {
				return false;
			}
		})();
		if (!modulesLinked) {
			if (existsSync(modulesLink) || lstatSync(modulesLink, { throwIfNoEntry: false }) !== undefined) rmSync(modulesLink, { recursive: true, force: true });
			symlinkSync(join(presetDir, "node_modules"), modulesLink, "dir");
			written += 1;
		}

		writeFileSync(join(mirror, ".dsh-pi-preset-mirror"), "");
		if (written > 0) {
			console.log(`[dsh-pi-preset] preset mirror updated at ${mirror} (${written} item(s) written)`);
		}
	}, "dsh-pi-preset.bootstrap()");
}

export { apply, name };
