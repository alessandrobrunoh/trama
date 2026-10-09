import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  LucideCheck,
  LucideDynamicIcon,
  LucideGlobe,
  LucideLink2,
  LucideLock,
  LucideRefreshCw,
  LucideUsers,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmRadioGroupImports } from '@spartan-ng/helm/radio-group';
import { Clipboard, NablaStore, type SavedView, type ShareLevel, type ShareVisibility } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { canManageViewSharing, publicViewUrl } from './view-access';

const VISIBILITY_ICON = { private: LucideLock, workspace: LucideUsers, link: LucideGlobe } as const;
const VISIBILITY_LABEL = { private: 'Private', workspace: 'Workspace', link: 'Public' } as const;

/**
 * "Share View" popover: copy the link, invite workspace members by email, see and remove the people
 * with access, and choose the general access (private / workspace / anyone with the link).
 */
@Component({
  selector: 'app-view-share',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, HlmPopoverImports, HlmRadioGroupImports, LucideDynamicIcon, ActorAvatar],
  template: `
    <hlm-popover align="end" sideOffset="6">
      <button hlmBtn variant="ghost" size="sm" hlmPopoverTrigger class="text-muted-foreground h-7 gap-1.5 px-2 text-xs" aria-label="Share view">
        <svg [lucideIcon]="triggerIcon()" [size]="13"></svg>
        {{ triggerLabel() }}
      </button>

      <hlm-popover-content class="w-96 max-w-[calc(100vw-2rem)] gap-3 p-3" *hlmPopoverPortal="let ctx">
        <header class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-medium">Share View</h2>
          <button hlmBtn variant="outline" size="sm" (click)="copyLink()">
            <svg [lucideIcon]="linkIcon" [size]="13"></svg>
            Copy link
          </button>
        </header>

        @if (canManage()) {
          <form class="flex items-center gap-2" (submit)="$event.preventDefault(); invite()">
            <input
              hlmInput
              class="min-w-0 flex-1"
              type="text"
              placeholder="Invite by email, comma separated"
              aria-label="Invite by email, comma separated"
              autocomplete="off"
              [value]="emails()"
              (input)="emails.set($any($event.target).value)"
            />
            <button hlmBtn size="sm" type="submit" [disabled]="busy() || !emails().trim()">Invite</button>
          </form>
        }

        <section class="flex flex-col gap-0.5" aria-label="People with access">
          <div class="flex min-h-9 items-center gap-2.5">
            @if (owner(); as o) {
              <app-actor-avatar [actor]="{ type: 'user', id: o.id }" [size]="24" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ o.name }}</span>
                <span class="text-meta block truncate">{{ o.email }}</span>
              </span>
            }
            <span class="text-muted-foreground text-xs">Owner</span>
          </div>
          @for (p of people(); track p.userId) {
            <div class="flex min-h-9 items-center gap-2.5">
              <app-actor-avatar [actor]="{ type: 'user', id: p.userId }" [size]="24" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ p.name }}</span>
                <span class="text-meta block truncate">{{ p.email }}</span>
              </span>
              @if (canManage()) {
                <button
                  hlmBtn
                  variant="ghost"
                  size="sm"
                  class="text-muted-foreground h-7 px-2 text-xs"
                  [attr.aria-label]="'Change access of ' + p.name"
                  (click)="toggleLevel(p.userId, p.level)"
                >
                  {{ p.level === 'edit' ? 'Can edit' : 'Can view' }}
                </button>
                <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [attr.aria-label]="'Remove ' + p.name" (click)="remove(p.userId)">
                  <svg [lucideIcon]="xIcon" [size]="13"></svg>
                </button>
              } @else {
                <span class="text-muted-foreground text-xs">{{ p.level === 'edit' ? 'Can edit' : 'Can view' }}</span>
              }
            </div>
          }
        </section>

        <section class="flex flex-col gap-2 border-t pt-3">
          <h3 class="text-muted-foreground text-xs font-medium">General access</h3>
          <hlm-radio-group
            class="gap-1"
            aria-label="General access"
            [value]="visibility()"
            [disabled]="!canManage() || busy()"
            (valueChange)="setVisibility($event)"
          >
            @for (o of options; track o.value) {
              <hlm-radio [value]="o.value" [disabled]="o.value !== 'private' && !canShare()" class="items-start">
                <hlm-radio-indicator indicator />
                <span class="flex flex-col">
                  <span class="text-sm leading-tight">{{ o.title }}</span>
                  <span class="text-meta">{{ o.hint }}</span>
                </span>
              </hlm-radio>
            }
          </hlm-radio-group>
          @if (visibility() === 'link') {
            <p class="text-meta bg-muted/50 rounded-md border px-2.5 py-2 leading-relaxed">
              Anyone with the link can see this view's results, read-only, even without being signed in. They cannot change filters, grouping or display, or see anything else in the workspace.
            </p>
            @if (canManage()) {
              <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground w-fit gap-1.5 px-2 text-xs" (click)="resetLink()">
                <svg [lucideIcon]="refreshIcon" [size]="12"></svg>
                Reset public link
              </button>
            }
          }
          @if (!canShare() && canManage()) {
            <p class="text-meta">Your role cannot share views with the whole workspace or publicly.</p>
          }
        </section>
      </hlm-popover-content>
    </hlm-popover>
  `,
})
export class ViewShare {
  readonly view = input.required<SavedView>();

