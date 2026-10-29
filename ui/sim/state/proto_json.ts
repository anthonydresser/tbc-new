// Strips keys whose value is undefined before feeding stored JSON to protobuf-ts
// fromJson. Blobs serialized by older builds (or copied in-memory without a
// JSON.stringify round trip) can carry keys like "enchant": undefined, which
// fromJson rejects. Shared by the feature settings blobs that round-trip ItemSpecs.
export const sanitizeProtoJson = (json: any): any => {
	if (!json || typeof json !== 'object' || Array.isArray(json)) return json;
	const clean = Object.fromEntries(Object.entries(json as Record<string, any>).filter(([, value]) => value !== undefined));
	if (Array.isArray(clean.items)) clean.items = clean.items.map((item: any) => sanitizeProtoJson(item));
	return clean;
};
