// Where a workstream's status comes from, phrased for badges and tooltips. Pure: it only reads the
// server's `statusSource` and `derivedStatus`. A pin or a historic shipped is never proof of the outcome.
import { WORKSTREAM_STATUS_META } from '../../core/meta';
import type { Workstream } from '../../core/contracts/domain';

export function statusSourceInfo(ws: Pick<Workstream, 'statusSource' | 'derivedStatus'>): { label: string; hint: string } {
  switch (ws.statusSource) {
    case 'override':
      return {
        label: 'pinned',
        hint: `Pinned by hand, not proof of the outcome. The facts say ${WORKSTREAM_STATUS_META[ws.derivedStatus].label}.`,
      };
    case 'legacy':
      return {
        label: 'historic',
        hint: 'Shipped before acceptance criteria were required. Nothing proves the outcome; it stays shipped.',
      };
    default:
      return { label: 'derived', hint: 'Derived from the work.' };
  }
}
