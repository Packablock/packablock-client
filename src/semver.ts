export interface SemVerRange {
	min: string;
	max: string; // 'infinity' or a version string
	type: "pinned" | "caret" | "tilde" | "open";
}

/**
 * Converts a SemVer string to a numeric value for linear scaling.
 */
export function semverToNumber(ver: string): number {
	const clean = ver.replace(/[^0-9.]/g, "");
	const parts = clean.split(".").map((x) => parseInt(x, 10) || 0);
	while (parts.length < 3) {
		parts.push(0);
	}
	const p0 = parts[0] ?? 0;
	const p1 = parts[1] ?? 0;
	const p2 = parts[2] ?? 0;
	return p0 * 1000000 + p1 * 1000 + p2;
}

/**
 * Lightweight, robust parser for extracting SemVer constraints boundaries.
 */
export function parseSemVerConstraint(
	constraint: string,
	currentPinned: string,
): SemVerRange {
	const clean = constraint.trim().replace(/^v/, "");

	if (clean === "*" || clean === "latest" || clean === "") {
		return { min: "0.0.0", max: "infinity", type: "open" };
	}

	// Pinned strict (e.g., "1.5.0", "=1.5.0")
	if (/^\d+\.\d+(\.\d+)?/.test(clean) || clean.startsWith("=")) {
		const ver = clean.replace(/^=/, "").trim();
		return { min: ver, max: ver, type: "pinned" };
	}

	// Tilde operator (e.g., "~1.5.0")
	if (clean.startsWith("~")) {
		const ver = clean.slice(1).trim();
		const parts = ver.split(".");
		const major = parts[0] || "0";
		const minor = parts[1] || "0";
		const maxVal = `${major}.${minor}.999`;
		return { min: ver, max: maxVal, type: "tilde" };
	}

	// Caret operator (e.g., "^1.5.0")
	if (clean.startsWith("^")) {
		const ver = clean.slice(1).trim();
		const parts = ver.split(".");
		const major = parts[0] || "0";
		const minor = parts[1] || "0";
		const patch = parts[2] || "0";

		if (major !== "0") {
			return { min: ver, max: `${major}.99.99`, type: "caret" };
		} else if (minor !== "0") {
			return { min: ver, max: `0.${minor}.99`, type: "caret" };
		} else {
			return { min: ver, max: `0.0.${patch}`, type: "caret" };
		}
	}

	// Open operators (e.g., ">=1.5.0")
	if (clean.startsWith(">=") || clean.startsWith(">")) {
		const ver = clean.replace(/^>=?/, "").trim();
		return { min: ver, max: "infinity", type: "open" };
	}

	// Open operators (e.g., "<=1.5.0")
	if (clean.startsWith("<=") || clean.startsWith("<")) {
		const ver = clean.replace(/^<=?/, "").trim();
		return { min: "0.0.0", max: ver, type: "open" };
	}

	// Default fallback: treat as pinned
	return { min: currentPinned, max: currentPinned, type: "pinned" };
}

/**
 * Renders the ASCII SemVer Candle chart for a package.
 */
export function renderCandle(
	minVer: string,
	firstVer: string,
	pinnedVer: string,
	latestVer: string,
	maxVer: string,
	width = 40,
): string {
	const vMin = semverToNumber(minVer);
	const vFirst = semverToNumber(firstVer);
	const vPinned = semverToNumber(pinnedVer);
	const vLatest = semverToNumber(latestVer);
	const isInfinity = maxVer === "infinity";

	const vMax = isInfinity
		? Math.max(vLatest, vPinned) +
			(Math.max(vLatest, vPinned) - vMin || 1000) * 1.5
		: semverToNumber(maxVer);

	const range = vMax - vMin || 1;

	// Scale value to [0, width - 1]
	const scale = (val: number) => {
		const pct = Math.max(0, Math.min(1, (val - vMin) / range));
		return Math.round(pct * (width - 1));
	};

	const idxMin = 0;
	const idxFirst = Math.max(idxMin, Math.min(width - 1, scale(vFirst)));
	const idxPinned = Math.max(idxFirst, Math.min(width - 1, scale(vPinned)));
	const idxLatest = Math.max(idxPinned, Math.min(width - 1, scale(vLatest)));
	const idxMax = isInfinity
		? width - 1
		: Math.max(idxLatest, Math.min(width - 1, scale(vMax)));

	// Initialize line with spaces
	const chars = new Array(width).fill(" ");

	// Left Wick: Min -> First
	for (let k = idxMin; k < idxFirst; k++) {
		chars[k] = "-";
	}

	// Candle Body: First -> Pinned
	for (let k = idxFirst; k <= idxPinned; k++) {
		chars[k] = "░";
	}

	// Pinned dot
	chars[idxPinned] = "●";

	// Unused Allowed Range: Pinned -> Latest
	for (let k = idxPinned + 1; k <= idxLatest; k++) {
		if (chars[k] === " " || chars[k] === "-") {
			chars[k] = "═";
		}
	}

	// Right Wick: Latest -> Max
	if (!isInfinity) {
		for (let k = idxLatest + 1; k < idxMax; k++) {
			if (chars[k] === " ") {
				chars[k] = "=";
			}
		}
		chars[idxMin] = "|";
		chars[idxMax] = "|";
	} else {
		// Open operator extension to infinity
		for (let k = idxLatest + 1; k < width - 2; k++) {
			if (chars[k] === " ") {
				chars[k] = "=";
			}
		}
		chars[idxMin] = "|";
		chars[width - 2] = "►";
		chars[width - 1] = "∞";
	}

	// Ensure active pin is always rendered on top
	chars[idxPinned] = "●";

	return chars.join("");
}
