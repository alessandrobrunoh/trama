import { describe, expect, it } from 'vitest';
import { isProjectIcon } from './project-icon.js';

describe('isProjectIcon', () => {
  it('accepts lucide kebab-case names', () => {
    for (const name of ['rocket', 'bar-chart-3', 'git-pull-request'])
      expect(isProjectIcon(name)).toBe(true);
  });

  it('accepts a single emoji, including ZWJ sequences and flags', () => {
    for (const e of ['🚀', '❤️', '👩‍💻', '👍🏽', '🇮🇹'])
      expect(isProjectIcon(e)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const v of [
      '',
      'Rocket',
      'rocket_ship',
      '-rocket',
      'rocket-',
      '🚀🚀',
      '🚀 ',
      'a b',
      '<script>',
      3,
      null,
      undefined,
    ])
      expect(isProjectIcon(v)).toBe(false);
    expect(isProjectIcon('a'.repeat(49))).toBe(false);
  });
});