  private readonly store = inject(NablaStore);
  private readonly clipboard = inject(Clipboard);

  protected readonly linkIcon = LucideLink2;
  protected readonly xIcon = LucideX;
  protected readonly refreshIcon = LucideRefreshCw;
  protected readonly checkIcon = LucideCheck;

  protected readonly emails = signal('');
  protected readonly busy = signal(false);

  protected readonly options: { value: ShareVisibility; title: string; hint: string }[] = [
    { value: 'private', title: 'Private', hint: 'Only people invited' },
    { value: 'workspace', title: 'Everyone in the workspace', hint: 'Every member can view it' },
    { value: 'link', title: 'Anyone with the link', hint: 'Public, read-only, no sign-in needed' },
  ];

  protected readonly visibility = computed(() => this.view().sharing.visibility);
  protected readonly triggerIcon = computed(() => VISIBILITY_ICON[this.visibility()]);
  protected readonly triggerLabel = computed(() => VISIBILITY_LABEL[this.visibility()]);
  protected readonly canManage = computed(() => canManageViewSharing(this.view(), this.store.me()?.id, this.store.myRole()));
  protected readonly canShare = computed(() => this.store.allowed('manageSharedViews'));
  protected readonly owner = computed(() => this.store.getUser(this.view().ownerId));
  protected readonly people = computed(() =>
    this.view().sharing.grants.flatMap((g) => {
      const u = this.store.getUser(g.userId);
      return u ? [{ userId: g.userId, level: g.level, name: u.name, email: u.email }] : [];
    }),
  );

  protected copyLink(): void {
    const v = this.view();
    const url = v.sharing.visibility === 'link' ? publicViewUrl(v) : null;
    void this.clipboard.copy(url ?? location.href, url ? 'Public link copied' : 'Link copied');
  }

  protected async invite(): Promise<void> {
    const list = this.emails()
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (!list.length) return;
    this.busy.set(true);
    try {
      if (await this.store.inviteToView(this.view().id, list)) this.emails.set('');
    } finally {
      this.busy.set(false);
    }
  }

  protected async setVisibility(value: unknown): Promise<void> {
    if (value !== 'private' && value !== 'workspace' && value !== 'link') return;
    if (value === this.visibility()) return;
    this.busy.set(true);
    try {
      await this.store.shareView(this.view().id, { visibility: value });
    } finally {
      this.busy.set(false);
    }
  }

  protected toggleLevel(userId: string, level: ShareLevel): void {
    const grants = this.view().sharing.grants.map((g) => (g.userId === userId ? { ...g, level: level === 'edit' ? ('view' as const) : ('edit' as const) } : g));
    void this.store.shareView(this.view().id, { grants });
  }

  protected remove(userId: string): void {
    void this.store.shareView(this.view().id, { grants: this.view().sharing.grants.filter((g) => g.userId !== userId) });
  }

  protected resetLink(): void {
    void this.store.rotateViewLink(this.view().id);
  }
}
