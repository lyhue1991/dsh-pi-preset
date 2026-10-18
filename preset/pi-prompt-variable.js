/**
 * pi-prompt-variable: register the `{{cwd}}` prompt variable for the persona.
 *
 * Newer DSH hosts (dsh-system-prompt 0.2.x) interpolate prompt sections
 * strictly against explicitly registered variables (`systemPrompt.variable()`)
 * and only `provider` and `model` ship globally — so the persona's `{{cwd}}`
 * reference fails every assembly with "unknown prompt variable". This row
 * re-registers `cwd` in the preset's own scope (scoped values shadow globals),
 * resolving the executing session's workspace per assembly, exactly how
 * ./pi-coding-tools.js scopes tool paths (`session.header.cwd`, falling back
 * to process.cwd()).
 *
 * Older hosts that predate `systemPrompt.variable()` resolved `{{cwd}}`
 * implicitly; there the registration is skipped and the reference keeps
 * resolving the old way.
 */
const name = "pi-prompt-variable";
const inject = ["systemPrompt"];

function apply(ctx) {
	const registry = ctx.systemPrompt;
	if (typeof registry?.variable !== "function") return;
	registry.variable("cwd", (assemblyContext) => {
		const agent = assemblyContext?.agent ?? assemblyContext?.scope;
		return agent?.session?.header?.cwd ?? process.cwd();
	});
}

export { apply, inject, name };
