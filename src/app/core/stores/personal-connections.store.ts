// The signed-in person's own connections (a personal GitHub, a client's GitLab). They belong to the
// account, not to a workspace, so they are not part of the workspace snapshot: Settings → Integrations
// (account) loads them on demand. Tokens are write-only; nothing here ever holds one after a call.
import { Injectable, inject, signal } from '@angular/core';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type {
  CreateIntegrationInput,
  IntegrationDetail,
  IntegrationWithWebhook,
  UpdateIntegrationInput,
} from '../api/api.types';
import type { ID } from '../contracts/domain';
import { Notifier } from '../notify/notifier';

@Injectable({ providedIn: 'root' })
export class PersonalConnectionsStore {
  private readonly api = inject(ApiClient);
  private readonly notifier = inject(Notifier);

  /** Oldest first, as the server lists them. */
  readonly connections = signal<readonly IntegrationDetail[]>([]);
  /** False until the first list answered, so the page can tell "loading" from "none yet". */
  readonly loaded = signal(false);

  async load(): Promise<void> {
    try {
      this.connections.set(await this.api.connections.list({ quiet: true }));
    } catch (e) {
      this.notifier.error('Could not load your connections', { description: ApiError.from(e).message });
    } finally {
      this.loaded.set(true);
    }
  }

  /** Resolves `{ connection, webhook? }`; the webhook secret is returned here once. */
  create(input: CreateIntegrationInput): Promise<IntegrationWithWebhook | undefined> {
    return this.run('connect the account', () => this.api.connections.create(input), (r) => this.upsert(r.connection));
  }

  /** Rename, or give a new token or base URL (re-validated; reconnects a revoked connection). */
  update(id: ID, input: UpdateIntegrationInput): Promise<IntegrationDetail | undefined> {
    return this.run('update the connection', () => this.api.connections.update(id, input), (c) => this.upsert(c));
  }

  /** Withdraw the credential: status `revoked`, token wiped. Rules that read through it show an error. */
  revoke(id: ID): Promise<IntegrationDetail | undefined> {
    return this.run('revoke the connection', () => this.api.connections.revoke(id), (c) => this.upsert(c));
  }

  async remove(id: ID): Promise<boolean> {
    const before = this.connections();
    this.connections.set(before.filter((c) => c.id !== id));
    try {
      await this.api.connections.remove(id);
      return true;
    } catch (e) {
      this.connections.set(before);
      this.notifier.error('Could not remove the connection', { description: ApiError.from(e).message });
      return false;
    }
  }

  rotateWebhookSecret(id: ID): Promise<IntegrationWithWebhook | undefined> {
    return this.run('rotate the webhook secret', () => this.api.connections.rotateWebhookSecret(id), (r) => this.upsert(r.connection));
  }

  private upsert(c: IntegrationDetail): void {
    const list = this.connections();
    this.connections.set(list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c]);
  }

  private async run<T>(what: string, call: () => Promise<T>, onResult: (r: T) => void): Promise<T | undefined> {
    try {
      const result = await call();
      onResult(result);
      return result;
    } catch (e) {
      this.notifier.error(`Could not ${what}`, { description: ApiError.from(e).message });
      return undefined;
    }
  }
}
