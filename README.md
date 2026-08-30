# dsh-pi-preset

A DSH plugin that ships the `pi` agent preset: pi's real system prompt and pi's real coding tools, running on the DeepSeek Harness.

## What you get

A new agent preset named **Pi**:

- **System prompt** — the output of pi's own `buildSystemPrompt` (`@earendil-works/pi-coding-agent` 0.84.4), mounted as the sole prompt section.
- **Tools** — pi's real tool implementations (`read`/`edit`/`write`/`grep`/`find`/`ls` via pi's own factories), with pi's synchronous `bash` replaced by **pi-codex's non-blocking `bash` + `bash_io`** (spawn, poll, write stdin, Ctrl-C; long-running commands return a `session_id` instead of blocking).
- **Skills** — DSH's standard skill stack (the `skill` tool and catalog messages).
- **Goals** — DSH's standard goal tools (`create_goal` / `get_goal` / `update_goal`).
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

Then restart the profile. On first boot the bootstrap row:

1. materializes the vendored `preset/node_modules` (`npm install --ignore-scripts`),
2. mirrors the preset files into `~/.dsh/.agent-presets/pi` (the roster's user root — the only third-party registration channel) and symlinks that mirror's `node_modules` back to the vendored install.

A pre-existing real `~/.dsh/.agent-presets/pi` that is not this mirror (a hand-installed copy) is renamed to `pi.pre-dsh-pi-preset-<timestamp>` (not deleted). The installed package is the single source of truth: every boot re-mirrors the preset files, so edit the preset in this checkout (or under the installed package's `preset/`) and restart to propagate.

Select **Pi** in the agent-preset picker (or set the `agent-presets.default` setting) for new sessions.

## Uninstall

```
dsh plugin --profile web remove @lyhue1991/dsh-pi-preset
```

and remove the symlink at `~/.dsh/.agent-presets/pi` if you no longer need the preset.

## Notes and boundaries

- The agent loop, sandbox/approval stack, model route, and session persistence remain DSH's; the preset replaces the model-facing prompt and tools only.
- pi's `bash` (and pi-codex's) spawn processes directly — no DSH command sandbox applies to them, matching pi's no-permission-system design. File tools still follow DSH's file policy.
- Tool-call streaming and terminal rendering are DSH-side; pi's TUI renderers do not travel.
- Preset plugin files are cached by Node's ESM loader: after editing `preset/pi-*.js`, restart the profile (or the harness process) to see changes.
