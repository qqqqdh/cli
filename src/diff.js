// Line diff (LCS) and a compact colored hunk view for permission prompts.
import { gray, red, green } from './ui.js';

export function lineDiff(a, b) {
  const A = a.split(/\r?\n/), B = b.split(/\r?\n/);
  // Trim the common prefix/suffix so the DP table stays small.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  const ops = A.slice(0, pre).map((l, i) => ({ t: ' ', l, a: i + 1, b: i + 1 }));
  if (a2.length * b2.length > 4_000_000) {
    // shortcut: very large rewrites are shown as delete-all/add-all instead of a minimal diff.
    a2.forEach((l, i) => ops.push({ t: '-', l, a: pre + i + 1 }));
    b2.forEach((l, i) => ops.push({ t: '+', l, b: pre + i + 1 }));
  } else {
    const n = a2.length, m = b2.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { ops.push({ t: ' ', l: a2[i], a: pre + i + 1, b: pre + j + 1 }); i++; j++; }
      else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ t: '-', l: a2[i], a: pre + i + 1 }); i++; }
      else { ops.push({ t: '+', l: b2[j], b: pre + j + 1 }); j++; }
    }
  }
  A.slice(A.length - suf).forEach((l, k) => ops.push({ t: ' ', l, a: A.length - suf + k + 1, b: B.length - suf + k + 1 }));
  return ops;
}

/** Colored hunks with `context` lines around changes, capped at maxLines. */
export function renderDiff(oldText, newText, { context = 2, maxLines = 40 } = {}) {
  const ops = lineDiff(oldText, newText);
  const keep = new Set();
  ops.forEach((op, i) => {
    if (op.t !== ' ') for (let k = i - context; k <= i + context; k++) keep.add(k);
  });
  const out = [];
  let added = 0, removed = 0, last = -1;
  ops.forEach((op, i) => {
    if (op.t === '+') added++;
    if (op.t === '-') removed++;
    if (!keep.has(i)) return;
    if (last >= 0 && i > last + 1) out.push(gray('    ⋮'));
    last = i;
    const no = String(op.t === '+' ? op.b : op.a).padStart(4);
    if (op.t === '+') out.push(green(`${no} + ${op.l}`));
    else if (op.t === '-') out.push(red(`${no} - ${op.l}`));
    else out.push(gray(`${no}   ${op.l}`));
  });
  const shown = out.length > maxLines ? [...out.slice(0, maxLines), gray(`    … ${out.length - maxLines}줄 더`)] : out;
  return { lines: shown, added, removed };
}
