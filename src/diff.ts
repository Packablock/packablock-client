export interface DiffLine {
	type: "unchanged" | "added" | "removed";
	text: string;
}

/**
 * Computes a line-by-line diff between two strings using the Longest Common Subsequence (LCS) algorithm.
 * @param strA - Original string
 * @param strB - New string
 * @returns Array of diff lines
 */
export function computeDiff(strA: string, strB: string): DiffLine[] {
	const linesA = strA.replace(/\r/g, "").split("\n");
	const linesB = strB.replace(/\r/g, "").split("\n");

	const n = linesA.length;
	const m = linesB.length;

	// Initialize DP table
	const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));

	for (let i = 1; i <= n; i++) {
		const row = dp[i];
		const prevRow = dp[i - 1];
		if (!row || !prevRow) continue;
		for (let j = 1; j <= m; j++) {
			if (linesA[i - 1] === linesB[j - 1]) {
				row[j] = (prevRow[j - 1] ?? 0) + 1;
			} else {
				row[j] = Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
			}
		}
	}

	// Backtrack to find the diff
	const diff: DiffLine[] = [];
	let i = n;
	let j = m;

	while (i > 0 || j > 0) {
		const lineA = linesA[i - 1];
		const lineB = linesB[j - 1];
		if (
			i > 0 &&
			j > 0 &&
			lineA !== undefined &&
			lineB !== undefined &&
			lineA === lineB
		) {
			diff.unshift({ type: "unchanged", text: lineA });
			i--;
			j--;
		} else {
			const row = dp[i];
			const prevRow = dp[i - 1];
			if (
				j > 0 &&
				(i === 0 || (row && prevRow && (row[j - 1] ?? 0) >= (prevRow[j] ?? 0)))
			) {
				if (lineB !== undefined) {
					diff.unshift({ type: "added", text: lineB });
				}
				j--;
			} else {
				if (lineA !== undefined) {
					diff.unshift({ type: "removed", text: lineA });
				}
				i--;
			}
		}
	}

	return diff;
}

/**
 * Formats a diff output with ANSI colors.
 * @param diff - Diff list
 * @returns Colored string for the console
 */
export function formatDiffConsole(diff: DiffLine[]): string {
	const colors = {
		red: "\x1b[31m",
		green: "\x1b[32m",
		gray: "\x1b[90m",
		reset: "\x1b[0m",
	};

	return diff
		.map((line) => {
			if (line.type === "added") {
				return `${colors.green}+ ${line.text}${colors.reset}`;
			} else if (line.type === "removed") {
				return `${colors.red}- ${line.text}${colors.reset}`;
			} else {
				return `${colors.gray}  ${line.text}${colors.reset}`;
			}
		})
		.join("\n");
}
