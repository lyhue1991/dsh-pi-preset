/**
 * The Pi preset as a declarative registration for DSH's agent-preset
 * REGISTRY (`@deepseek-ai/dsh-agent-preset-registry`, DSH Desktop 0.8+).
 *
 * Newer DSH hosts no longer scan `$DSH_HOME/.agent-presets` for preset
 * directories; presets are declared by calling `ctx.agentPresets.register()`
 * (see ./../plugin.js, which performs the call). The plugins array below is
 * therefore the same composition ./agent.cordis.yml spells out for the older
 * filesystem-roster DSH (`dsh web` 0.1.x, legacy dsh-desktop), with one
 * difference: relative names are anchored by the CALLER (plugin.js resolves
 * them to absolute `file:` URLs before registering), because the registry
 * mounts the array against its own baseUrl — inside the installed harness —
 * where `./pi-coding-tools.js` would not resolve.
 *
 * Keep this file and ./agent.cordis.yml in sync when the preset changes.
 */

/** pi's system prompt, the output of pi's own buildSystemPrompt. */
const PERSONA_PREFIX = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: bash(command, yield_time_ms?): run any shell command; long-running ones return session_id for bash_io
- bash_io: bash_io(session_id, chars?, yield_time_ms?): poll or send input to a bash process
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files
- grep: Search file contents for patterns (respects .gitignore)
- find: Find files by glob pattern (respects .gitignore)
- ls: List directory contents

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use read to examine files instead of cat or sed.
- \`bash\` runs all shell commands. Short commands finish within yield_time_ms (default 2s) and return full output directly.
- For commands still running after the wait, \`bash\` returns a \`session_id\` - poll it via \`bash_io\` (empty chars) or raise yield_time_ms for commands that need more time to produce output.
- Poll a running process by calling \`bash_io\` with an empty \`chars\` string and the \`session_id\`.
- Send input or Ctrl-C to a running process via \`bash_io\` with \`chars\` set to the input text or \`\\u0003\` for Ctrl-C.
- After a process exits (exit code returned), do NOT call \`bash_io\` for that \`session_id\` again.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files

Current working directory: {{cwd}}`;

/** The Pi preset definition handed to `agentPresets.register()`. */
const PI_PRESET = {
	id: "pi",
	name: "Pi",
	description: "使用 Pi 的系统提示词和工具集。⚠️ 始终以 Full access 权限运行。",
	order: 50,
	plugins: [
		// pi's own system prompt as the sole (complete) prompt section.
		{
			id: "persona",
			name: "@deepseek-ai/dsh-persona",
			config: {
				prefix: PERSONA_PREFIX,
				complete: true,
				includeRuntimeContext: false,
			},
		},

		// pi's real coding tools and pi-codex's non-blocking bash.
		{ id: "pi-coding-tools", name: "./pi-coding-tools.js" },
		{ id: "pi-codex-bash", name: "./pi-codex-bash.js" },

		// Mask host-inherited tools (Desktop PPT composer, workspace
		// dependencies) so pi's tool set stands alone.
		{ id: "pi-disable-host-tools", name: "./pi-disable-host-tools.js" },

		// DSH's standard skill stack and goal tools, as in `standard`.
		{ id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem" },
		{ id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
		{ id: "tool-goal", name: "@deepseek-ai/dsh-tool-goal" },

		// Compaction policy from `standard`.
		{
			id: "compaction",
			name: "cordis:group",
			group: true,
			isolate: { compaction: true, toolResultPruner: true },
			config: [
				{ id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
				{ id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
				{
					id: "tool-result-pruner",
					name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
					config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
				},
			],
		},
	],
};

export { PI_PRESET };
