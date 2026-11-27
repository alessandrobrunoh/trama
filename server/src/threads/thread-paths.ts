import { BadRequestException } from '@nestjs/common';
import { THREAD_PATH_MAX } from '../contracts/domain.js';

/** Why a path was refused, or null when it is fine. */
export function pathProblem(raw: string): string | null {
  const path = raw.trim();
  if (!path) return 'is empty';
  if (path.length > THREAD_PATH_MAX) return `is longer than ${THREAD_PATH_MAX} characters`;
  if (path.includes('\0')) return 'contains a null character';
  if (/^([/\\]|~|[A-Za-z]:)/.test(path)) return 'must be relative to the repository';
  if (path.split(/[/\\]/).includes('..')) return 'must not contain ".." segments';
  return null;
}

/**
 * Trims a repository path and refuses absolute paths and `..` segments. The path is otherwise kept
 * as given (a prefix like `src/auth/` or a glob like `src/auth/*` stays what the agent wrote).
 */
export function cleanThreadPath(raw: string): string {
  const path = raw.trim();
  const problem = pathProblem(path);
  if (problem) throw new BadRequestException(`Path "${path.slice(0, 80)}" ${problem}`);
  return path;
}

/** Cleans a list of paths and drops duplicates, keeping the order. */
export function cleanThreadPaths(raw: readonly string[]): string[] {
  return [...new Set(raw.map(cleanThreadPath))];
}

/**
 * Merges the files of a sync into the record: the new ones first (in the order sent), then the ones
 * the record already had, without duplicates, at most `max`.
 */
export function mergeFiles(
  existing: readonly string[],
  incoming: readonly string[],
  max: number,
): string[] {
  return [...new Set([...incoming, ...existing])].slice(0, max);
}

/** `./src//a\b` becomes `src/a/b`. Only used for comparing, never for storing. */
function normalize(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/{2,}/g, '/');
}

const hasGlob = (pattern: string) => pattern.includes('*');

const globCache = new Map<string, RegExp>();

/** `*` stays inside one path segment, `**` crosses segments, `**` followed by `/` may match nothing. */
function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const re = new RegExp(`^${out}$`);
  if (globCache.size > 500) globCache.clear();
  globCache.set(pattern, re);
  return re;
}

/**
 * Does one decision path cover `file`? It does when it is the file itself, a directory the file is
 * in (`src/auth/` or `src/auth`), or a glob that matches the whole file path.
 */
export function pathMatches(pattern: string, file: string): boolean {
  const p = normalize(pattern);
  const f = normalize(file);
  if (!p || !f) return false;
  if (hasGlob(p)) return globToRegExp(p).test(f);
  const dir = p.replace(/\/+$/, '');
  return f === dir || f.startsWith(`${dir}/`);
}

/** A decision covers a file when any of its paths does. A decision without paths covers none. */
export function decisionMatchesPath(paths: readonly string[], file: string): boolean {
  return paths.some((pattern) => pathMatches(pattern, file));
}
