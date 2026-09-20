/**
 * Hide dsh-ppt-composer's host-level tools from the Pi preset.
 *
 * Desktop installs the composer in the host composition, so it cannot be
 * disabled from one agent preset. DSH's scoped restriction is the supported
 * way to remove inherited global tools for only this preset. Keep the list
 * explicit so unrelated third-party presentation tools remain available.
 */
const name = "pi-disable-ppt-tools";
const inject = ["tools"];

const PPT_TOOL_NAMES = [
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
];

function apply(ctx) {
	// The composer is bundled with Desktop but may be absent in a plain DSH
	// deployment. restrict() rejects unknown names, so only mask present tools.
	const deny = PPT_TOOL_NAMES.filter((toolName) => ctx.tools.get(toolName) !== undefined);
	if (deny.length > 0) ctx.tools.restrict({ deny });
}

export { PPT_TOOL_NAMES, apply, inject, name };
