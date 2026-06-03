import { readFileSync } from "node:fs";
import path from "node:path";

export interface LockfileData {
	packages: Record<string, string>;
	locations?: Record<string, { line: number; column: number }>;
	source: string;
}

/**
 * Parses package-lock.json content.
 */
function parsePackageLock(content: string): Record<string, string> {
	const cleanContent = content.replace(/,(\s*[\]}])/g, "$1");
	const data = JSON.parse(cleanContent);
	const packages: Record<string, string> = {};

	// Try modern package-lock format (v2/v3) or Bun v1.2+ JSON lockfile format
	if (data.packages) {
		for (const [pkgPath, pkgInfo] of Object.entries<any>(data.packages)) {
			if (!pkgPath) continue;
			// Extract package name from node_modules path
			const name = pkgPath.replace(/^node_modules\//, "");

			// Bun 1.2 JSON format stores signature arrays: ["pkg@version", ...]
			if (Array.isArray(pkgInfo)) {
				const sig = pkgInfo[0];
				if (typeof sig === "string") {
					if (sig.startsWith(name + "@")) {
						packages[name] = sig.slice(name.length + 1);
					} else {
						const lastAt = sig.lastIndexOf("@");
						if (lastAt !== -1) {
							packages[name] = sig.slice(lastAt + 1);
						}
					}
				}
				continue;
			}

			if (name && pkgInfo.version) {
				packages[name] = pkgInfo.version;
			}
		}
	}
	// Fall back to legacy package-lock format (v1)
	else if (data.dependencies) {
		for (const [name, pkgInfo] of Object.entries<any>(data.dependencies)) {
			if (pkgInfo.version) {
				packages[name] = pkgInfo.version;
			}
		}
	}

	return packages;
}

/**
 * Parses standard yarn.lock format (also output by bun bun.lockb).
 */
function parseYarnLock(text: string): Record<string, string> {
	const packages: Record<string, string> = {};
	const lines = text.split("\n");

	let currentPackageName: string | null = null;

	for (let line of lines) {
		line = line.trim();
		if (!line || line.startsWith("#")) continue;

		// Detect package signature line (e.g., "package-name@version, other@version:")
		// Or bun.lockb output which looks like lodash@^4.17.21:
		if (line.endsWith(":")) {
			const parts = line.slice(0, -1).split(",");
			const firstPart = (parts[0] ?? "").trim();

			// Extract package name before @ (handling scoped packages like @types/node)
			let name = "";
			if (firstPart.startsWith('"')) {
				// Strip quotes if present
				const unquoted = firstPart.replace(/^"|"$/g, "");
				name = getPackageNameFromRef(unquoted);
			} else {
				name = getPackageNameFromRef(firstPart);
			}

			if (name) {
				currentPackageName = name;
			}
		}
		// Detect version line (e.g., "version: 1.0.0" or "version \"1.0.0\"")
		else if (
			currentPackageName &&
			(line.startsWith("version ") || line.startsWith("version:"))
		) {
			const verMatch = line.match(/version\s+["']?([^"']+)["']?/);
			if (verMatch?.[1]) {
				packages[currentPackageName] = verMatch[1];
				currentPackageName = null; // Reset
			}
		}
	}

	return packages;
}

function getPackageNameFromRef(ref: string): string {
	// Scoped packages like @types/node@^18.0.0 -> @types/node
	if (ref.startsWith("@")) {
		const parts = ref.slice(1).split("@");
		return `@${parts[0] ?? ""}`;
	}
	// Normal packages like lodash@^4.17.21 -> lodash
	return ref.split("@")[0] ?? "";
}

/**
 * Main entrypoint to parse one or more lockfiles and return unified packages map.
 */
export function parseLockfiles(filepaths: string[]): LockfileData {
	const combinedPackages: Record<string, string> = {};
	const sources: string[] = [];
	const combinedLocations: Record<string, { line: number; column: number }> =
		{};

	for (const file of filepaths) {
		const absolutePath = path.resolve(file);
		const filename = path.basename(absolutePath);
		sources.push(filename);

		try {
			let fileContentForLocation = "";
			if (filename === "package-lock.json") {
				const content = readFileSync(absolutePath, "utf8");
				fileContentForLocation = content;
				const pkgs = parsePackageLock(content);
				Object.assign(combinedPackages, pkgs);
			} else if (filename === "bun.lockb") {
				// Run bun bun.lockb to output the human-readable text
				const proc = Bun.spawnSync(["bun", absolutePath]);
				if (proc.success) {
					const text = proc.stdout.toString("utf8");
					fileContentForLocation = text;
					const pkgs = parseYarnLock(text);
					Object.assign(combinedPackages, pkgs);
				} else {
					throw new Error(
						`Failed to parse bun.lockb using bun CLI: ${proc.stderr.toString("utf8")}`,
					);
				}
			} else if (
				filename === "yarn.lock" ||
				filename === "bun.lock" ||
				filename.endsWith(".lock")
			) {
				const content = readFileSync(absolutePath, "utf8");
				fileContentForLocation = content;
				try {
					const pkgs = parsePackageLock(content);
					Object.assign(combinedPackages, pkgs);
				} catch {
					const pkgs = parseYarnLock(content);
					Object.assign(combinedPackages, pkgs);
				}
			} else {
				// Treat as plain text or try JSON first
				const content = readFileSync(absolutePath, "utf8");
				fileContentForLocation = content;
				try {
					const pkgs = parsePackageLock(content);
					Object.assign(combinedPackages, pkgs);
				} catch {
					const pkgs = parseYarnLock(content);
					Object.assign(combinedPackages, pkgs);
				}
			}

			// Locate packages in fileContentForLocation
			for (const name of Object.keys(combinedPackages)) {
				if (!(name in combinedLocations)) {
					combinedLocations[name] = locatePackageInFile(
						fileContentForLocation,
						name,
					);
				}
			}
		} catch (err: any) {
			throw new Error(`Error parsing lockfile '${file}': ${err.message}`);
		}
	}

	return {
		packages: combinedPackages,
		locations: combinedLocations,
		source: sources.join(", "),
	};
}

export function parseSingleLockfileContent(
	filename: string,
	content: string,
): Record<string, string> {
	if (filename === "package-lock.json") {
		return parsePackageLock(content);
	}
	if (
		filename === "yarn.lock" ||
		filename === "bun.lock" ||
		filename.endsWith(".lock")
	) {
		try {
			return parsePackageLock(content);
		} catch {
			return parseYarnLock(content);
		}
	}
	try {
		return parsePackageLock(content);
	} catch {
		return parseYarnLock(content);
	}
}

/**
 * Locates the line and column number of a package key within a lockfile string.
 */
export function locatePackageInFile(
	content: string,
	name: string,
): { line: number; column: number } {
	const lines = content.split(/\r?\n/);
	const escapedName = name.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");

	const patterns = [
		new RegExp(`"node_modules/${escapedName}"\\s*:`),
		new RegExp(`"${escapedName}"\\s*:`),
		new RegExp(`(?:^|,)\\s*"?${escapedName}@`),
	];

	for (let i = 0; i < lines.length; i++) {
		const lineText = lines[i];
		if (lineText !== undefined) {
			for (const pattern of patterns) {
				const match = lineText.match(pattern);
				if (match && match.index !== undefined) {
					return {
						line: i + 1,
						column: match.index + 1,
					};
				}
			}
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const lineText = lines[i];
		if (lineText !== undefined) {
			const idx = lineText.indexOf(name);
			if (idx !== -1) {
				return {
					line: i + 1,
					column: idx + 1,
				};
			}
		}
	}

	return { line: 1, column: 1 };
}
