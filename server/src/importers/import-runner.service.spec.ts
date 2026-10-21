import { describe, expect, it, vi } from 'vitest';
import { ImportRunnerService } from './import-runner.service.js';

describe('ImportRunnerService worker cap', () => {
  it('limits claims across workspaces to four jobs at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let claimed = 0;
    const ds = {
      query: vi.fn(async () => {
        claimed += 1;
        return [[{ id: String(claimed) }], 1];
      }),
    };
    const runner = new ImportRunnerService(
      ds as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    const execute = vi.fn(async () => gate);
    (runner as unknown as { execute: typeof execute }).execute = execute;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runner.kick(`job-${i}`)));
    expect(results.filter(Boolean)).toHaveLength(4);
    expect(ds.query).toHaveBeenCalledTimes(4);
    release();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(4));
  });
});
