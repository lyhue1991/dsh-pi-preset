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
 *   2. symlink every preset file (agent.cordis.yml, preset.yml, the bridge
 *      plugins, the vendored pi-codex build) from the installed package into
 *      `${userRoot}/pi`, replacing whatever a previous mirror put there. The
 *      installed package is the single source of truth and the roster reads
 *      through the links, so when the package is installed as a pnpm `link:`
 *      to a local checkout, edits there reach new sessions without a re-mirror;
 *   3. symlink `${userRoot}/pi/node_modules` to the vendored one, so the
 *      preset's relative imports resolve without a second install.
 *
 * A pre-existing real `${userRoot}/pi` that is not this mirror (a
 * hand-installed copy) is renamed to `pi.pre-dsh-pi-preset-<timestamp>`
 * rather than deleted. Everything is idempotent: unchanged files are not
 * rewritten, so the steady-state boot only stats.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

		// 3. Link the preset files into the mirror. The mirror is fully owned
		//    (proven by the marker check above), so its previous contents are
		//    replaced wholesale: real copies left by an older copy-based
		//    boot, or links to a superseded install path. The steady-state
		//    boot therefore only recreates symlinks, and a `link:`-installed
		//    checkout needs no further propagation step.
		let linked = 0;
		for (const entry of readdirSync(mirror, { withFileTypes: true })) {
			rmSync(join(mirror, entry.name), { recursive: true, force: true });
		}
		for (const file of listFiles(presetDir)) {
			const target = join(mirror, file);
			mkdirSync(join(target, ".."), { recursive: true });
			symlinkSync(join(presetDir, file), target);
			linked += 1;
		}

		// 4. Point node_modules at the vendored install (a directory link, so
		//    the pi tools resolve their relative imports through it).
		symlinkSync(join(presetDir, "node_modules"), join(mirror, "node_modules"), "dir");
		writeFileSync(join(mirror, ".dsh-pi-preset-mirror"), "");
		console.log(`[dsh-pi-preset] preset mirror linked at ${mirror} (${linked} file(s))`);
	}, "dsh-pi-preset.bootstrap()");
}

export { apply, name };
