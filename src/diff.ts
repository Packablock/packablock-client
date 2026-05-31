export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
}

/**
 * Computes a line-by-line diff between two strings using the Longest Common Subsequence (LCS) algorithm.
 * @param strA - Original string
 * @param strB - New string
 * @returns Array of diff lines
 */
export function computeDiff(strA: string, strB: string): DiffLine[] {
  const linesA = strA.replace(/\r/g, '').split('\n');
  const linesB = strB.replace(/\r/g, '').split('\n');
  
  const n = linesA.length;
  const m = linesB.length;
  
  // Initialize DP table
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  // Backtrack to find the diff
  const diff: DiffLine[] = [];
  let i = n;
  let j = m;
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      diff.unshift({ type: 'unchanged', text: linesA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'added', text: linesB[j - 1] });
      j--;
    } else {
      diff.unshift({ type: 'removed', text: linesA[i - 1] });
      i--;
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
    red: '\x1b[31m',
    green: '\x1b[32m',
    gray: '\x1b[90m',
    reset: '\x1b[0m'
  };

  return diff.map(line => {
    if (line.type === 'added') {
      return `${colors.green}+ ${line.text}${colors.reset}`;
    } else if (line.type === 'removed') {
      return `${colors.red}- ${line.text}${colors.reset}`;
    } else {
      return `${colors.gray}  ${line.text}${colors.reset}`;
    }
  }).join('\n');
}
