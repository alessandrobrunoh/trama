import { describe, expect, it } from 'vitest';
import {
  isProjectKey,
  isReservedProjectKey,
  normalizeProjectKey,
  suggestProjectKey,
  uniqueProjectKey,
} from '../contracts/domain.js';

describe('project tags', () => {
  it('suggests short tags and normalizes custom tags', () => {
    expect(suggestProjectKey('Cora')).toBe('CORA');
    expect(suggestProjectKey('Trama')).toBe('TRMA');
    expect(suggestProjectKey('Security')).toBe('SECU');
    expect(suggestProjectKey('Project')).toBe('PROJ');
    expect(normalizeProjectKey('trma')).toBe('TRMA');
    expect(isProjectKey('TRMA')).toBe(true);
  });

  it('limits tags to four uppercase letters or digits and reserves special prefixes', () => {
    expect(isProjectKey('A')).toBe(true);
    expect(isProjectKey('A1B2')).toBe(true);
    expect(isProjectKey('1ABC')).toBe(false);
    expect(isProjectKey('ABCDE')).toBe(false);
    expect(isReservedProjectKey('adr')).toBe(true);
    expect(uniqueProjectKey('Unpr', [])).toBe('UNP1');
    expect(uniqueProjectKey('ADR', [])).toBe('ADR1');
    expect(uniqueProjectKey('Cora', ['CORA'])).toBe('COR1');
  });
});
