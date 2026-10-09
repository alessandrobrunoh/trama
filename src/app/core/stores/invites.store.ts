// Pending invitations of the open workspace (Settings → Members). Not part of the workspace
// snapshot: only people allowed to invite load them, on demand.
import { Injectable, inject, signal } from '@angular/core';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type { CreateInviteInput } from '../api/api.types';
import type { ID, InviteLink, WorkspaceInvite } from '../contracts/domain';
import { Notifier } from '../notify/notifier';
import { TramaStore } from './trama.store';

@Injectable({ providedIn: 'root' })
export class InvitesStore {
  private readonly api = inject(ApiClient);
  private readonly trama = inject(TramaStore);
  private readonly notifier = inject(Notifier);

  /** Newest first. Expired invitations stay listed so they can be resent. */
  readonly invites = signal<readonly WorkspaceInvite[]>([]);

  async load(): Promise<void> {
    const slug = this.trama.slug();
    if (!slug) return;
    try {
      const list = await this.api.invites.list(slug);
      if (this.trama.slug() === slug) this.invites.set(list);
    } catch {
      /* the list is a convenience; the invite form still works */
    }
  }

  /** The link is shown once: callers display it when the email could not be sent. */
  async create(input: CreateInviteInput): Promise<InviteLink | undefined> {
    return this.run('send the invitation', (slug) => this.api.invites.create(slug, input));
  }

  async resend(id: ID): Promise<InviteLink | undefined> {
    return this.run('resend the invitation', (slug) => this.api.invites.resend(slug, id));
  }

  async revoke(id: ID): Promise<boolean> {
    const before = this.invites();
    this.invites.set(before.filter((i) => i.id !== id));
    const slug = this.trama.slug();
    if (!slug) return false;
    try {
      await this.api.invites.revoke(slug, id);
      return true;
    } catch (e) {
      this.invites.set(before);
      this.notifier.error('Could not revoke the invitation', {
        description: ApiError.from(e).message,
      });
      return false;
    }
  }

  private async run(
    label: string,
    call: (slug: string) => Promise<InviteLink>,
  ): Promise<InviteLink | undefined> {
    const slug = this.trama.slug();
    if (!slug) return undefined;
    try {
      const link = await call(slug);
      await this.load();
      return link;
    } catch (e) {
      const err = ApiError.from(e);
      // 403 already shows the generic "no permission" toast
      if (!err.isForbidden) this.notifier.error(`Could not ${label}`, { description: err.message });
      return undefined;
    }
  }
}
