/** A lucide icon name in kebab-case (`rocket`, `bar-chart-3`). */
const LUCIDE_NAME = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
/** One emoji: a pictograph (optionally skin-toned / variation-selected, ZWJ sequences allowed) or a flag. */
const EMOJI =
  '\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?(?:\\u200D\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)*|\\p{Regional_Indicator}{2}';

export const PROJECT_ICON_MAX = 48;

/** Accepted `Project.icon` values: a lucide kebab-case name or a single emoji. */
export const PROJECT_ICON_PATTERN = new RegExp(
  `^(?:${LUCIDE_NAME}|${EMOJI})$`,
  'u',
);

/** Is `value` an acceptable `Project.icon`? */
export function isProjectIcon(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PROJECT_ICON_MAX &&
    PROJECT_ICON_PATTERN.test(value)
  );
}
