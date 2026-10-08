import { NablaBaseline1791387672836 } from './1791387672836-NablaBaseline.js';
import { IntegrationsWebhooks1791500000000 } from './1791500000000-IntegrationsWebhooks.js';
import { Issues1791600000000 } from './1791600000000-Issues.js';
import { DropExecutions1791700000000 } from './1791700000000-DropExecutions.js';
import { MilestonesEstimates1791810000000 } from './1791810000000-MilestonesEstimates.js';
import { AccessWebhooks1791820000000 } from './1791820000000-AccessWebhooks.js';
import { TokenPermissions1791900000000 } from './1791900000000-TokenPermissions.js';
import { Invites1792000000000 } from './1792000000000-Invites.js';
import { Favorites1792100000000 } from './1792100000000-Favorites.js';
import { Notifications1792200000000 } from './1792200000000-Notifications.js';
import { Projects1792300000000 } from './1792300000000-Projects.js';
import { WorkstreamProject1792400000000 } from './1792400000000-WorkstreamProject.js';

/** Registered explicitly (not by glob) so they load identically from dist and from vitest. */
export const MIGRATIONS = [NablaBaseline1791387672836, IntegrationsWebhooks1791500000000, Issues1791600000000, DropExecutions1791700000000, MilestonesEstimates1791810000000, AccessWebhooks1791820000000, TokenPermissions1791900000000, Invites1792000000000, Favorites1792100000000, Notifications1792200000000, Projects1792300000000, WorkstreamProject1792400000000];
