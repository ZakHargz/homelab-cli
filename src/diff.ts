/**
 * Minimal line-based diff, LCS (longest common subsequence) based, output shaped
 * like a compact unified diff: unchanged lines prefixed with a space, removed
 * lines with "-", added lines with "+". Good enough for eyeballing a compose-file
 * diff in a terminal; not a replacement for a real diff library if this ever needs
 * context lines, hunk headers, or large-file performance.
 *
 * O(n*m) time/space via a full DP table — fine for compose files (tens to low
 * hundreds of lines), not suitable for huge inputs.
 */
export function diffLines(oldText: string, newText: string): string[] {
  const oldLines = oldText.length > 0 ? oldText.split("\n") : [];
  const newLines = newText.length > 0 ? newText.split("\n") : [];

  const n = oldLines.length;
  const m = newLines.length;

  // dp[i][j] = length of LCS of oldLines[i..n) and newLines[j..m)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i]!;
      row[j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, row[j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push(`  ${oldLines[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${oldLines[i]}`);
      i++;
    } else {
      out.push(`+ ${newLines[j]}`);
      j++;
    }
  }
  while (i < n) {
    out.push(`- ${oldLines[i]}`);
    i++;
  }
  while (j < m) {
    out.push(`+ ${newLines[j]}`);
    j++;
  }

  return out;
}

/** True if diffLines(oldText, newText) contains any +/- lines. */
export function hasChanges(oldText: string, newText: string): boolean {
  return oldText !== newText;
}

/** Summarizes a diffLines() result as counts, e.g. "3 added, 1 removed, 12 unchanged". */
export function summarizeDiff(diff: string[]): string {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of diff) {
    if (line.startsWith("+ ")) added++;
    else if (line.startsWith("- ")) removed++;
    else unchanged++;
  }
  return `${added} added, ${removed} removed, ${unchanged} unchanged`;
}
