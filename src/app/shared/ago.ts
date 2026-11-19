import { Pipe, type PipeTransform } from '@angular/core';

/** Compact relative time: "now", "5m", "3h", "2d", "3w", "4mo". Past or future (future gets "in "). */
export function ago(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  const abs = Math.abs(diff);
  const min = 60_000;
  const out =
    abs < 45_000
      ? 'now'
      : abs < 60 * min
        ? `${Math.max(1, Math.round(abs / min))}m`
        : abs < 24 * 60 * min
          ? `${Math.round(abs / (60 * min))}h`
          : abs < 14 * 24 * 60 * min
            ? `${Math.round(abs / (24 * 60 * min))}d`
            : abs < 60 * 24 * 60 * min
              ? `${Math.round(abs / (7 * 24 * 60 * min))}w`
              : `${Math.round(abs / (30 * 24 * 60 * min))}mo`;
  if (out === 'now') return out;
  return diff < 0 ? `in ${out}` : out;
}

/** `{{ iso | ago }}` -> "3h". */
@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(value: string | undefined | null): string {
    return ago(value);
  }
}
