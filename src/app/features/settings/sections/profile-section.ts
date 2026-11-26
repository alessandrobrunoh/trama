import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { LucideDynamicIcon, LucideFolderSymlink, LucideLaptop, LucidePlus } from '@lucide/angular';
import { SessionStore } from '../../../core/session/session.store';
import { SharedProjectsStore } from '../../../core/stores/shared-projects.store';
import { TramaStore } from '../../../core/stores/trama.store';
import { workspaceRoleName } from '../../../core/contracts/domain';
import { Clipboard } from '../../../core/notify/notifier';
import { avatarColor, initials } from '../../../core/utils';
import type { Role, SharedProject, Workspace } from '../../../core/contracts/domain';
import { AppSelect, type Option } from '../../create/form-kit';
import { SECTION_KIT } from './section-kit';

/** Value of the "Show in" picker of a shared project that sits only under Shared with me. */
const SHARED_ONLY = '__shared__';
/** Value of the "Show in" picker of a shared project the person hid. */
const HIDDEN = '__hidden__';

/** Field of the v4 settings frames, read-only here: 300px, `bg-background`, hairline, 13px text. */
const READONLY_FIELD =
  'bg-background border-border text-foreground focus-visible:border-primary w-full min-w-0 border px-[9px] py-1.5 font-sans text-[13px] leading-[normal] outline-none sm:w-[300px]';

/** Tag of the v4 frames: hairline pill in mono 11, raised fill; `current` variant tinted with the accent. */
const TAG = 'border-border bg-secondary text-text-2 border px-[7px] py-0.5 font-mono text-[11px] leading-[normal]';
const TAG_CURRENT = 'border-primary/40 bg-primary/10 text-foreground border px-[7px] py-0.5 font-mono text-[11px] leading-[normal]';

/**
 * Settings → Profile (v4 frame): the avatar head, the account card (identity set at sign-up, read-only), the
 * workspaces you belong to, the projects shared with you and where you show them, and this session.
 */
