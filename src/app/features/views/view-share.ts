// "Share view" popover (v3 "41 · Views · Share popover"): invite people by email, see who has access,
// pick the general access and copy the public link. 420px, raised fill, hairline, square corners.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  LucideChevronDown,
  LucideDynamicIcon,
  LucideEye,
  LucideGlobe,
  LucideLink2,
  LucideLock,
  LucideRotateCcw,
  LucideUsers,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmRadioGroupImports } from '@spartan-ng/helm/radio-group';
import { Clipboard, TramaStore, type SavedView, type ShareLevel, type ShareVisibility } from '../../core';
import { V3NameAvatar } from './view-atoms';
import { canManageViewSharing, publicViewUrl } from './view-access';

const VISIBILITY_ICON = { private: LucideLock, workspace: LucideUsers, link: LucideGlobe } as const;
const VISIBILITY_LABEL = { private: 'Private', workspace: 'Workspace', link: 'Public' } as const;

const ROW = 'items-center gap-2.5 border border-transparent p-2';
const ROW_ON = 'bg-primary/10 border-primary/40';

/**
 * "Share View" popover: copy the link, invite workspace members by email, see and remove the people
 * with access, and choose the general access (private / workspace / anyone with the link).
 */
@Component({
  selector: 'app-view-share',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmPopoverImports, HlmRadioGroupImports, LucideDynamicIcon, V3NameAvatar],
  template: `
    <hlm-popover align="end" sideOffset="6">
      <button
        hlmBtn
        variant="outline"
        hlmPopoverTrigger
        aria-label="Share view"
        [class]="isPublic() ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20' : ''"
      >
        <svg [lucideIcon]="triggerIcon()" [size]="13"></svg>
        {{ triggerLabel() }}
      </button>

      <hlm-popover-content
        class="bg-secondary border-border w-[420px] max-w-[calc(100vw-2rem)] gap-0 rounded-none border p-0 shadow-[0_16px_40px_#00000080]"
        *hlmPopoverPortal="let ctx"
      >
        <header class="border-border flex min-h-[52px] items-center justify-between gap-3 border-b px-4 py-3.5">
          <h2 class="font-title text-foreground text-[19px] leading-[22px]">Share view</h2>
        </header>

        <div class="flex flex-col gap-4 p-4">
          @if (canManage()) {
            <form class="flex items-start gap-2" (submit)="$event.preventDefault(); invite()">
              <input
                class="bg-background border-border text-foreground placeholder:text-faint focus:border-primary h-[30px] min-w-0 flex-1 border px-2.5 font-mono text-[11.5px] outline-none"
                type="text"
                placeholder="Invite by email, comma separated"
                aria-label="Invite by email, comma separated"
                autocomplete="off"
                [value]="emails()"
                (input)="emails.set($any($event.target).value)"
              />
              <button
                hlmBtn
                variant="outline"
                type="submit"
                class="bg-card h-[30px] px-3 text-[11.5px]"
                [disabled]="busy() || !emails().trim()"
              >
                Invite
              </button>
            </form>
          }

          <section class="flex flex-col gap-2.5" aria-label="People with access">
            <div class="flex items-center gap-2.5">
              @if (owner(); as o) {
                <v3-name-avatar [name]="o.name" [size]="26" />
                <span class="flex min-w-0 flex-1 flex-col gap-px">
                  <span class="text-foreground truncate text-[13px] leading-[16px]">{{ o.name }}</span>
                  <span class="text-faint truncate font-mono text-[10.5px] leading-[13px]">{{ o.email }}</span>
                </span>
              } @else {
                <span class="flex-1"></span>
              }
              <span class="text-muted-foreground font-mono text-[11px]">Owner</span>
            </div>
            @for (p of people(); track p.userId) {
              <div class="flex items-center gap-2.5">
                <v3-name-avatar [name]="p.name" [size]="26" />
                <span class="flex min-w-0 flex-1 flex-col gap-px">
                  <span class="text-foreground truncate text-[13px] leading-[16px]">{{ p.name }}</span>
                  <span class="text-faint truncate font-mono text-[10.5px] leading-[13px]">{{ p.email }}</span>
                </span>
                @if (canManage()) {
                  <button
                    hlmBtn
                    variant="ghost"
                    class="h-6 gap-1 px-1.5 text-[11px]"
                    [attr.aria-label]="'Change access of ' + p.name"
                    (click)="toggleLevel(p.userId, p.level)"
                  >
                    {{ p.level === 'edit' ? 'Can edit' : 'Can view' }}
                    <svg [lucideIcon]="chevronIcon" [size]="11" aria-hidden="true"></svg>
                  </button>
                  <button
                    hlmBtn
                    variant="ghost"
                    class="size-6 px-0"
                    [attr.aria-label]="'Remove ' + p.name"
                    (click)="remove(p.userId)"
                  >
                    <svg [lucideIcon]="xIcon" [size]="13"></svg>
                  </button>
                } @else {
                  <span class="text-muted-foreground font-mono text-[11px]">{{
                    p.level === 'edit' ? 'Can edit' : 'Can view'
                  }}</span>
                }
              </div>
            }
          </section>

          <section class="border-border flex flex-col gap-0.5 border-t pt-3.5">
            <h3 class="text-faint pb-0.5 font-mono text-[10px] leading-[12px] tracking-[1px]">
              GENERAL ACCESS
            </h3>
            <hlm-radio-group
              class="gap-0.5"
              aria-label="General access"
              [value]="visibility()"
              [disabled]="!canManage() || busy()"
              (valueChange)="setVisibility($event)"
            >
              @for (o of options; track o.value) {
                <hlm-radio
                  [value]="o.value"
                  [disabled]="o.value !== 'private' && !canShare()"
                  [class]="rowClass(o.value)"
                >
                  <span
                    indicator
                    class="border-faint group-data-[checked=true]:border-primary flex size-3.5 shrink-0 items-center justify-center border-[1.5px]"
                  >
                    <span class="group-data-[checked=true]:bg-primary size-1.5 bg-transparent"></span>
                  </span>
                  <svg [lucideIcon]="o.icon" [size]="14" class="text-faint shrink-0" aria-hidden="true"></svg>
                  <span class="flex flex-col gap-px">
                    <span class="text-foreground text-[13px] leading-[16px]">{{ o.title }}</span>
                    <span class="text-faint font-mono text-[10.5px] leading-[13px]">{{ o.hint }}</span>
                  </span>
                </hlm-radio>
              }
            </hlm-radio-group>
          </section>

          @if (isPublic()) {
            <div class="flex items-center gap-2">
              @if (linkLabel(); as label) {
                <span
                  class="bg-background border-border text-muted-foreground flex h-[30px] min-w-0 flex-1 items-center gap-2 border px-2.5 font-mono text-[11.5px]"
                >
                  <svg [lucideIcon]="linkIcon" [size]="12" class="text-faint shrink-0" aria-hidden="true"></svg>
                  <span class="truncate">{{ label }}</span>
                </span>
              } @else {
                <span class="flex-1"></span>
              }
              <button hlmBtn class="h-[30px] gap-1.5 px-3 text-[11.5px]" (click)="copyLink()">
                <svg [lucideIcon]="linkIcon" [size]="13"></svg>
                Copy link
              </button>
            </div>
            <div class="bg-card flex items-start gap-2.5 px-3 py-2.5">
              <svg [lucideIcon]="eyeIcon" [size]="14" class="text-faint mt-0.5 shrink-0" aria-hidden="true"></svg>
              <p class="text-muted-foreground flex-1 text-[12px] leading-[18px]">
                Visitors see this view's results, read-only. They can search inside it, but can't change
                filters, grouping or display, or see anything else in the workspace.
              </p>
            </div>
          }
        </div>

        @if (isPublic() && canManage()) {
          <footer class="border-border flex items-center justify-between border-t px-4 py-2.5">
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 font-mono text-[11px] leading-[14px]"
              (click)="resetLink()"
            >
              <svg [lucideIcon]="refreshIcon" [size]="12" aria-hidden="true"></svg>
              Reset public link
            </button>
          </footer>
        }
      </hlm-popover-content>
    </hlm-popover>
  `,
})
export class ViewShare {
  readonly view = input.required<SavedView>();

