import { WorkstreamBus } from './workstream-bus.js';

describe('WorkstreamBus', () => {
  it('awaits handlers in order, isolates failures and supports unsubscribe', async () => {
    const bus = new WorkstreamBus();
    const seen: string[] = [];
    bus.onTouched(() => {
      throw new Error('boom');
    });
    const off = bus.onTouched(async (e) => {
      await Promise.resolve();
      seen.push(`${e.workspaceId}/${e.workstreamId}/${e.reason}`);
    });
    await bus.touch('ws', 'wk1', 'execution.created');
    await bus.touchMany('ws', ['wk1', 'wk1', 'wk2'], 'dependency.added');
    off();
    await bus.touch('ws', 'wk3', 'ignored');
    expect(seen).toEqual(['ws/wk1/execution.created', 'ws/wk1/dependency.added', 'ws/wk2/dependency.added']);
  });
});
