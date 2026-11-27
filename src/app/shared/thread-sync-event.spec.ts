import { threadSyncParts, threadSyncVerb } from './thread-sync-event';

describe('threadSyncVerb', () => {
  it('lists what the sync added', () => {
    expect(threadSyncVerb({ decisions: 2, files: 3 })).toBe('synced the record · 2 decisions · 3 files');
  });

  it('says a PR was attached and how much time was suggested', () => {
    expect(threadSyncParts({ decisionsAdded: 1, fileCount: 1, pullRequest: true, minutes: 47 })).toEqual([
      '1 decision',
      '1 file',
      'PR attached',
      '47m suggested',
    ]);
    expect(threadSyncParts({ minutes: 90 })).toEqual(['1h 30m suggested']);
  });

  it('leaves out what is empty and tolerates a missing payload', () => {
    expect(threadSyncVerb({ decisions: 0, files: 0, pullRequest: false })).toBe('synced the record');
    expect(threadSyncVerb(undefined)).toBe('synced the record');
  });
});
