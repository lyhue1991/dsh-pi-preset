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
 *
 * Text-only escape hatch used by the bash bridge, whose tools never emit
 * images. The coding-tools bridge uses `piToolValue` instead so image blocks
 * survive.
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

/** Media types DSH's attachment store accepts for image blocks. */
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Convert a pi AgentToolResult into the canonical JSON value DSH's
 * `output.render` can project into real content blocks — including images.
 *
 * pi tools (notably `read`) carry images as inline base64 blocks
 * (`{type:"image", data, mimeType}`). DSH tools cannot carry inline bytes;
 * an image must be durably committed to the attachment store and referenced
 * by an `ImageAttachmentRef` (`{type:"image", attachment}`). So each pi image
 * block is decoded and saved via `attachments.saveImage` here, inside
 * `execute` (the async, context-aware side); `render` then turns the stored
 * references back into image blocks for the model.
 *
 * @param result - pi AgentToolResult (content blocks with inline base64 images).
 * @param attachments - DSH AttachmentStore (may be undefined when not mounted).
 * @returns `{ text, images }` where `images` holds durable image references.
 */
export async function piToolValue(result, attachments) {
	const blocks = result?.content ?? [];
	const text = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const images = [];
	const notes = [];
	for (const block of blocks) {
		if (block.type !== "image") continue;
		if (
			attachments === undefined
			|| typeof block.data !== "string"
			|| !IMAGE_MEDIA_TYPES.has(block.mimeType)
		) {
			notes.push(
				`[1 image block omitted (${block.mimeType ?? "unknown media type"}): not storable as a DSH image attachment]`,
			);
			continue;
		}
		try {
			images.push(await attachments.saveImage({
				data: Buffer.from(block.data, "base64"),
				mediaType: block.mimeType,
			}));
		} catch (error) {
			notes.push(
				`[1 image block omitted: attachment storage refused it (${error?.message ?? "unknown error"})]`,
			);
		}
	}
	return { text: [text, ...notes].filter(Boolean).join("\n"), images };
}

/** Output declaration shared by every pi tool that may return images. */
export const piToolOutput = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: {
			text: { type: "string" },
			images: {
				type: "array",
				items: { type: "object", additionalProperties: true },
			},
		},
	},
	render(_args, value) {
		const blocks = [];
		if (typeof value.text === "string" && value.text.length > 0) {
			blocks.push({ type: "text", text: value.text });
		}
		for (const ref of Array.isArray(value.images) ? value.images : []) {
			blocks.push({ type: "image", attachment: ref });
		}
		if (blocks.length === 0) blocks.push({ type: "text", text: "(empty result)" });
		return blocks;
	},
};