  private readonly store = inject(TramaStore);
  private readonly clipboard = inject(Clipboard);

  protected readonly linkIcon = LucideLink2;
  protected readonly xIcon = LucideX;
  protected readonly refreshIcon = LucideRotateCcw;
  protected readonly chevronIcon = LucideChevronDown;
  protected readonly eyeIcon = LucideEye;

  protected readonly emails = signal('');
  protected readonly busy = signal(false);

  protected readonly options: { value: ShareVisibility; title: string; hint: string; icon: typeof LucideLock }[] = [
    { value: 'private', title: 'Private', hint: 'Only people invited', icon: LucideLock },
    { value: 'workspace', title: 'Everyone in the workspace', hint: 'Every member can view it', icon: LucideUsers },
    { value: 'link', title: 'Anyone with the link', hint: 'Public, read-only, no sign-in needed', icon: LucideGlobe },
  ];

  protected readonly visibility = computed(() => this.view().sharing.visibility);
  protected readonly isPublic = computed(() => this.visibility() === 'link');
  protected readonly triggerIcon = computed(() => VISIBILITY_ICON[this.visibility()]);
  protected readonly triggerLabel = computed(() => VISIBILITY_LABEL[this.visibility()]);
  protected readonly canManage = computed(() =>
    canManageViewSharing(this.view(), this.store.me()?.id, this.store.myRole(), {
      canWrite: this.store.can('member'),
      canAdmin: this.store.can('admin'),
    }),
  );
  protected readonly canShare = computed(() => this.store.allowed('manageSharedViews'));
  protected readonly owner = computed(() => this.store.getUser(this.view().ownerId));
  protected readonly people = computed(() =>
    this.view().sharing.grants.flatMap((g) => {
      const u = this.store.getUser(g.userId);
      return u ? [{ userId: g.userId, level: g.level, name: u.name, email: u.email }] : [];
    }),
  );
  /** The public link, shortened for display ("trama.dev/shared/vt_ksLwZ0…3h0XmA"); only managers get the token. */
  protected readonly linkLabel = computed(() => {
    const token = this.isPublic() ? this.view().publicToken : undefined;
    if (!token) return null;
    const short = token.length > 16 ? `${token.slice(0, 8)}…${token.slice(-6)}` : token;
    return `${location.host}/shared/${short}`;
  });

  protected rowClass(value: ShareVisibility): string {
    return value === this.visibility() ? `${ROW} ${ROW_ON}` : ROW;
  }

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
