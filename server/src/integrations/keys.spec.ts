import { extractKeys } from './keys.js';

describe('extractKeys', () => {
  const known = new Set(['AUTH-42', 'WEB-7', 'PLAT-1']);

  it('finds keys in free text and de-duplicates', () => {
    expect(extractKeys(['Fix AUTH-42 and WEB-7 (see AUTH-42)'])).toEqual(['AUTH-42', 'WEB-7']);
  });
  it('validates against known workstream keys', () => {
    expect(extractKeys(['AUTH-42 UTF-8 HTTP-2 NOPE-1'], { known })).toEqual(['AUTH-42']);
  });
  it('is case-sensitive for text but not for branch names', () => {
    expect(extractKeys(['auth-42 refactor'])).toEqual([]);
    expect(extractKeys(['feature/auth-42-refresh-rotation'], { ignoreCase: true, known })).toEqual(['AUTH-42']);
  });
  it('respects word boundaries and ignores empty input', () => {
    expect(extractKeys(['XAUTH-420', 'a-1', null, undefined, ''], { known })).toEqual([]);
    expect(extractKeys(['[AUTH-42]: title', 'refs:WEB-7.'], { known })).toEqual(['AUTH-42', 'WEB-7']);
  });
});
