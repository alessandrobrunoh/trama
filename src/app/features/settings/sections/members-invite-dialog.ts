// Invite people to the workspace (Settings · 03 Members · Invite): email chips, a role, and which projects.
// Mount `<app-members-invite-dialog [open]="…" (closed)="…" />` on the Members page.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import {
  canGrantRole,
  emptyMemberAccess,
  findWorkspaceRole,
  GUEST_ROLE_ID,
  MEMBER_GRANTS,
  normalizeMemberAccess,
  type InviteLink,
  type MemberAccess,
  type MemberGrant,
  type Role,
} from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { InvitesStore } from '../../../core/stores/invites.store';
import { TramaStore } from '../../../core/stores/trama.store';
import { AppSelect, type Option } from '../../create/form-kit';
import { V3DialogFoot, V3DialogHead, V3Field } from '../../../shared/v3';
import { EmailChips, isEmail } from './email-chips';
import { MemberAccessEditor } from './member-access-editor';
import { SECTION_KIT } from './section-kit';

@Component({
  selector: 'app-members-invite-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmDialogImports,
    HlmButtonImports,
    HlmCheckbox,
    AppSelect,
    EmailChips,
    MemberAccessEditor,
    V3DialogHead,
    V3DialogFoot,
    V3Field,
    ...SECTION_KIT,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="close()">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[92svh] gap-0 overflow-y-auto p-0 sm:max-w-[560px]"
        [showCloseButton]="false"
        (keydown.meta.enter)="send($event)"
        (keydown.control.enter)="send($event)"
      >
        <v3-dialog-head (dismiss)="close()">
          <h2 hlmDialogTitle>Invite people to {{ workspaceName() }}</h2>
        </v3-dialog-head>
        <p hlmDialogDescription class="text-muted-foreground px-[18px] pt-3 text-[12px]">
          They join the workspace, not a single project.
        </p>

        @if (sent().length) {
          <div class="flex flex-col gap-3 p-[18px]" role="status">
            <p class="text-[13px] leading-snug">
              {{ sent().length === 1 ? 'Invitation sent.' : sent().length + ' invitations sent.' }}
              @if (unmailed().length) {
                Email is not set up on this server: share
                {{ unmailed().length === 1 ? 'this link' : 'these links' }} yourself.
              }
            </p>
            @for (link of unmailed(); track link.invite.id) {
              <div class="flex flex-col gap-1">
                <span class="text-foreground font-mono text-[12px]">{{ link.invite.email }}</span>
                <app-copy-field [value]="link.url" label="Invite link" />
              </div>
            }
            <p class="text-faint font-mono text-[10.5px]">
              A link works for 7 days and only for that email address.
            </p>
          </div>
          <v3-dialog-foot>
            <button hlmBtn size="sm" type="button" (click)="close()">Done</button>
          </v3-dialog-foot>
        } @else {
          <div class="flex flex-col gap-4 p-[18px]">
            <v3-field label="EMAILS">
              <app-email-chips
                [emails]="emails()"
                (emailsChange)="emails.set($event)"
                [disabled]="busy()"
                placeholder="name@company.com"
              />
              @if (invalid().length) {
                <p class="text-red text-xs" role="alert">
                  {{ invalid().join(', ') }} {{ invalid().length === 1 ? 'is not an email address' : 'are not email addresses' }}.
                </p>
              }
            </v3-field>

            <v3-field label="ROLE AND PROJECTS">
              <div class="flex flex-col gap-3">
                <app-select
                  size="sm"
                  label="Role"
                  [options]="roleChoices()"
                  [value]="role()"
                  (valueChange)="role.set($event)"
                />
                <p class="text-muted-foreground text-xs leading-snug">{{ roleDetail() }}</p>
                @if (!isOwnerRole()) {
                  <app-member-access-editor
                    [showGrants]="false"
                    [role]="role()"
                    [projects]="projectChoices()"
                    [disabled]="busy()"
                    [(value)]="access"
                  />
                  <label class="flex items-start gap-2 text-[13px]">
                    <hlm-checkbox
                      class="mt-0.5"
                      [checked]="extras()"
                      (checkedChange)="extras.set($event)"
                    />
                    <span>
                      <span class="text-foreground">Add actions beyond the role</span>
                      <span class="text-muted-foreground block text-[12px] leading-snug"
                        >Starts from what the role allows. Added for these invitations only.</span
                      >
                    </span>
                  </label>
                  @if (extras()) {
                    <app-member-access-editor
                      [showProjects]="false"
                      [role]="role()"
                      [locked]="baseline()"
                      [disabled]="busy()"
                      [(value)]="access"
                    />
                  }
                }
              </div>
            </v3-field>

            <p class="text-muted-foreground border-border border-l-2 pl-3 text-[12px] leading-snug">
              Only need one project? Open it and use Share. They join as a guest and see nothing else
              in {{ workspaceName() }}.
            </p>
          </div>

          <v3-dialog-foot>
            <button hlmBtn variant="ghost" size="sm" type="button" (click)="close()">Cancel</button>
            <button hlmBtn size="sm" type="button" [disabled]="!canSend()" (click)="send($event)">
              {{ sendLabel() }}
            </button>
          </v3-dialog-foot>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class MembersInviteDialog {
  readonly open = input(false);
  readonly closed = output<void>();

  private readonly store = inject(TramaStore);
  private readonly invites = inject(InvitesStore);
  private readonly notifier = inject(Notifier);
  private readonly chips = viewChild(EmailChips);

  protected readonly emails = signal<string[]>([]);
  protected readonly role = signal<string>('member');
  protected readonly access = signal<MemberAccess>(emptyMemberAccess());
  protected readonly extras = signal(false);
  protected readonly busy = signal(false);
  protected readonly sent = signal<InviteLink[]>([]);

  protected readonly workspaceName = computed(() => this.store.workspace()?.name ?? 'the workspace');
  protected readonly roles = computed(() => this.store.settings().roles);
  protected readonly isOwnerRole = computed(() => this.role() === 'owner');
  protected readonly isGuest = computed(() => this.role() === GUEST_ROLE_ID);
  protected readonly unmailed = computed(() => this.sent().filter((link) => !link.emailed));
  protected readonly invalid = computed(() => this.emails().filter((email) => !isEmail(email)));
  protected readonly projectChoices = computed(() =>
    [...this.store.projects()]
      .map((project) => ({ id: project.id, name: project.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  /** Roles I can grant: their permissions are inside mine. Owners can grant any role. */
  protected readonly roleChoices = computed<Option[]>(() => {
    const mine = findWorkspaceRole(this.roles(), this.store.myRole() ?? '');
    return this.roles()
      .filter((role) => canGrantRole(mine, role))
      .map((role) => ({ value: role.id, label: role.name }));
  });
  protected readonly baseline = computed<MemberGrant[]>(() => {
    const role = findWorkspaceRole(this.roles(), this.role());
    return !role || role.owner ? [...MEMBER_GRANTS] : role.grants;
  });
  protected readonly roleDetail = computed(() => {
    const role = findWorkspaceRole(this.roles(), this.role());
    if (!role) return '';
    if (role.id === GUEST_ROLE_ID)
      return 'Sees only the projects chosen below, and the people on them. Can create tasks and comment.';
    if (role.owner) return 'Manages roles and members. This role cannot be deleted.';
    const caps = role.capabilities.map((cap) => cap.replace(/([A-Z])/g, ' $1').toLowerCase());
    return caps.length ? `Can ${caps.join(', ')}.` : 'Works with tasks as the role allows.';
  });
  /** What goes into the invitation: nothing when the role applies in full to every project. */
  private readonly payload = computed<MemberAccess | null>(() => {
    if (this.isOwnerRole()) return null;
    const access = this.extras() ? this.access() : { ...this.access(), grants: [] };
    return normalizeMemberAccess(access, this.baseline());
  });
  protected readonly canSend = computed(() => {
    if (this.busy() || !this.emails().length || this.invalid().length) return false;
    if (this.isOwnerRole()) return true;
    // A list of projects with nothing ticked (and a guest always has a list) would show them nothing.
    const projects = this.access().projects;
    return projects.all ? !this.isGuest() : projects.projectIds.length > 0;
  });
  protected readonly sendLabel = computed(() => {
    const n = this.emails().length;
    if (this.busy()) return 'Sending…';
    return n > 1 ? `Send ${n} invites` : 'Send invite';
  });

  constructor() {
    // Start clean every time the dialog opens.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.emails.set([]);
        this.sent.set([]);
        this.extras.set(false);
        this.access.set(emptyMemberAccess());
        const options = this.roleChoices();
        this.role.set(
          options.find((option) => option.value === 'member')?.value ??
            options.find((option) => option.value !== 'owner')?.value ??
            options[0]?.value ??
            'member',
        );
      });
    });
    // A guest always works from a list: switching to Guest drops "all projects".
    effect(() => {
      const guest = this.isGuest();
      untracked(() => {
        const current = this.access();
        if (guest && current.projects.all)
          this.access.set({
            ...current,
            projects: { all: false, projectIds: [] },
            includeUnassigned: false,
          });
      });
    });
    // Another role: extras the new role already includes are not extras any more.
    effect(() => {
      const baseline = this.baseline();
      untracked(() => {
        const current = this.access();
        const next = normalizeMemberAccess(current, baseline);
        if (next && JSON.stringify(next) !== JSON.stringify(current)) this.access.set(next);
      });
    });
  }

  protected close(): void {
    this.closed.emit();
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    this.chips()?.commit();
    if (!this.canSend()) return;
    this.busy.set(true);
    const role: Role = this.role();
    const access = this.payload();
    const done: InviteLink[] = [];
    const failed: string[] = [];
    for (const email of this.emails()) {
      const link = await this.invites.create({ email, role, access });
      if (link) done.push(link);
      else failed.push(email);
    }
    this.busy.set(false);
    // Whoever could not be invited stays in the field to try again.
    this.emails.set(failed);
    if (!done.length) return;
    // Links only need handing over when the server could not send the email.
    if (done.some((link) => !link.emailed)) this.sent.set(done);
    else if (!failed.length) this.close();
    this.notifier.success(done.length === 1 ? 'Invitation sent' : `${done.length} invitations sent`);
  }
}
