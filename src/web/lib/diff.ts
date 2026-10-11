export interface DiffLine {
  op: 'same' | 'add' | 'remove';
  text: string;
}

const maxCells = 4_000_000;

/** Line-level LCS diff. Returns null when inputs are too large to diff in the browser. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > maxCells) return null;

  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] ?? '';
    const right = b[j] ?? '';
    if (left === right) {
      out.push({ op: 'same', text: left });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push({ op: 'remove', text: left });
      i++;
    } else {
      out.push({ op: 'add', text: right });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ op: 'remove', text: a[i] ?? '' });
  for (; j < b.length; j++) out.push({ op: 'add', text: b[j] ?? '' });
  return out;
}
