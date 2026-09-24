/**
 * pi-disable-host-tools: hide host-inherited global tools from the Pi preset.
 *
 * The Desktop composition registers host-plane tools that every session
 * inherits; pi's tool set is meant to stand alone, so this row masks the ones
 * that leak through.
 *
 * The restriction is applied when each AGENT is created (`agent/created`
 * reaches this preset scope for every session mounted on it): at preset
 * activation the global tools are not registered yet, while at agent creation
 * they resolve, and the restriction layer lives exactly as long as the agent.
 * Restrictions intersect, so repeats are harmless. Names are filtered to what
 * is present, so deployments without these host tools are unaffected.
 */
const name = "pi-disable-host-tools";

const HOST_TOOL_NAMES = [
	// dsh-ppt-composer (host plane, bundled with Desktop)
	"pptd_check",
	"pptd_list_files",
	"pptd_read_file",
	"pptd_write_file",
	"pptd_add_asset",
	"pptd_import",
	"pptd_render",
	"ppt_list_templates",
	"ppt_get_template_reference",
	"ppt_get_template_pages",
	// dsh-tool-workspace-dependencies (bundled Python/Node/pnpm paths)
	"load_workspace_dependencies",
];

function apply(ctx) {
	try {
		ctx.on("agent/created", ({ agent }) => {
			const tools = agent?.ctx?.tools;
			if (tools === undefined) return;
			const deny = HOST_TOOL_NAMES.filter((toolName) => tools.get(toolName) !== undefined);
			if (deny.length > 0) tools.restrict({ deny });
		});
	} catch {}
}

export { HOST_TOOL_NAMES, apply, name };
