import { NablaBaseline1791387672836 } from './1791387672836-NablaBaseline.js';
import { IntegrationsWebhooks1791500000000 } from './1791500000000-IntegrationsWebhooks.js';
import { Issues1791600000000 } from './1791600000000-Issues.js';
import { DropExecutions1791700000000 } from './1791700000000-DropExecutions.js';

/** Registered explicitly (not by glob) so they load identically from dist and from vitest. */
export const MIGRATIONS = [NablaBaseline1791387672836, IntegrationsWebhooks1791500000000, Issues1791600000000, DropExecutions1791700000000];
