import { describe, expect, it } from 'vitest';
import { lineDiff } from '../../../src/web/lib/diff';

describe('lineDiff', () => {
  it('produces a minimal line diff', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'remove', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'same', text: 'c' },
      { op: 'add', text: 'd' },
    ]);
  });

  it('declines inputs that are too large to diff in the browser', () => {
    const big = Array.from({ length: 3000 }, (_, i) => String(i)).join('\n');
    expect(lineDiff(big, `${big}\nx`)).toBeNull();
  });
});
