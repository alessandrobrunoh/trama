import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ApiClient } from '../../../core/api/api-client';
import { ApiError } from '../../../core/api/api-error';
import type { ExternalIdentity } from '../../../core/contracts/domain';
import { ExternalIdentitiesSection } from './external-identities-section';

const identity = (over: Partial<ExternalIdentity>): ExternalIdentity => ({
  id: 'x1',
  userId: 'u1',
  provider: 'github',
  host: 'github.com',
  login: 'alebruno',
  source: 'connection',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

async function setup(initial: ExternalIdentity[]) {
  const api = {
    externalIdentities: {
      list: vi.fn(async () => initial),
      add: vi.fn(),
      remove: vi.fn(async () => undefined),
    },
  };
  TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: api }] });
  const fixture = TestBed.createComponent(ExternalIdentitiesSection);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (text: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  const type = (selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { api, fixture, el, button, type };
}

describe('External identities section', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterAll(() => vi.unstubAllGlobals());

  it('lists each login with where it came from', async () => {
    const { el } = await setup([
      identity({}),
      identity({ id: 'x2', provider: 'gitlab', host: 'gitlab.acme.dev', login: 'a.bruno', source: 'manual' }),
    ]);
    const rows = Array.from(el.querySelectorAll('li')).map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('GitHub');
    expect(rows[0]).toContain('github.com');
    expect(rows[0]).toContain('alebruno');
    expect(rows[0]).toContain('from a connection');
    expect(rows[1]).toContain('gitlab.acme.dev');
    expect(rows[1]).toContain('by hand');
  });

  it('adds a login by hand and shows it', async () => {
    const { api, fixture, el, button, type } = await setup([]);
    expect(el.textContent).toContain('No logins yet');
    api.externalIdentities.add.mockResolvedValue(identity({ id: 'x9', login: 'new-login', source: 'manual' }));

    button('Add identity')!.click();
    await fixture.whenStable();
    type('#xid-login', '@new-login');
    await fixture.whenStable();
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();

    expect(api.externalIdentities.add).toHaveBeenCalledWith({ provider: 'github', host: undefined, login: 'new-login' });
    expect(el.querySelectorAll('li')).toHaveLength(1);
    expect(el.textContent).toContain('new-login');
    expect(el.querySelector('form')).toBeNull(); // the form closes
  });

  it('shows the server answer when the login belongs to someone else', async () => {
    const { api, fixture, el, button, type } = await setup([]);
    api.externalIdentities.add.mockRejectedValue(new ApiError(409, 'This login is already linked to another account'));

    button('Add identity')!.click();
    await fixture.whenStable();
    type('#xid-login', 'taken');
    await fixture.whenStable();
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();

    expect(el.querySelector('[role="alert"]')?.textContent).toContain('already linked to another account');
    expect(el.querySelectorAll('li')).toHaveLength(0);
    expect(el.querySelector('form')).not.toBeNull(); // kept open so it can be fixed
  });

  it('does not ask the server for input it can see is wrong', async () => {
    const { api, fixture, el, button, type } = await setup([]);
    button('Add identity')!.click();
    await fixture.whenStable();
    type('#xid-login', 'has space');
    await fixture.whenStable();
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();

    expect(api.externalIdentities.add).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('without spaces');
  });

  it('removes a login', async () => {
    const { api, fixture, el } = await setup([identity({})]);
    el.querySelector<HTMLButtonElement>('button[aria-label="Remove GitHub login alebruno"]')!.click();
    await fixture.whenStable();

    expect(api.externalIdentities.remove).toHaveBeenCalledWith('x1');
    expect(el.querySelectorAll('li')).toHaveLength(0);
  });
});
