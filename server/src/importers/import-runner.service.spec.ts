import { describe, expect, it, vi } from 'vitest';
import { ImportRunnerService, claimedRows } from './import-runner.service.js';

function runner(queryResult: unknown) {
  const query = vi.fn(async () => queryResult);
  const findOneBy = vi.fn(async () => null);
  const service = new ImportRunnerService({ query } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { findOneBy } as never);
  return { service, query, findOneBy };
}

describe('claimedRows', () => {
  it('reads both shapes TypeORM gives an UPDATE ... RETURNING', () => {
    expect(claimedRows([[{ id: 'imp_1' }], 1])).toEqual([{ id: 'imp_1' }]);
    expect(claimedRows([[], 0])).toEqual([]);
    expect(claimedRows([{ id: 'imp_1' }])).toEqual([{ id: 'imp_1' }]);
    expect(claimedRows(undefined)).toEqual([]);
  });
});

describe('ImportRunnerService.kick', () => {
  it('does not run a job it could not claim (another instance holds it, or it is not due)', async () => {
    const { service, findOneBy } = runner([[], 0]);
    expect(await service.kick('imp_1')).toBe(false);
    expect(findOneBy).not.toHaveBeenCalled();
  });

  it('runs a job it claimed, and only once at a time', async () => {
    const { service, findOneBy, query } = runner([[{ id: 'imp_1' }], 1]);
    expect(await service.kick('imp_1')).toBe(true);
    // the claim is one atomic statement bound to the job id
    expect(query).toHaveBeenCalledTimes(1);
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1][0]).toBe('imp_1');
    await vi.waitFor(() => expect(findOneBy).toHaveBeenCalledWith({ id: 'imp_1' }));
  });
});
