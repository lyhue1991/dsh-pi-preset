/**
 * pi-coding-tools: register pi's real coding tools as DSH model tools.
 *
 * Each pi ToolDefinition (created by @earendil-works/pi-coding-agent's own
 * factories) is adapted once into the DSH `tools` registry:
 *   - pi's typebox `parameters` is converted via ./pi-typebox-bridge.js;
 *   - `execute(toolCallId, params, signal, onUpdate, ctx)` is bridged onto
 *     DSH's `execute(args, exec)`;
 *   - pi's text blocks pass through, and pi's inline base64 image blocks
 *     (from `read` on image files) are decoded and durably committed to the
 *     DSH attachment store, so the result carries real image blocks instead
 *     of a "1 image block(s) omitted" note.
 *
 * Tools resolve the calling session's workspace per call
 * (`exec.agent.session.header.cwd`, falling back to process.cwd()), matching
 * how `dsh-tool-fs` scopes paths per session. Definitions are cached per cwd;
 * pi's edit/write tools already serialize mutations per absolute path via
 * their own file-mutation queue.
 *
 * bash is NOT registered here: pi's synchronous bash is replaced by
 * pi-codex's non-blocking bash + bash_io (see ./pi-codex-bash.js), which
 * keep the same tool name.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { piToolOutput, piToolValue, typeboxRootToParameters } from "./pi-typebox-bridge.js";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "./node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const name = "pi-coding-tools";
const inject = ["tools"];

/** pi tool factories with their options; order is the prompt's tools-list order. */
const FACTORIES = [
	["read", createReadToolDefinition, {}],
	["edit", createEditToolDefinition, {}],
	["write", createWriteToolDefinition, {}],
	["grep", createGrepToolDefinition, {}],
	["find", createFindToolDefinition, {}],
	["ls", createLsToolDefinition, {}],
];

/** One registered DSH tool per pi tool, dispatching to a per-cwd definition. */
function apply(ctx) {
	/** @type {Map<string, Map<string, object>>} cwd -> tool name -> pi ToolDefinition */
	const cache = new Map();
	const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();
	const definitions = (cwd) => {
		let perTool = cache.get(cwd);
		if (perTool === undefined) {
			perTool = new Map(
				FACTORIES.map(([toolName, factory, options]) => [toolName, factory(cwd, options)]),
			);
			cache.set(cwd, perTool);
		}
		return perTool;
	};

	for (const [toolName] of FACTORIES) {
		// A throwaway instance supplies the cwd-independent description and schema.
		const probe = definitions(process.cwd()).get(toolName);
		ctx.tools.register(
			defineTool({
				name: probe.name,
				description: probe.description,
				parameters: typeboxRootToParameters(probe.parameters),
				output: piToolOutput,
				async execute(args, exec) {
					const definition = definitions(sessionCwd(exec)).get(toolName);
					const result = await definition.execute(
						exec.callId ?? "pi-tool-call",
						args,
						exec.signal,
						undefined,
						undefined,
					);
					return piToolValue(result, ctx.get("attachments"));
				},
			}),
		);
	}
}

export { apply, inject, name };
