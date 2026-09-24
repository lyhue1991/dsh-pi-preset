# dsh-pi-preset

A DSH plugin that ships the `pi` agent preset: pi's real system prompt and pi's real coding tools, running on the DeepSeek Harness.

## What you get

A new agent preset named **Pi**:

- **System prompt** — the output of pi's own `buildSystemPrompt` (`@earendil-works/pi-coding-agent` 0.85.1), mounted as the sole prompt section.
- **Tools** — pi's real tool implementations (`read`/`edit`/`write`/`grep`/`find`/`ls` via pi's own factories), with pi's synchronous `bash` replaced by **pi-codex's non-blocking `bash` + `bash_io`** (spawn, poll, write stdin, Ctrl-C; long-running commands return a `session_id` instead of blocking).
- **Skills** — DSH's standard skill stack (the `skill` tool and catalog messages).
- **Goals** — DSH's standard goal tools (`create_goal` / `get_goal` / `update_goal`).
- **Host-inherited tools masked** — the Desktop PPT composer (`pptd_*` / `ppt_*`) and the bundled-environment `load_workspace_dependencies` tool are restricted for Pi only; other presets are unaffected.
- Compaction policy from the `standard` preset.

## Install

From npm:

```
dsh plugin --profile web add @lyhue1991/dsh-pi-preset
```

From a local checkout:

```
dsh plugin --profile web add ~/Codes/dsh-pi-preset
```

`dsh plugin add` with a directory records a pnpm `link:` in the profile's
`package.json` (like `"@lyhue1991/dsh-pi-preset": "link:../../../Codes/dsh-pi-preset"`),
so the profile runs this checkout itself rather than an npm copy. Then restart
the profile. On first boot the bootstrap row materializes the vendored
`preset/node_modules` (`npm install --ignore-scripts`), then registers the
preset through whichever roster the host provides:

1. **DSH Desktop 0.8+ (declarative registry)** — the bootstrap calls
   `ctx.agentPresets.register()` with the composition from
   `preset/pi-preset-registration.js`: `@deepseek-ai/*` rows resolve beside the
   shipped presets, and this package's bridge plugins cross as absolute
   `file:` URLs. There is no filesystem scan of `~/.dsh/.agent-presets` on
   this line of hosts.
2. **dsh web 0.1.x / legacy dsh-desktop (filesystem roster)** — a preset is a
   directory under `~/.dsh/.agent-presets` (the roster's user root — the only
   third-party registration channel), so the bootstrap materializes the same
   copy there for the roster to scan.

Both paths serve the preset from a MATERIALIZED COPY of `preset/` under
`~/.dsh/.agent-presets/pi` — real files, never links back into the installed
package. The Desktop host routes bare imports made from modules under each
bundle's declaring directory to the host's own dependency copies, which are
incompatible with this package's vendored set; files under the user root
resolve their vendored dependencies natively. `node_modules` is copied once
and stamped with the vendored lockfile's identity, so steady-state boots only
rewrite the small preset files.

A pre-existing real `~/.dsh/.agent-presets/pi` that is not this copy (a hand-installed preset) is renamed to `pi.pre-dsh-pi-preset-<timestamp>` (not deleted). The installed package is the single source of truth: every boot re-registers and re-copies the preset files, so edit the preset in this checkout (or under the installed package's `preset/`) and restart to propagate. All edits — composition or `preset/pi-*.js` — need a host restart to reach the preset (Node's ESM loader caches module URLs; see [Notes and boundaries](#notes-and-boundaries)).


Select **Pi** in the agent-preset picker (or set the `agent-presets.default` setting) for new sessions.

## Uninstall

```
dsh plugin --profile web remove @lyhue1991/dsh-pi-preset
```

and remove the copy at `~/.dsh/.agent-presets/pi` if you no longer need the preset.

## Permission model

Every model-facing tool in this preset bypasses the DSH sandbox stack — a faithful port of pi's no-permission-system design:

- **`write` / `edit`** — pi's own implementations: they resolve the path against the session cwd and write through `node:fs` directly. They never call the DSH `ctx.fs` backend, so the `dsh-fs-sandbox` fence (`read-only` denials, `workspace-write` workspace containment, `FS_SANDBOX_DENIED` escalation) is unreachable from them.
- **`bash` / `bash_io`** — pi-codex spawns via `node:child_process` directly, outside the DSH `ctx.shell` seam, so no `dsh-bash-sandbox` confinement (e.g. Seatbelt) applies.
- **Registry gates are inert here** — the shipped composition registers no `tools/pre-execute` listeners and no guards, and pi's tools never emit approval `ask` decisions. The user-approval policy (`ask` vs `never`) and the per-session sandbox-mode override (`read-only` / `workspace-write` / `danger-full-access`) are therefore no-ops for Pi-preset sessions; the `dsh-sandbox-policy` context text that reaches the model is advisory prose, not enforcement.

The only hard boundary is OS process permissions: the tools can touch exactly what the harness process's user can. Do not expect DSH's sandbox-mode UI to constrain a Pi-preset session — if you need enforcement, add a fence in the bridge plugins (`preset/pi-coding-tools.js`, `preset/pi-codex-bash.js`).

### Default permission for Pi sessions

Because the narrower presets are no-ops here, the bundle ships a second host row (`permission-pin.js`, id `dsh-pi-preset-permission-pin`) that defaults new sessions STARTED with the Pi preset to **Full access**: on `session/created`, when `session.header.agentPreset` is `pi` (override with `DSH_PI_PRESET_PIN_ID`), it appends the same three log events the stock services write — `permission/preset: danger-full-access`, `sandbox/mode: danger-full-access`, `approval/policy: never` — after the base layer's own pin, so its values win the fold. The preset table is untouched: the permission menu still offers all three levels and any manual switch remains a normal logged override. Sessions that switch to the Pi preset after creation are not re-pinned; disable the row via the usual patch `disabled: true` if you want the deployment default instead.

## Notes and boundaries

- The agent loop, sandbox/approval stack, model route, and session persistence remain DSH's; the preset replaces the model-facing prompt and tools only. See [Permission model](#permission-model) for what the sandbox stack does and does not govern here.
- Tool-call streaming and terminal rendering are DSH-side; pi's TUI renderers do not travel.
- Preset plugin files are cached by Node's ESM loader: after editing `preset/pi-*.js`, restart the profile (or the harness process) to see changes.
