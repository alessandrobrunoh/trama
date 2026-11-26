// Share a project (v3 "Dialog · 08 Share project"): invite people to this project only (they join as guests and see
// nothing else), see who has access, take it away, promote a guest. Mount it on the project page and bind `open`.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { LucideDynamicIcon, LucideEye, LucideLink, LucideMail, LucideUsers, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import {
  GUEST_ROLE_ID,
  workspaceRoleName,
  type InviteLink,
  type Project,
  type ProjectShareMember,
  type WorkspaceInvite,
} from '../../core/contracts/domain';
import { Clipboard, Notifier } from '../../core/notify/notifier';
import { ProjectShareStore } from '../../core/stores/project-share.store';
import { TramaStore } from '../../core/stores/trama.store';
import { UiStore } from '../../core/stores/ui.store';
import { ActorAvatar } from '../../shared/actor-avatar';
import { V3DialogFoot } from '../../shared/v3';
import { EmailChips, isEmail } from '../settings/sections/email-chips';
import { SECTION_KIT } from '../settings/sections/section-kit';

const DAY_MS = 24 * 60 * 60 * 1000;

@Component({
  selector: 'app-project-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmDialogImports,
    HlmButtonImports,
    LucideDynamicIcon,
    ActorAvatar,
    EmailChips,
    V3DialogFoot,
    ...SECTION_KIT,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[92svh] gap-0 overflow-y-auto p-0 sm:w-[500px] sm:max-w-[500px]"
        [showCloseButton]="false"
        (keydown.meta.enter)="invite($event)"
        (keydown.control.enter)="invite($event)"
      >
        <!-- v3 · 08: title over a mono "acme · project" line, a bare close icon, no rule under the head -->
        <div class="flex items-start px-5 pt-[18px] pb-3.5">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 hlmDialogTitle class="font-title text-foreground m-0 truncate text-[20px] leading-[20px] font-normal">
              Share {{ project().name }}
            </h2>
            <p hlmDialogDescription class="text-faint m-0 font-mono text-[10.5px] leading-[14px]">
              {{ workspaceName() }} · project
            </p>
          </div>
          <span class="min-w-0 flex-1"></span>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground mt-1 inline-flex shrink-0 outline-none focus-visible:text-foreground"
            aria-label="Close"
            (click)="open.set(false)"
          >
            <svg [lucideIcon]="xIcon" [size]="16"></svg>
          </button>
        </div>

        <div class="flex flex-col gap-2 px-5 pb-4">
          <div class="flex items-start gap-2">
            <app-email-chips
              class="min-w-0 flex-1"
              placeholder="Add email…"
              [emails]="emails()"
              (emailsChange)="emails.set($event)"
              [disabled]="busy()"
            />
            <span class="text-muted-foreground border-border inline-flex h-[34px] shrink-0 items-center border px-2.5 font-mono text-[11px]">
              Guest · can edit
            </span>
            <button hlmBtn size="sm" type="button" class="h-[34px]" [disabled]="!canInvite()" (click)="invite($event)">
              Invite
            </button>
          </div>
          @if (invalid().length) {
            <p class="text-red text-xs" role="alert">
              {{ invalid().join(', ') }} {{ invalid().length === 1 ? 'is not an email address' : 'are not email addresses' }}.
            </p>
          }
          @for (link of manual(); track link.invite.id) {
            <div class="border-border bg-secondary border px-3 py-2.5" role="status">
              <p class="text-[12px] leading-snug">
                Email is not set up on this server. Share this link with
                <span class="text-foreground font-mono">{{ link.invite.email }}</span>:
              </p>
              <app-copy-field class="mt-1.5" [value]="link.url" label="Invite link" />
            </div>
          }
        </div>

        <div class="border-border border-t pt-1.5 pb-2.5">
          <div class="text-faint px-5 pt-2 pb-1 font-mono text-[10.5px] uppercase">
            Who has access
          </div>

          @if (everyone().length) {
            <div class="flex items-center gap-2.5 px-5 py-[9px]">
              <span class="bg-secondary border-border text-muted-foreground inline-flex size-[26px] shrink-0 items-center justify-center border" aria-hidden="true">
                <svg [lucideIcon]="everyoneIcon" [size]="14"></svg>
              </span>
              <div class="min-w-0 flex-1">
                <div class="text-foreground text-[13px]">Everyone in {{ workspaceName() }} with all projects</div>
                <div class="text-faint font-mono text-[10.5px]">
                  {{ everyone().length }} {{ everyone().length === 1 ? 'member' : 'members' }} · from the workspace
                </div>
              </div>
              <span class="text-muted-foreground font-mono text-[10.5px]">Workspace</span>
            </div>
          }

          @for (m of people(); track m.id) {
            <div class="flex items-center gap-2.5 px-5 py-[9px]">
              <app-actor-avatar [actor]="{ type: 'user', id: m.userId }" [size]="26" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 text-[13px]">
                  <span class="text-foreground truncate">{{ m.user?.name ?? m.userId }}</span>
                  @if (m.role === guestId) {
                    <span class="bg-secondary border-border text-text-2 border px-[7px] py-0.5 text-[11px] leading-[14px]">guest</span>
                  }
                </div>
                <div class="text-faint truncate font-mono text-[10.5px]">
                  {{ m.user?.email }}{{ also(m) }}{{ m.userId === meId() ? ' · you' : '' }}
                </div>
              </div>
              @if (m.role === guestId) {
                <span class="text-muted-foreground font-mono text-[10.5px]">Can edit</span>
              } @else {
                <span class="text-muted-foreground font-mono text-[10.5px]">{{ roleName(m.role) }}</span>
              }
              @if (canPromote(m)) {
                <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 text-xs" title="Make this person a full member of the workspace" (click)="promote(m)">
                  Promote
                </button>
              }
              @if (m.userId !== meId()) {
                <button
                  hlmBtn
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground"
                  [attr.aria-label]="'Remove ' + (m.user?.name ?? 'this person') + ' from the project'"
                  (click)="confirmRemove(m)"
                >
                  <svg [lucideIcon]="xIcon" [size]="14"></svg>
                </button>
              }
            </div>
          }

          @for (i of invites(); track i.id) {
            <div class="flex items-center gap-2.5 px-5 py-[9px]">
              <span class="bg-secondary border-border text-muted-foreground inline-flex size-[26px] shrink-0 items-center justify-center border" aria-hidden="true">
                <svg [lucideIcon]="pendingIcon" [size]="14"></svg>
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 text-[13px]">
                  <span class="text-foreground truncate">{{ i.email }}</span>
                  <span class="bg-secondary border-border text-text-2 border px-[7px] py-0.5 text-[11px] leading-[14px]">pending</span>
                </div>
                <div class="text-faint font-mono text-[10.5px]" [class.text-red]="expired(i)">{{ expiry(i) }}</div>
              </div>
              <button hlmBtn variant="outline" size="sm" [disabled]="busy()" (click)="resend(i)">Resend</button>
              <button
                hlmBtn
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground"
                [attr.aria-label]="'Revoke invitation for ' + i.email"
                (click)="revoke(i)"
              >
                <svg [lucideIcon]="xIcon" [size]="14"></svg>
              </button>
            </div>
          }

          @if (loading() && !people().length && !everyone().length) {
            <div class="text-muted-foreground px-5 py-4 text-[13px]">Loading…</div>
          }
        </div>

        <div class="bg-[var(--bg-deep,var(--background))] border-border flex items-start gap-2.5 border-t px-5 py-2.5">
          <svg [lucideIcon]="hintIcon" [size]="14" class="text-muted-foreground mt-0.5 shrink-0" aria-hidden="true"></svg>
          <p class="text-text-2 m-0 min-w-0 flex-1 text-[12px] leading-[18px]">
            Guests see this project, the people on it, and the workspace's statuses and labels read-only. Nothing else in {{ workspaceName() }}. Promote someone to make them a member.
          </p>
        </div>

        <v3-dialog-foot class="px-5">
          <button v3-hint hlmBtn variant="ghost" size="sm" type="button" class="text-text-2 -ms-2.5 gap-1.5" (click)="copyLink()">
            <svg [lucideIcon]="linkIcon" [size]="13" aria-hidden="true"></svg>
            Copy project link
          </button>
          <button hlmBtn variant="outline" size="sm" type="button" (click)="open.set(false)">Done</button>
        </v3-dialog-foot>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ProjectShareDialog {
  readonly project = input.required<Project>();
  readonly open = model(false);

  private readonly store = inject(TramaStore);
  private readonly shares = inject(ProjectShareStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly clipboard = inject(Clipboard);
  private readonly notifier = inject(Notifier);
  private readonly chips = viewChild(EmailChips);

  protected readonly guestId = GUEST_ROLE_ID;
  protected readonly xIcon = LucideX;
  protected readonly everyoneIcon = LucideUsers;
  protected readonly pendingIcon = LucideMail;
  protected readonly hintIcon = LucideEye;
  protected readonly linkIcon = LucideLink;
  protected readonly emails = signal<string[]>([]);
  protected readonly busy = signal(false);
  /** Links for invitations the server could not email (shown once). */
  protected readonly manual = signal<InviteLink[]>([]);

  protected readonly loading = this.shares.loading;
  protected readonly meId = computed(() => this.store.me()?.id);
  protected readonly workspaceName = computed(() => this.store.workspace()?.name ?? 'the workspace');
  protected readonly invalid = computed(() => this.emails().filter((email) => !isEmail(email)));
  protected readonly canInvite = computed(
    () => !this.busy() && this.emails().length > 0 && this.invalid().length === 0,
  );
  protected readonly everyone = computed(() => this.shares.share().members.filter((m) => m.allProjects));
  protected readonly people = computed(() =>
    this.shares
      .share()
      .members.filter((m) => !m.allProjects)
      .sort((a, b) => (a.user?.name ?? '').localeCompare(b.user?.name ?? '')),
  );
  protected readonly invites = computed(() => this.shares.share().invites);
  private readonly projectName = computed(
    () => new Map(this.store.projects().map((project) => [project.id, project.name])),
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const id = this.project().id;
      untracked(() => {
        this.emails.set([]);
        this.manual.set([]);
        void this.shares.load(id);
      });
    });
  }

  protected roleName(role: string): string {
    return workspaceRoleName(this.store.settings().roles, role);
  }

  /** " · also on API, Mobile": the other projects this person has that I can see too. */
  protected also(m: ProjectShareMember): string {
    const others = (m.access?.projects.projectIds ?? [])
      .filter((id) => id !== this.project().id)
      .map((id) => this.projectName().get(id))
      .filter((name): name is string => !!name);
    return others.length ? ` · also on ${others.join(', ')}` : '';
  }

  /** Changing someone's role is an admin action; a guest is promoted by giving them the Member role. */
  protected canPromote(m: ProjectShareMember): boolean {
    return m.role === GUEST_ROLE_ID && this.store.can('admin');
  }

  protected expired(i: WorkspaceInvite): boolean {
    return new Date(i.expiresAt).getTime() < Date.now();
  }
  protected expiry(i: WorkspaceInvite): string {
    const days = Math.ceil((new Date(i.expiresAt).getTime() - Date.now()) / DAY_MS);
    if (days < 0) return 'invitation expired, resend to renew';
    if (days === 0) return 'invited · expires today';
    return days === 1 ? 'invited · expires tomorrow' : `invited · expires in ${days} days`;
  }

  protected async invite(event: Event): Promise<void> {
    event.preventDefault();
    this.chips()?.commit();
    if (!this.canInvite()) return;
    this.busy.set(true);
    const failed: string[] = [];
    const manual: InviteLink[] = [];
    let invited = 0;
    let added = 0;
    for (const email of this.emails()) {
      const result = await this.shares.invite(this.project().id, email);
      if (!result) failed.push(email);
      else if (result.status === 'added') added += 1;
      else {
        invited += 1;
        if (!result.link.emailed) manual.push(result.link);
      }
    }
    this.busy.set(false);
    this.emails.set(failed);
    this.manual.set(manual);
    if (invited + added)
      this.notifier.success(
        added && !invited
          ? `${added === 1 ? 'They now have' : added + ' people now have'} access to ${this.project().name}`
          : `${invited + added === 1 ? 'Invitation sent' : invited + added + ' invitations sent'}`,
      );
  }

  protected async resend(i: WorkspaceInvite): Promise<void> {
    this.busy.set(true);
    const link = await this.shares.resend(this.project().id, i.id);
    this.busy.set(false);
    if (link && !link.emailed) this.manual.set([link]);
    else if (link) this.notifier.success('Invitation sent again');
  }

  protected revoke(i: WorkspaceInvite): void {
    void this.shares.revokeInvite(this.project().id, i.id);
  }

  protected confirmRemove(m: ProjectShareMember): void {
    const name = m.user?.name ?? 'this person';
    const onlyProject =
      m.role === GUEST_ROLE_ID && (m.access?.projects.projectIds.filter((id) => id !== this.project().id).length ?? 0) === 0;
    this.ui.setConfirmDelete({
      title: `Remove ${name} from ${this.project().name}?`,
      description: onlyProject
        ? `${name} has no other project here, so they leave the workspace. Their tasks, comments and time entries stay.`
        : 'They stop seeing this project. Their tasks and comments stay.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.shares.removeAccess(this.project().id, m.id);
      },
    });
  }

  protected async promote(m: ProjectShareMember): Promise<void> {
    const ok = await this.store.updateMemberRole(m.id, 'member');
    if (ok) await this.shares.load(this.project().id);
  }

  protected copyLink(): void {
    const tree = this.router.createUrlTree(['/', this.store.slug() ?? '', 'projects', this.project().id]);
    void this.clipboard.copy(location.origin + this.router.serializeUrl(tree), 'Project link copied');
  }
}
