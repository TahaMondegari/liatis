/** Minimal unified diff (Myers via LCS table; inputs are small source files). */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return `--- a/${path}\n+++ b/${path}\n@@ file too large for inline diff @@`;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: { t: " " | "-" | "+"; line: string; ai: number; bi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ t: " ", line: a[i]!, ai: i++, bi: j++ });
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: "-", line: a[i]!, ai: i++, bi: j });
    else ops.push({ t: "+", line: b[j]!, ai: i, bi: j++ });
  }
  while (i < n) ops.push({ t: "-", line: a[i]!, ai: i++, bi: j });
  while (j < m) ops.push({ t: "+", line: b[j]!, ai: i, bi: j++ });

  const out = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === " ") {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.t !== " ") {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run]!.t === " ") run++;
      if (run > context * 2 || end + run >= ops.length) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aStart = (hunk[0]?.ai ?? 0) + 1;
    const bStart = (hunk[0]?.bi ?? 0) + 1;
    out.push(`@@ -${aStart},${hunk.filter((o) => o.t !== "+").length} +${bStart},${hunk.filter((o) => o.t !== "-").length} @@`);
    for (const o of hunk) out.push(`${o.t}${o.line}`);
    k = end;
  }
  return out.join("\n");
}
