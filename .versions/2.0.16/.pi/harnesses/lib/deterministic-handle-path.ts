export type DeterministicFilesystemHandle = {
	v: 1;
	kind: "file" | "inventory";
	path: string;
	hash: string;
	offset: number;
};

export function decodeDeterministicHandle(value: string): DeterministicFilesystemHandle {
	try {
		if (!value.startsWith("t5:")) throw new Error();
		const parsed = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8"));
		if (parsed?.v !== 1 || !["file", "inventory"].includes(parsed.kind) || typeof parsed.path !== "string" || typeof parsed.hash !== "string" || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error();
		return parsed;
	} catch {
		throw new Error("Invalid deterministic filesystem handle");
	}
}

/** Resolve a handle's bound path without reading source bytes; used by policy hooks before execution. */
export function deterministicHandlePath(value: string): string {
	return decodeDeterministicHandle(value).path;
}
