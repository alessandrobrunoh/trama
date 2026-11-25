// Who can open one project, and who was invited to it (the Share project dialog). Not part of the
// workspace snapshot: loaded on demand for the project the dialog is open on.
import { Injectable, inject, signal } from '@angular/core';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type { ID, InviteLink, ProjectInviteResult, ProjectShare } from '../contracts/domain';
import { Notifier } from '../notify/notifier';
import { TramaStore } from './trama.store';

const EMPTY: ProjectShare = { members: [], invites: [] };

@Injectable({ providedIn: 'root' })
export class ProjectShareStore {
  private readonly api = inject(ApiClient);
  private readonly trama = inject(TramaStore);
  private readonly notifier = inject(Notifier);

  readonly share = signal<ProjectShare>(EMPTY);
  readonly loading = signal(false);
  /** The project `share` belongs to. */
  private projectId: ID | null = null;

  async load(projectId: ID): Promise<void> {
    const slug = this.trama.slug();
    if (!slug) return;
    if (this.projectId !== projectId) this.share.set(EMPTY);
    this.projectId = projectId;
    this.loading.set(true);
    try {
      const share = await this.api.projectShare.get(slug, projectId);
      if (this.projectId === projectId && this.trama.slug() === slug) this.share.set(share);
    } catch (e) {
      const err = ApiError.from(e);
      if (!err.isForbidden)
        this.notifier.error('Could not load who has access', { description: err.message });
    } finally {
      if (this.projectId === projectId) this.loading.set(false);
    }
  }

  /** An invitation, or (for someone who is already a guest) the project added to their list. */
  async invite(projectId: ID, email: string): Promise<ProjectInviteResult | undefined> {
    return this.run('share the project', projectId, (slug) =>
      this.api.projectShare.invite(slug, projectId, email),
    );
  }

  async resend(projectId: ID, inviteId: ID): Promise<InviteLink | undefined> {
    return this.run('resend the invitation', projectId, (slug) =>
      this.api.projectShare.resend(slug, projectId, inviteId),
    );
  }

  async revokeInvite(projectId: ID, inviteId: ID): Promise<boolean> {
    const done = await this.run('revoke the invitation', projectId, (slug) =>
      this.api.projectShare.revokeInvite(slug, projectId, inviteId).then(() => true),
    );
    return done === true;
  }

  /** Takes this project away from someone. Their membership ends when it was their last project. */
  async removeAccess(projectId: ID, membershipId: ID): Promise<boolean> {
    const done = await this.run('remove access', projectId, (slug) =>
      this.api.projectShare.removeAccess(slug, projectId, membershipId).then(() => true),
    );
    return done === true;
  }

  private async run<T>(
    label: string,
    projectId: ID,
    call: (slug: string) => Promise<T>,
  ): Promise<T | undefined> {
    const slug = this.trama.slug();
    if (!slug) return undefined;
    try {
      const result = await call(slug);
      await this.load(projectId);
      // The member list of the workspace changed too: pick it up without waiting for the next event.
      void this.trama.load(slug);
      return result;
    } catch (e) {
      const err = ApiError.from(e);
      if (!err.isForbidden) this.notifier.error(`Could not ${label}`, { description: err.message });
      return undefined;
    }
  }
}
