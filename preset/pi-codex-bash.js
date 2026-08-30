/**
 * pi-codex-bash: pi-codex's non-blocking bash, bridged onto the DSH tools
 * registry.
 *
 * Loads the REAL pi-codex extension (@lyhue1991/pi-codex, vendored at
 * ./pi-codex/bash.js) through a minimal ExtensionAPI stub and registers its
 * two ToolDefinitions as DSH model tools:
 *
 *   bash     - spawn a command, wait up to yield_time_ms (default 2s) for
 *              output, then return. If still running, returns a session_id
 *              instead of blocking the agent.
 *   bash_io  - poll a running process (empty chars), write to its stdin, or
 *              send Ctrl-C ("\u0003"); always waits yield_time_ms for output.
 *
 * pi-codex's extension context only provides `cwd`, which the bridge fills
 * with the executing session's workspace per call (same scoping as
 * ./pi-coding-tools.js). Streaming onUpdate is dropped (DSH defineTool tools
 * are buffered). The extension's session_shutdown handlers run when this
 * plugin's fiber is disposed, killing every tracked process tree.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { flattenPiContent, typeboxRootToParameters } from "./pi-typebox-bridge.js";
import piCodexExtension from "./pi-codex/bash.js";

const name = "pi-codex-bash";
const inject = ["tools"];

function apply(ctx) {
	/** Minimal ExtensionAPI capturing what pi-codex registers. */
	const tools = [];
	const shutdownHandlers = [];
	piCodexExtension({
		registerTool(definition) {
			tools.push(definition);
		},
		on(event, handler) {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		},
	});

	const bashTool = tools.find((tool) => tool.name === "bash");
	const bashIoTool = tools.find((tool) => tool.name === "bash_io");
	if (bashTool === undefined || bashIoTool === undefined) {
		throw new Error("pi-codex-bash: vendored extension did not register bash and bash_io");
	}

	const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();

	for (const definition of [bashTool, bashIoTool]) {
		ctx.tools.register(
			defineTool({
				name: definition.name,
				description: definition.description,
				parameters: typeboxRootToParameters(definition.parameters),
				output: {
					schema: { type: "string" },
					render(_args, value) {
						return [{ type: "text", text: value }];
					},
				},
				async execute(args, exec) {
					const result = await definition.execute(
						exec.callId ?? "pi-codex-call",
						args,
						exec.signal,
						undefined,
						{ cwd: sessionCwd(exec) },
					);
					return flattenPiContent(result);
				},
			}),
		);
	}

	ctx.effect(
		() => () => {
			for (const handler of shutdownHandlers) {
				try {
					void handler();
				} catch {}
			}
		},
		"pi-codex-bash.shutdown()",
	);
}

export { apply, inject, name };
