import { describe, expect, it, vi } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  EXTERNAL_IDENTITIES_MAX,
  normalizeIdentityHost,
  normalizeIdentityLogin,
} from '../contracts/domain.js';
import {
  ExternalIdentitiesService,
  identityKey,
} from './external-identities.service.js';
import type { ExternalIdentityEntity } from './external-identity.entity.js';

type Row = Pick<
  ExternalIdentityEntity,
  'id' | 'userId' | 'provider' | 'host' | 'login' | 'source'
>;

/** Just enough of a Repository and DataSource, backed by an array. */
function fixture(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const repo = {
    find: vi.fn(async ({ where }: { where: { userId: string } }) =>
      rows.filter((r) => r.userId === where.userId),
    ),
    findOneBy: vi.fn(async (w: Partial<Row>) =>
      rows.find((r) => r.id === w.id && r.userId === w.userId) ?? null,
    ),
    countBy: vi.fn(async (w: { userId: string }) =>
      rows.filter((r) => r.userId === w.userId).length,
    ),
    create: (r: Row) => ({ createdAt: new Date(), ...r }),
    save: vi.fn(async (r: Row) => {
      const at = rows.findIndex((x) => x.id === r.id);
      if (at >= 0) rows[at] = r;
      else rows.push(r);
      return r;
    }),
    delete: vi.fn(async (w: { id: string }) => {
      const at = rows.findIndex((x) => x.id === w.id);
      if (at >= 0) rows.splice(at, 1);
    }),
    createQueryBuilder: () => {
      let params: { p: string; h: string; l: string };
      const qb = {
        where: (_sql: string, p: typeof params) => {
          params = p;
          return qb;
        },
        getOne: async () =>
          rows.find(
            (r) =>
              r.provider === params.p &&
              r.host === params.h &&
              r.login.toLowerCase() === params.l,
          ) ?? null,
      };
      return qb;
    },
  };
  const query = vi.fn(async () => [] as unknown[]);
  const service = new ExternalIdentitiesService(
    repo as unknown as Repository<ExternalIdentityEntity>,
    { query } as unknown as DataSource,
  );
  return { service, rows, repo, query };
}

const row = (over: Partial<Row> & Pick<Row, 'id' | 'userId' | 'login'>): Row => ({
  provider: 'github',
  host: 'github.com',
  source: 'manual',
  ...over,
});

describe('identity normalization', () => {
  it('reduces a host to its bare, lower-case form', () => {
    expect(normalizeIdentityHost('https://GitHub.com/')).toBe('github.com');
    expect(normalizeIdentityHost(' git.acme.dev:8443/x?y ')).toBe('git.acme.dev:8443');
    expect(normalizeIdentityHost('not a host')).toBeNull();
    expect(normalizeIdentityHost('')).toBeNull();
  });

  it('drops a leading @ and refuses logins with spaces or slashes', () => {
    expect(normalizeIdentityLogin(' @Alessandro-B ')).toBe('Alessandro-B');
    expect(normalizeIdentityLogin('a b')).toBeNull();
    expect(normalizeIdentityLogin('a/b')).toBeNull();
    expect(normalizeIdentityLogin('@')).toBeNull();
  });

  it('defaults the host from the provider, and Jira has none', () => {
    expect(identityKey('gitlab', undefined, 'ada')).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      login: 'ada',
    });
    expect(identityKey('github', 'https://ghe.acme.dev/', '@ada')).toEqual({
      provider: 'github',
      host: 'ghe.acme.dev',
      login: 'ada',
    });
    expect(identityKey('jira', undefined, 'ada')).toBeNull();
    expect(identityKey('svn', 'x.dev', 'ada')).toBeNull();
  });
});

