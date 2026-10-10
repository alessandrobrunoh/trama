const DEMO_LOGIN_ON = new Set(['1', 'true', 'yes', 'on']);
const DEMO_LOGIN_OFF = new Set(['0', 'false', 'no', 'off']);

/**
 * Whether the sign-in page should show the shared demo credentials.
 * `DEMO_LOGIN` accepts 1/true/yes/on and 0/false/no/off. When unset, the panel is shown
 * outside production and hidden when `NODE_ENV=production`.
 */
export function demoLoginEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.DEMO_LOGIN?.trim().toLowerCase();
  if (!raw) return env.NODE_ENV !== 'production';
  if (DEMO_LOGIN_ON.has(raw)) return true;
  if (DEMO_LOGIN_OFF.has(raw)) return false;
  return env.NODE_ENV !== 'production';
}
