/**
 * `POST /api/admin/reset` wipes every table. It is off unless TRAMA_ENABLE_ADMIN_RESET=true, and it
 * stays off under NODE_ENV=production even then (`node dist/main` does not set NODE_ENV, so the
 * flag, not the absence of NODE_ENV, is what opts a dev or test instance in).
 */
export function adminResetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.TRAMA_ENABLE_ADMIN_RESET === 'true';
}
