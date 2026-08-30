/**
 * dsh-pi-preset permission pin — default Full access for new Pi sessions.
 *
 * Host-side bundle row. Pi preset sessions bypass the DSH sandbox entirely
 * (the preset's write/edit hit node:fs directly and its bash spawns outside
 * ctx.shell — see the package README "Permission model"), so read-only and
 * workspace-write are misleading defaults for them. This row listens for
 * session creation and, when the session STARTED with the Pi preset
 * (`session.header.agentPreset`, the roster id of the mirrored preset —
 * "pi"), appends the three permission log events that select the
 * danger-full-access preset. The preset TABLE is untouched: the permission
 * menu still offers read-only / workspace-write / danger-full-access, and a
 * user switch (`/permission`, or the session control) stays a normal logged
 * override like any other session.
 *
 * The three events are the same log-only records the stock services write
 * (`permission/preset` via @deepseek-ai/dsh-permission-presets, `sandbox/mode`
 * via @deepseek-ai/dsh-sandbox-policy, `approval/policy` via
 * @deepseek-ai/dsh-user-approval); their folds take the LAST event of each
 * type, so this row's values win simply by loading after the base layer —
 * which bundle ordering guarantees (plugin layers apply after dsh-base, whose
 * permission row pins the deployment default first).
 *
 * Sessions that switch TO the Pi preset after creation are not re-pinned:
 * the creation header is read once, matching `resolveSessionPreset`'s
 * header-plus-log contract only at the creation boundary. Switch manually or
 * via /permission in that case.
 *
 * The preset id defaults to "pi" (the mirror's user-root directory name) and
 * can be overridden with DSH_PI_PRESET_PIN_ID.
 */
const name = "dsh-pi-preset-permission-pin";

/** Last event of one type from the session log, or undefined. */
function lastEvent(events, type) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === type) return event.data;
	}
}

function apply(ctx) {
	if (typeof ctx.on !== "function") return;
	const dispose = ctx.on("session/created", (session) => {
		const presetId = process.env.DSH_PI_PRESET_PIN_ID || "pi";
		if (session?.header?.agentPreset !== presetId) return;
		const events = session.events ?? [];
		const mode = lastEvent(events, "sandbox/mode")?.mode;
		const policy = lastEvent(events, "approval/policy")?.policy;
		const preset = lastEvent(events, "permission/preset")?.preset;
		if (mode === "danger-full-access" && policy === "never" && preset === "danger-full-access") return;
		if (preset !== "danger-full-access") session.append("permission/preset", { preset: "danger-full-access" });
		if (mode !== "danger-full-access") session.append("sandbox/mode", { mode: "danger-full-access" });
		if (policy !== "never") session.append("approval/policy", { policy: "never" });
	});
	return typeof dispose === "function" ? dispose : undefined;
}

export { apply, name };
