import type { Release, ReleasePipelineType, ReleaseStatus } from '../../core';

export const RELEASE_STATUS_META: Record<ReleaseStatus, { label: string; pill: string }> = {
  draft: {
    label: 'Draft',
    pill: 'border-status-draft/25 bg-status-draft/10 text-status-draft',
  },
  released: {
    label: 'Released',
    pill: 'border-status-done/25 bg-status-done/10 text-status-done',
  },
  canceled: {
    label: 'Canceled',
    pill: 'border-status-rejected/25 bg-status-rejected/10 text-status-rejected',
  },
};

export const PIPELINE_TYPE_LABEL: Record<ReleasePipelineType, string> = {
  continuous: 'Continuous',
  scheduled: 'Scheduled',
};

const STATUS_ORDER: Record<ReleaseStatus, number> = { draft: 0, released: 1, canceled: 2 };

/** Local calendar day at noon so every time zone shows the same day. */
export function isoFromDate(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString();
}

export function sortReleases(list: readonly Release[]): Release[] {
  return list.slice().sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus) return byStatus;
    if (a.status === 'released') {
      return (b.releasedAt ?? b.updatedAt).localeCompare(a.releasedAt ?? a.updatedAt);
    }
    return (
      (a.targetAt ?? a.createdAt).localeCompare(b.targetAt ?? b.createdAt) ||
      a.name.localeCompare(b.name)
    );
  });
}

export function changelogReleases(list: readonly Release[]): Release[] {
  return list
    .filter((r) => r.status === 'released')
    .slice()
    .sort((a, b) => (b.releasedAt ?? b.updatedAt).localeCompare(a.releasedAt ?? a.updatedAt));
}
