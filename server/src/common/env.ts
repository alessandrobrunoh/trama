import { Logger } from '@nestjs/common';

const warned = new Set<string>();

/**
 * Reads `TRAMA_*` first and falls back to the legacy `NABLA_*` name from before the product was renamed.
 * Using the legacy name logs a deprecation warning once per variable.
 */
export function envWithLegacy(
  name: string,
  legacyName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const current = env[name];
  if (current !== undefined && current !== '') return current;
  const legacy = env[legacyName];
  if (legacy === undefined || legacy === '') return current;
  if (!warned.has(legacyName)) {
    warned.add(legacyName);
    new Logger('Env').warn(`${legacyName} is deprecated: rename it to ${name}.`);
  }
  return legacy;
}
