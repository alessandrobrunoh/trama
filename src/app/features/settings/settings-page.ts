import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideTriangleAlert } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import {
  NablaStore,
  Notifier,
  PROVIDERS,
  PROVIDER_META,
  ROLE_META,
  ROLES,
  SessionStore,
  UiStore,
  type Role,
} from '../../core';
import { ThemeService, type ThemeMode } from '../../core/theme/theme.service';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { ProviderIcon } from '../../shared/provider-icon';
import { RelativeTimePipe } from '../../shared/pipes';
import { AppSelect, type Option } from '../create/form-kit';

interface Section {
  id: string;
  label: string;
}

const SECTIONS: Section[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'members', label: 'Members' },
  { id: 'teams', label: 'Teams' },
  { id: 'agents', label: 'Agents' },
  { id: 'tokens', label: 'API tokens' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'danger', label: 'Danger' },
];

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmInputImports,
    PageHeader,
    EmptyState,
    ActorAvatar,
    ProviderIcon,
    RelativeTimePipe,
    AppSelect,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header title="Settings" [description]="sectionLabel()" />
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav class="flex gap-1 overflow-x-auto border-b px-3 py-2 md:w-48 md:shrink-0 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:px-2 md:py-3" aria-label="Settings sections">
        @for (s of sections; track s.id) {
          <a
            class="hover:bg-muted rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap"
            [class.bg-muted]="section() === s.id"
            [routerLink]="['/', slug(), 'settings', s.id]"
          >{{ s.label }}</a>
        }
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        @switch (section()) {
          @case ('profile') {
            <section class="max-w-lg">
              <h2 class="text-sm font-semibold">Profile</h2>
              <p class="text-muted-foreground mt-1 text-sm">This is the account you signed in with. Name and email are set when the account is created.</p>
              <dl class="mt-4 grid gap-3 text-sm">
                <div>
                  <dt class="text-muted-foreground text-xs">Name</dt>
                  <dd>{{ me()?.name }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground text-xs">Email</dt>
                  <dd>{{ me()?.email }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground text-xs">Role here</dt>
                  <dd>{{ roleLabel() }}</dd>
                </div>
              </dl>
            </section>
          }
          @case ('appearance') {
            <section class="max-w-lg">
              <h2 class="text-sm font-semibold">Appearance</h2>
              <p class="text-muted-foreground mt-1 text-sm">System follows this device. ⌘J toggles light and dark.</p>
              <div class="mt-4 flex gap-2">
                @for (t of themes; track t.id) {
                  <button hlmBtn size="sm" [variant]="theme.mode() === t.id ? 'default' : 'outline'" (click)="theme.set(t.id)">{{ t.label }}</button>
                }
              </div>
            </section>
          }
          @case ('workspace') {
            <section class="max-w-lg">
              <h2 class="text-sm font-semibold">Workspace</h2>
              <p class="text-muted-foreground mt-1 text-sm">The slug is the address of this workspace. Changing it moves everyone to the new URL.</p>
              <form class="mt-4 grid gap-3" (submit)="saveWorkspace($event)">
                <label class="grid gap-1 text-xs">
                  Name
                  <input hlmInput [value]="wsName()" [disabled]="!canAdmin()" (input)="wsName.set($any($event.target).value)" />
                </label>
                <label class="grid gap-1 text-xs">
                  Slug
                  <input hlmInput class="font-mono" [value]="wsSlug()" [disabled]="!canAdmin()" (input)="wsSlug.set($any($event.target).value)" />
                </label>
                @if (canAdmin()) {
                  <button hlmBtn size="sm" class="w-fit" type="submit" [disabled]="busy()">Save workspace</button>
                }
              </form>
            </section>
          }
          @case ('members') {
            <section class="max-w-2xl">
              <h2 class="text-sm font-semibold">Members</h2>
              <p class="text-muted-foreground mt-1 text-sm">People who can open this workspace. Invite someone who already has an account.</p>
              @if (canAdmin()) {
                <form class="mt-4 flex flex-wrap items-end gap-2" (submit)="addMember($event)">
                  <label class="grid min-w-48 flex-1 gap-1 text-xs">
                    Email
                    <input hlmInput type="email" placeholder="ada@company.com" [value]="inviteEmail()" (input)="inviteEmail.set($any($event.target).value)" />
                  </label>
                  <div class="w-36">
                    <app-select [options]="roleOptions" [(value)]="inviteRole" label="Role" />
                  </div>
                  <button hlmBtn size="sm" type="submit" [disabled]="!inviteEmail().trim() || busy()">Invite</button>
                </form>
              }
              <ul class="mt-4 divide-y">
                @for (m of store.members(); track m.membership.id) {
                  <li class="flex flex-wrap items-center gap-3 py-2">
                    <app-actor-avatar [actor]="{ type: 'user', id: m.user.id }" [size]="24" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm">{{ m.user.name }}</span>
                      <span class="text-muted-foreground block truncate text-xs">{{ m.user.email }}</span>
                    </span>
                    @if (canAdmin()) {
                      <div class="w-32">
                        <app-select [options]="roleOptions" [value]="m.membership.role" (valueChange)="setRole(m.membership.id, $event)" label="Role" size="sm" />
                      </div>
                      <button hlmBtn variant="ghost" size="sm" (click)="removeMember(m.membership.id, m.user.name)">Remove</button>
                    } @else {
                      <span class="text-muted-foreground text-xs">{{ roleName(m.membership.role) }}</span>
                    }
                  </li>
                }
              </ul>
            </section>
          }
          @case ('teams') {
            <section class="max-w-lg">
              <h2 class="text-sm font-semibold">Teams</h2>
              <p class="text-muted-foreground mt-1 text-sm">Teams own workstreams. Manage them on the teams page.</p>
              <ul class="mt-4 divide-y">
                @for (t of store.teams(); track t.id) {
                  <li>
                    <a class="hover:bg-muted flex items-center gap-2 rounded-md py-2 text-sm" [routerLink]="['/', slug(), 'teams', t.key]">
                      <span class="size-2.5 rounded-full" [style.background]="t.color"></span>
                      <span class="min-w-0 flex-1 truncate">{{ t.name }}</span>
                      <span class="text-muted-foreground font-mono text-xs">{{ t.key }}</span>
                    </a>
                  </li>
                } @empty {
                  <li class="text-muted-foreground text-sm">No teams yet.</li>
                }
              </ul>
              @if (canAdmin()) {
                <button hlmBtn size="sm" class="mt-3" (click)="ui.openCreate('team')">New team</button>
              }
            </section>
          }
          @case ('agents') {
            <section class="max-w-lg">
              <h2 class="text-sm font-semibold">Agents</h2>
              <p class="text-muted-foreground mt-1 text-sm">Runtimes that can act in this workspace, with their own API tokens.</p>
              @if (canAdmin()) {
                <form class="mt-4 grid gap-2" (submit)="addAgent($event)">
                  <input hlmInput placeholder="Agent name" [value]="agentName()" (input)="agentName.set($any($event.target).value)" />
                  <app-select [options]="agentProviders" [(value)]="agentProvider" label="Provider" />
                  <button hlmBtn size="sm" class="w-fit" type="submit" [disabled]="!agentName().trim() || busy()">Add agent</button>
                </form>
              }
              <ul class="mt-4 divide-y">
                @for (a of store.agents(); track a.id) {
                  <li class="flex items-center gap-2 py-2 text-sm">
                    <app-provider-icon [provider]="a.provider" [size]="14" />
                    <span class="min-w-0 flex-1 truncate">{{ a.name }}</span>
                    <span class="text-muted-foreground text-xs">{{ providerName(a.provider) }}</span>
                    @if (canAdmin()) {
                      <button hlmBtn variant="ghost" size="sm" (click)="removeAgent(a.id, a.name)">Remove</button>
                    }
                  </li>
                } @empty {
                  <li class="text-muted-foreground py-2 text-sm">No agents yet.</li>
                }
              </ul>
            </section>
          }
          @case ('tokens') {
            <section class="max-w-lg">
              <h2 class="text-sm font-semibold">API tokens</h2>
              <p class="text-muted-foreground mt-1 text-sm">Tokens let agents and scripts act as you, or as an agent. The secret is shown only once.</p>
              @if (secret(); as s) {
                <div class="bg-muted mt-4 rounded-md p-3">
                  <p class="text-xs font-medium">Copy this secret now. It will not be shown again.</p>
                  <p class="mt-1 font-mono text-xs break-all">{{ s }}</p>
                  <button hlmBtn size="sm" class="mt-2" variant="outline" type="button" (click)="copySecret()">Copy</button>
                </div>
              }
              <form class="mt-4 flex flex-wrap items-end gap-2" (submit)="addToken($event)">
                <label class="grid min-w-40 flex-1 gap-1 text-xs">
                  Name
                  <input hlmInput placeholder="CI" [value]="tokenName()" (input)="tokenName.set($any($event.target).value)" />
                </label>
                <button hlmBtn size="sm" type="submit" [disabled]="!tokenName().trim() || busy()">Create token</button>
              </form>
              <ul class="mt-4 divide-y">
                @for (t of store.tokens(); track t.id) {
                  <li class="flex items-center gap-2 py-2 text-sm">
                    <span class="min-w-0 flex-1">
                      <span class="block truncate">{{ t.name }}</span>
                      <span class="text-muted-foreground font-mono text-xs">{{ t.prefix }}</span>
                    </span>
                    <span class="text-muted-foreground hidden text-xs sm:inline">{{ t.lastUsedAt ? (t.lastUsedAt | relativeTime) : 'Never used' }}</span>
                    <button hlmBtn variant="ghost" size="sm" (click)="revoke(t.id, t.name)">Revoke</button>
                  </li>
                } @empty {
                  <li class="text-muted-foreground py-2 text-sm">No tokens yet.</li>
                }
              </ul>
            </section>
          }
          @case ('integrations') {
            <section class="max-w-lg">
              <h2 class="text-sm font-semibold">Integrations</h2>
              <p class="text-muted-foreground mt-1 text-sm">Connect GitHub, GitLab or Delta. Tokens stay on the server and are never shown again.</p>
              @if (canAdmin()) {
                <form class="mt-4 grid gap-2" (submit)="connect($event)">
                  <app-select [options]="integrationProviders" [(value)]="integrationProvider" label="Provider" />
                  <input hlmInput placeholder="Account, e.g. acme" [value]="integrationAccount()" (input)="integrationAccount.set($any($event.target).value)" />
                  <input hlmInput type="password" placeholder="Token" autocomplete="off" [value]="integrationToken()" (input)="integrationToken.set($any($event.target).value)" />
                  <button hlmBtn size="sm" class="w-fit" type="submit" [disabled]="busy()">Connect</button>
                </form>
              }
              <ul class="mt-4 divide-y">
                @for (c of store.integrations(); track c.id) {
                  <li class="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <app-provider-icon [provider]="c.provider" [size]="14" />
                    <span class="min-w-0 flex-1 truncate">{{ c.account || c.provider }}</span>
                    <span class="text-muted-foreground text-xs">{{ c.status }}</span>
                    @if (canAdmin()) {
                      <button hlmBtn variant="ghost" size="sm" (click)="sync(c.id)">Sync</button>
                      <button hlmBtn variant="ghost" size="sm" (click)="disconnect(c.id)">Disconnect</button>
                    }
                    @if (c.lastError) {
                      <p class="text-destructive basis-full text-xs">{{ c.lastError }}</p>
                    }
                  </li>
                } @empty {
                  <li class="text-muted-foreground py-2 text-sm">Nothing connected.</li>
                }
              </ul>
            </section>
          }
          @case ('shortcuts') {
            <section class="max-w-lg">
              <h2 class="text-sm font-semibold">Keyboard shortcuts</h2>
              <p class="text-muted-foreground mt-1 text-sm">Press ? anywhere outside a text field.</p>
              <button hlmBtn size="sm" class="mt-4" type="button" (click)="ui.openModal('shortcuts')">Open shortcuts</button>
            </section>
          }
          @case ('danger') {
            <section class="max-w-lg">
              <h2 class="text-sm font-semibold">Danger</h2>
              <p class="text-muted-foreground mt-1 text-sm">Deleting the workspace removes its workstreams, issues, projects and history. Only the owner can do this.</p>
              @if (canOwner()) {
                <button hlmBtn variant="destructive" size="sm" class="mt-4" (click)="deleteWorkspace()">Delete workspace</button>
              }
            </section>
          }
          @default {
            <app-empty-state [icon]="warn" title="Unknown settings section" description="Pick a section from the list." />
          }
        }
      </div>
    </div>
  `,
})
export class SettingsPage {
  readonly workspaceSlug = input<string>();
  readonly section = input<string>();

  private readonly session = inject(SessionStore);
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly theme = inject(ThemeService);
  private readonly notify = inject(Notifier);

  protected readonly sections = SECTIONS;
  protected readonly themes = THEMES;
  protected readonly warn = LucideTriangleAlert;
  protected readonly roleOptions: Option[] = ROLES.map((r) => ({ value: r, label: ROLE_META[r].label }));
  protected readonly agentProviders: Option[] = PROVIDERS.filter((p) => p !== 'human').map((p) => ({
    value: p,
    label: PROVIDER_META[p].label,
  }));
  protected readonly integrationProviders: Option[] = [
    { value: 'github', label: 'GitHub' },
    { value: 'gitlab', label: 'GitLab' },
    { value: 'delta', label: 'Delta' },
  ];

  protected readonly busy = signal(false);
  protected readonly wsName = signal('');
  protected readonly wsSlug = signal('');
  protected readonly inviteEmail = signal('');
  protected readonly inviteRole = signal('member');
  protected readonly agentName = signal('');
  protected readonly agentProvider = signal('delta');
  protected readonly tokenName = signal('');
  protected readonly secret = signal<string | null>(null);
  protected readonly integrationProvider = signal('github');
  protected readonly integrationAccount = signal('');
  protected readonly integrationToken = signal('');

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly me = computed(() => this.session.user() ?? this.store.me());
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly canOwner = computed(() => this.store.can('owner'));
  protected readonly sectionLabel = computed(() => SECTIONS.find((s) => s.id === this.section())?.label ?? 'Settings');
  protected readonly roleLabel = computed(() => {
    const role = this.session.role();
    return role ? ROLE_META[role].label : '';
  });

  constructor() {
    effect(() => {
      const ws = this.session.workspace();
      if (!ws) return;
      untracked(() => {
        this.wsName.set(ws.name);
        this.wsSlug.set(ws.slug);
      });
    });
    effect(() => {
      if (this.section() === 'tokens') void this.store.loadTokens();
    });
  }

  protected roleName(role: Role): string {
    return ROLE_META[role].label;
  }
  protected providerName(provider: string): string {
    return PROVIDER_META[provider as keyof typeof PROVIDER_META]?.label ?? provider;
  }

  protected async saveWorkspace(event: Event): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    const ok = await this.session.updateWorkspace({ name: this.wsName().trim(), slug: this.wsSlug().trim() });
    this.busy.set(false);
    if (ok) this.notify.success('Workspace updated');
  }

  protected async addMember(event: Event): Promise<void> {
    event.preventDefault();
    const email = this.inviteEmail().trim();
    if (!email) return;
    this.busy.set(true);
    const created = await this.store.addMember({ email, role: this.inviteRole() as Role });
    this.busy.set(false);
    if (created) this.inviteEmail.set('');
  }

  protected setRole(membershipId: string, role: string): void {
    if (!ROLES.includes(role as Role)) return;
    void this.store.updateMemberRole(membershipId, role as Role);
  }

  protected removeMember(id: string, name: string): void {
    this.ui.setConfirmDelete({
      title: `Remove ${name}?`,
      description: 'They lose access to this workspace. Their account stays.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.store.removeMember(id);
      },
    });
  }

  protected async addAgent(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.agentName().trim();
    if (!name) return;
    this.busy.set(true);
    const created = await this.store.createAgent({
      name,
      provider: this.agentProvider() as Exclude<import('../../core').ExecutionProvider, 'human'>,
    });
    this.busy.set(false);
    if (created) this.agentName.set('');
  }

  protected removeAgent(id: string, name: string): void {
    this.ui.setConfirmDelete({
      title: `Remove ${name}?`,
      description: 'Tokens that act as this agent stop working.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.store.deleteAgent(id);
      },
    });
  }

  protected async addToken(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.tokenName().trim();
    if (!name) return;
    this.busy.set(true);
    const created = await this.store.createToken({ name });
    this.busy.set(false);
    if (created) {
      this.tokenName.set('');
      this.secret.set(created.secret);
    }
  }

  protected async copySecret(): Promise<void> {
    const value = this.secret();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      this.notify.success('Secret copied');
    } catch {
      this.notify.error('Could not copy the secret');
    }
  }

  protected revoke(id: string, name: string): void {
    this.ui.setConfirmDelete({
      title: `Revoke ${name}?`,
      description: 'Anything using this token loses access immediately.',
      confirmLabel: 'Revoke',
      onConfirm: async () => {
        await this.store.deleteToken(id);
      },
    });
  }

  protected async connect(event: Event): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    const created = await this.store.createIntegration({
      provider: this.integrationProvider() as 'github' | 'gitlab' | 'delta',
      account: this.integrationAccount().trim() || undefined,
      token: this.integrationToken().trim() || undefined,
    });
    this.busy.set(false);
    if (created) {
      this.integrationAccount.set('');
      this.integrationToken.set('');
    }
  }

  protected sync(id: string): void {
    void this.store.syncIntegration(id);
  }

  protected disconnect(id: string): void {
    this.ui.setConfirmDelete({
      title: 'Disconnect this integration?',
      description: 'Projects and artifacts stay. New webhook events for it are ignored.',
      confirmLabel: 'Disconnect',
      onConfirm: async () => {
        await this.store.deleteIntegration(id);
      },
    });
  }

  protected deleteWorkspace(): void {
    const name = this.session.workspace()?.name ?? 'this workspace';
    this.ui.setConfirmDelete({
      title: `Delete ${name}?`,
      description: 'Every workstream, issue, project and decision in it is removed. This cannot be undone.',
      confirmLabel: 'Delete workspace',
      onConfirm: async () => {
        await this.session.deleteWorkspace();
      },
    });
  }
}
