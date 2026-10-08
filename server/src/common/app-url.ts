import { DEFAULT_CORS_ORIGINS } from '../configure-app.js';

/**
 * Base URL of the web app, used in links sent by email. `APP_URL`, else the first allowed CORS
 * origin (the web app is the only browser origin that talks to the API).
 */
export function appUrl(): string {
  const configured = process.env.APP_URL?.trim();
  const first = process.env.CORS_ORIGIN?.split(',')[0]?.trim() || DEFAULT_CORS_ORIGINS[0];
  return (configured || first).replace(/\/+$/, '');
}