describe('ExternalIdentitiesService.add', () => {
  it('stores a manual identity with the normalized host', async () => {
    const { service, rows } = fixture();
    const made = await service.add('u1', { provider: 'github', login: '@Ada' });
    expect(made).toMatchObject({
      userId: 'u1',
      provider: 'github',
      host: 'github.com',
      login: 'Ada',
      source: 'manual',
    });
    expect(rows).toHaveLength(1);
  });

  it('refuses a login another account has, whatever the case', async () => {
    const { service } = fixture([row({ id: 'x1', userId: 'u2', login: 'Ada' })]);
    await expect(
      service.add('u1', { provider: 'github', login: 'ADA' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.add('u1', { provider: 'github', host: 'https://GITHUB.com', login: 'ada' }),
    ).rejects.toThrow(/another account/);
  });

  it('refuses a duplicate of its own, but allows the same login on another host', async () => {
    const { service } = fixture([row({ id: 'x1', userId: 'u1', login: 'ada' })]);
    await expect(
      service.add('u1', { provider: 'github', login: 'ada' }),
    ).rejects.toThrow(/already have/);
    await expect(
      service.add('u1', { provider: 'github', host: 'ghe.acme.dev', login: 'ada' }),
    ).resolves.toMatchObject({ host: 'ghe.acme.dev' });
  });

  it('validates the input and caps the list', async () => {
    const { service } = fixture();
    await expect(service.add('u1', { provider: 'jira', login: 'ada' })).rejects.toThrow(/host is required/);
    await expect(service.add('u1', { provider: 'github', login: 'a b' })).rejects.toThrow(/valid login/);
    await expect(service.add('u1', { provider: 'github', host: 'no host', login: 'ada' })).rejects.toThrow(/valid host/);
    const full = fixture(
      Array.from({ length: EXTERNAL_IDENTITIES_MAX }, (_, i) =>
        row({ id: `x${i}`, userId: 'u1', login: `l${i}` }),
      ),
    );
    await expect(full.service.add('u1', { provider: 'github', login: 'more' })).rejects.toThrow(/At most/);
  });
});

describe('ExternalIdentitiesService.remove', () => {
  it('removes your own identity and treats someone else’s as missing', async () => {
    const { service, rows } = fixture([
      row({ id: 'x1', userId: 'u1', login: 'ada' }),
      row({ id: 'x2', userId: 'u2', login: 'bob' }),
    ]);
    await expect(service.remove('u1', 'x2')).rejects.toBeInstanceOf(NotFoundException);
    await service.remove('u1', 'x1');
    expect(rows.map((r) => r.id)).toEqual(['x2']);
  });
});

describe('ExternalIdentitiesService.ensureFromConnection', () => {
  it('adds the connection login once, as a connection identity', async () => {
    const { service, rows } = fixture();
    const a = await service.ensureFromConnection('u1', 'github', 'https://github.com', 'Ada');
    const b = await service.ensureFromConnection('u1', 'github', null, 'ada');
    expect(a).toMatchObject({ source: 'connection', login: 'Ada', host: 'github.com' });
    expect(b?.id).toBe(a?.id);
    expect(rows).toHaveLength(1);
  });

  it('promotes a hand-typed identity of the same person', async () => {
    const { service, rows } = fixture([row({ id: 'x1', userId: 'u1', login: 'ada' })]);
    const out = await service.ensureFromConnection('u1', 'github', null, 'ada');
    expect(out?.source).toBe('connection');
    expect(rows[0].source).toBe('connection');
  });

  it('does not throw nor steal a login that belongs to someone else', async () => {
    const { service, rows } = fixture([row({ id: 'x1', userId: 'u2', login: 'ada' })]);
    await expect(service.ensureFromConnection('u1', 'github', null, 'ada')).resolves.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('u2');
  });

  it('ignores logins it cannot use', async () => {
    const { service, rows } = fixture();
    await expect(service.ensureFromConnection('u1', 'github', null, '')).resolves.toBeNull();
    await expect(service.ensureFromConnection('u1', 'jira', null, 'ada')).resolves.toBeNull();
    expect(rows).toHaveLength(0);
  });
});

describe('ExternalIdentitiesService.resolveUserByLogin', () => {
  const seed = [
    row({ id: 'x1', userId: 'u1', login: 'ada-work', source: 'connection' }),
    row({ id: 'x2', userId: 'u1', login: 'ada-home' }),
    row({ id: 'x3', userId: 'u2', login: 'bob', provider: 'gitlab', host: 'gitlab.com' }),
  ];

  it('resolves every login of one person to that person', async () => {
    const { service } = fixture(seed);
    expect(await service.resolveUserByLogin('github', null, 'ADA-WORK')).toBe('u1');
    expect(await service.resolveUserByLogin('github', 'github.com', '@ada-home')).toBe('u1');
    expect(await service.resolveUserByLogin('gitlab', undefined, 'bob')).toBe('u2');
  });

  it('knows nobody for another provider, another host or a stranger', async () => {
    const { service } = fixture(seed);
    expect(await service.resolveUserByLogin('gitlab', null, 'ada-work')).toBeNull();
    expect(await service.resolveUserByLogin('github', 'ghe.acme.dev', 'ada-work')).toBeNull();
    expect(await service.resolveUserByLogin('github', null, 'mallory')).toBeNull();
    expect(await service.resolveUserByLogin('github', null, undefined)).toBeNull();
  });

  it('can be limited to identities proven by a connection', async () => {
    const { service } = fixture(seed);
    const opts = { verifiedOnly: true };
    expect(await service.resolveUserByLogin('github', null, 'ada-work', opts)).toBe('u1');
    expect(await service.resolveUserByLogin('github', null, 'ada-home', opts)).toBeNull();
  });
});

describe('ExternalIdentitiesService member lookups', () => {
  it('asks for lower-cased, de-duplicated logins of one host, scoped to the workspace', async () => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce([
      { login: 'Ada-Work', userId: 'u1' },
      { login: 'ada-home', userId: 'u1' },
    ]);
    const found = await service.resolveMembersByLogins('ws_1', 'github', null, [
      'Ada-Work',
      'ADA-WORK',
      'ada-home',
      'bad login',
    ]);
    expect(found.get('ada-work')).toBe('u1');
    expect(found.get('ada-home')).toBe('u1');
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('"memberships"');
    expect(params).toEqual(['ws_1', 'github', 'github.com', ['ada-work', 'ada-home']]);
  });

  it('does not query for nothing', async () => {
    const { service, query } = fixture();
    expect((await service.resolveMembersByLogins('ws_1', 'github', null, [])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves one login to a member, or to nobody', async () => {
    const { service, query } = fixture();
    query.mockResolvedValueOnce([{ login: 'ada', userId: 'u1' }]);
    expect(await service.resolveMemberByLogin('ws_1', 'github', null, 'Ada')).toBe('u1');
    query.mockResolvedValueOnce([]);
    expect(await service.resolveMemberByLogin('ws_1', 'github', null, 'bob')).toBeNull();
  });
});
