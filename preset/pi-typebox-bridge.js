/**
 * Shared typebox -> DSH parameter-schema conversion for the pi preset's
 * tool plugins. DSH requires explicit `additionalProperties` on objects,
 * marks requiredness with a per-property `required: true`, and rejects
 * unknown constraint keys — so only whitelisted fields cross the bridge.
 */

/** Convert one typebox schema node into DSH's author-facing value schema. */
export function typeboxToDsh(node, required) {
	const out = {};
	if (required === true) out.required = true;
	if (node.description !== undefined) out.description = node.description;
	if (node.default !== undefined) out.default = node.default;
	if (node.enum !== undefined) out.enum = node.enum;
	if (node.const !== undefined) out.const = node.const;
	switch (node.type) {
		case "object": {
			out.type = "object";
			// pi treats objects as open; stay permissive for extra model keys.
			out.additionalProperties = node.additionalProperties === false ? false : true;
			if (node.properties !== undefined) {
				const requiredSet = new Set(node.required ?? []);
				out.properties = Object.fromEntries(
					Object.entries(node.properties).map(([key, value]) => [
						key,
						typeboxToDsh(value, requiredSet.has(key)),
					]),
				);
			}
			return out;
		}
		case "array":
			out.type = "array";
			if (node.items !== undefined) out.items = typeboxToDsh(node.items);
			return out;
		case "string":
		case "number":
		case "integer":
		case "boolean":
		case "null":
			out.type = node.type;
			return out;
		default:
			throw new Error(`pi preset: unsupported typebox node type "${node.type}"`);
	}
}

/** Convert a typebox root object schema into DSH's parameter property map. */
export function typeboxRootToParameters(node) {
	if (node.type !== "object") throw new Error("pi preset: pi tool parameters must be object-rooted");
	const requiredSet = new Set(node.required ?? []);
	return Object.fromEntries(
		Object.entries(node.properties ?? {}).map(([key, value]) => [
			key,
			typeboxToDsh(value, requiredSet.has(key)),
		]),
	);
}

/**
 * Flatten a pi AgentToolResult's content blocks into the text a DSH tool
 * returns; image blocks degrade to a count note.
 */
export function flattenPiContent(result) {
	const blocks = result?.content ?? [];
	const text = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const images = blocks.filter((block) => block.type === "image").length;
	return images > 0
		? `${text}\n[${images} image block(s) omitted: the pi->DSH bridge returns text only]`
		: text;
}