@Component({
  selector: 'app-profile-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, AppSelect, LucideDynamicIcon, DatePipe, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9 leading-[normal]' },
  template: `
    <div class="flex items-center gap-5">
      <span
        class="font-title flex size-[72px] shrink-0 items-center justify-center text-[30px] leading-[normal] text-white"
        [style.background]="hueColor()"
        aria-hidden="true"
        >{{ userInitials() }}</span
      >
      <div class="flex min-w-0 flex-1 flex-col gap-[5px]">
        <h2 class="font-title text-foreground truncate text-[32px] leading-[normal]">{{ user()?.name }}</h2>
        <p class="text-muted-foreground font-mono text-[10.5px] leading-[normal]">
          {{ session.workspaces().length }} {{ session.workspaces().length === 1 ? 'workspace' : 'workspaces' }}
          @if (shared.items().length; as n) {
            · {{ n }} shared {{ n === 1 ? 'project' : 'projects' }}
          }
          @if (user()?.createdAt; as since) {
            · member since {{ since | date: 'MMM d, y' }}
          }
        </p>
      </div>
    </div>

    <app-settings-block title="Account">
      <app-settings-card>
        <app-card-row label="Full name">
          <input class="${READONLY_FIELD}" readonly aria-label="Full name" [value]="user()?.name ?? ''" />
        </app-card-row>
        <app-card-row label="Email" description="Used to sign in and for notifications.">
          <button
            type="button"
            class="text-text-2 hover:text-foreground font-mono text-[12px] leading-[normal]"
            title="Copy email"
            (click)="copyEmail()"
          >
            {{ user()?.email }}
          </button>
        </app-card-row>
      </app-settings-card>
    </app-settings-block>

    <app-settings-block title="Workspaces" [caption]="'' + session.workspaces().length">
      <a aside hlmBtn size="sm" variant="outline" routerLink="/new-workspace">
        <svg [lucideIcon]="plus" [size]="13"></svg> Create workspace
      </a>
      <app-settings-card>
        @for (w of session.workspaces(); track w.id) {
          <div class="flex items-center gap-3 px-4 py-[11px]">
            <span
              class="font-title flex size-[26px] shrink-0 items-center justify-center text-[14px] leading-[normal] text-white"
              [style.background]="tileColor(w)"
              aria-hidden="true"
              >{{ w.name.charAt(0).toUpperCase() }}</span
            >
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="flex items-center gap-2">
                <span class="text-foreground truncate text-[13px] leading-[normal]">{{ w.name }}</span>
                @if (w.personal) {
                  <span class="${TAG}">personal</span>
                }
              </span>
              <span class="text-faint truncate font-mono text-[10.5px] leading-[normal]">
                /{{ w.slug }}@if (roleName(w); as r) { · {{ r }} }@if (w.personal) { · can be renamed, never left or deleted }
              </span>
            </div>
            @if (w.slug === store.slug()) {
              <span class="${TAG_CURRENT}">current</span>
            } @else {
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground text-[12.5px] leading-[normal]"
                (click)="session.switchWorkspace(w.slug)"
              >
                Open
              </button>
            }
          </div>
        }
      </app-settings-card>
    </app-settings-block>

    @if (shared.items().length) {
      <app-settings-block
        title="Shared with me"
        [caption]="'' + shared.items().length"
        description="Projects you're a guest on. They stay in their workspace; Show in only adds a link to one of your sidebars and gives nobody else access."
      >
        <app-settings-card>
          @for (p of shared.items(); track p.id) {
            <div class="flex items-center gap-3 px-4 py-[11px]">
              <svg [lucideIcon]="folder" [size]="16" class="text-muted-foreground shrink-0"></svg>
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <a
                  class="text-foreground w-fit max-w-full truncate text-[13px] leading-[normal] hover:underline"
                  [routerLink]="['/', p.workspace.slug, 'projects', p.id]"
                  >{{ p.name }}</a
                >
                <span class="text-faint truncate font-mono text-[10.5px] leading-[normal]">{{ p.workspace.name }} · {{ sharedRole(p) }}</span>
              </div>
              <span class="text-faint font-mono text-[10.5px] leading-[normal]">Show in</span>
              <app-select
                class="w-[180px] shrink-0"
                [label]="'Show ' + p.name + ' in'"
                [options]="showInOptions(p)"
                [value]="showInValue(p)"
                (valueChange)="setShowIn(p, $event)"
              />
            </div>
          }
        </app-settings-card>
      </app-settings-block>
    }

    <app-settings-block title="Sessions" caption="1">
      <app-settings-card>
        <div class="flex items-center gap-3 px-4 py-[11px]">
          <svg [lucideIcon]="laptop" [size]="16" class="text-muted-foreground shrink-0"></svg>
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="flex items-center gap-2">
              <span class="text-foreground truncate text-[13px] leading-[normal]">{{ browser }}</span>
              <span class="${TAG_CURRENT}">this device</span>
            </span>
            <span class="text-faint truncate font-mono text-[10.5px] leading-[normal]">{{ user()?.email }}</span>
          </div>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground text-[12.5px] leading-[normal]"
            (click)="session.logout()"
          >
            Sign out
          </button>
        </div>
      </app-settings-card>
    </app-settings-block>
  `,
})
export class ProfileSection {
  protected readonly session = inject(SessionStore);
  protected readonly store = inject(TramaStore);
  protected readonly shared = inject(SharedProjectsStore);
  private readonly clipboard = inject(Clipboard);
  protected readonly plus = LucidePlus;
  protected readonly folder = LucideFolderSymlink;
  protected readonly laptop = LucideLaptop;
  protected readonly browser = browserName();
  protected readonly user = computed(() => this.session.user() ?? this.store.me());
  protected readonly userInitials = computed(() => initials(this.user()?.name ?? ''));
  protected readonly hueColor = computed(() => avatarColor(this.user()?.avatarHue ?? 0));

  /** A workspace has no colour of its own: a stable hue from its name, so each tile keeps its colour. */
  protected tileColor(w: Workspace): string {
    let hue = 0;
    for (const ch of w.name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    return avatarColor(hue);
  }

  protected roleName(w: Workspace): string {
    const role = (w as Workspace & { role?: Role }).role;
    return role ? workspaceRoleName(w.id === this.store.workspace()?.id ? this.store.settings().roles : [], role) : '';
  }

  protected sharedRole(p: SharedProject): string {
    return workspaceRoleName([], p.role);
  }

  /** Where the project is shown: under Shared with me only, hidden, or in one of my workspaces. */
  protected showInValue(p: SharedProject): string {
    if (!p.placement) return SHARED_ONLY;
    return p.placement.workspaceId ?? HIDDEN;
  }

  protected showInOptions(p: SharedProject): Option[] {
    const options: Option[] = [{ value: SHARED_ONLY, label: 'Shared with me only' }];
    for (const w of this.session.workspaces()) options.push({ value: w.id, label: w.name });
    if (p.placement && p.placement.workspaceId === null) options.push({ value: HIDDEN, label: 'Hidden' });
    return options;
  }

  protected setShowIn(p: SharedProject, value: string): void {
    if (!value || value === this.showInValue(p)) return;
    if (value === SHARED_ONLY) void this.shared.clear(p.id);
    else if (value === HIDDEN) void this.shared.hide(p.id);
    else void this.shared.place(p.id, value);
  }

  protected copyEmail(): void {
    const email = this.user()?.email;
    if (email) void this.clipboard.copy(email, 'Email copied');
  }
}

/** "Safari", "Chrome" … from the user agent: the only thing known about this device. */
function browserName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'This browser';
}
