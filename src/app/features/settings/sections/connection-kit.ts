// Shared by Settings → Integrations (workspace connections) and Settings → Integrations (account,
// personal connections): provider copy, status wording and the two forms both need (connect, and
// replace a token / change the base URL).
import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { LucideDynamicIcon, LucideEye, LucideEyeOff } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import type { CreateIntegrationInput } from '../../../core/api/api.types';
import type { ConnectionStatus, IntegrationConnection } from '../../../core/contracts/domain';
import { ProviderIcon } from '../../../shared/provider-icon';
import { SECTION_KIT } from './section-kit';

export type ConnProvider = IntegrationConnection['provider'];

export const PROVIDER_INFO: Record<ConnProvider, { label: string; blurb: string; base: string; baseHint: string; scopes: string }> = {
  github: {
    label: 'GitHub',
    blurb: 'Pull requests, reviews and CI',
    base: 'https://github.example.com',
    baseHint: 'Only for GitHub Enterprise Server. Leave empty for github.com.',
    scopes: 'Fine-grained token with Metadata and Pull requests (read) on the repositories, or a classic token with repo.',
  },
  gitlab: {
    label: 'GitLab',
    blurb: 'Merge requests and pipelines',
    base: 'https://gitlab.example.com',
    baseHint: 'Only for self-hosted GitLab. Leave empty for gitlab.com.',
    scopes: 'Personal or project access token with read_api.',
  },
  bitbucket: {
    label: 'Bitbucket',
    blurb: 'Pull requests and build statuses (Cloud)',
    base: '',
    baseHint: '',
    scopes:
      'An Atlassian API token as email:token (scopes read:user, read:repository and read:pullrequest), or a repository or workspace access token.',
  },
  delta: {
    label: 'Delta',
    blurb: 'Agent threads and sessions',
    base: 'https://delta.example.com',
    baseHint: 'Required: the address of your Delta instance.',
    scopes: 'A Delta API token. Stored encrypted; Delta connections are not validated yet.',
  },
};

/**
 * What can be connected. A choice is a provider, optionally preset to a self-hosted instance
 * (GitHub Enterprise Server, self-hosted GitLab), where the base URL becomes required.
 */
export interface Choice {
  id: string;
  provider: ConnProvider;
  label: string;
  blurb: string;
  /** The connection must point at your own instance. */
  selfHosted?: boolean;
}

export const CHOICES: readonly Choice[] = [
  { id: 'github', provider: 'github', label: 'GitHub', blurb: PROVIDER_INFO.github.blurb },
  { id: 'github-enterprise', provider: 'github', label: 'GitHub Enterprise', blurb: 'Self-hosted GitHub Enterprise Server', selfHosted: true },
  { id: 'gitlab', provider: 'gitlab', label: 'GitLab', blurb: PROVIDER_INFO.gitlab.blurb },
  { id: 'gitlab-self-hosted', provider: 'gitlab', label: 'GitLab Self-Hosted', blurb: 'Your own GitLab instance', selfHosted: true },
  { id: 'bitbucket', provider: 'bitbucket', label: 'Bitbucket', blurb: PROVIDER_INFO.bitbucket.blurb },
  { id: 'delta', provider: 'delta', label: 'Delta', blurb: PROVIDER_INFO.delta.blurb },
];

export function statusLabel(s: ConnectionStatus): string {
  return s === 'connected' ? 'Connected' : s === 'error' ? 'Error' : 'Revoked';
}

/** Tailwind class of the 6px status square. */
export function statusDot(s: ConnectionStatus): string {
  return s === 'connected' ? 'bg-green' : 'bg-red';
}

/** Connections that need someone's attention: failing, or revoked. */
export function needsAttention(c: Pick<IntegrationConnection, 'status'>): boolean {
  return c.status !== 'connected';
}

/** `gitlab.acme.dev · @login`, the second line of a connection. */
export function accountLine(c: Pick<IntegrationConnection, 'host' | 'account' | 'provider'>): string {
  return c.provider === 'delta' ? c.host : `${c.host} · @${c.account}`;
}

const tokenPlaceholder = (provider: ConnProvider): string => {
  switch (provider) {
    case 'gitlab':
      return 'glpat-…';
    case 'github':
      return 'github_pat_… or ghp_…';
    case 'bitbucket':
      return 'email:api-token or an access token';
    default:
      return 'Token';
  }
};

/**
 * Connect an account: pick a provider, paste a token, optionally name it. The token is checked against
 * the provider by the server; it is never shown again.
 */
@Component({
  selector: 'app-connection-add-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, HlmSpinner, LucideDynamicIcon, ProviderIcon, ...SECTION_KIT],
  host: { class: 'block' },
  template: `
    <form (submit)="submit($event)" class="flex max-w-[720px] flex-col gap-4">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Provider">
        @for (p of choices; track p.id) {
          <button
            type="button"
            role="radio"
            class="hover:bg-hover flex items-center gap-2.5 border px-3 py-2.5 text-left transition-colors"
            [class]="choice().id === p.id ? 'bg-selected border-border-strong' : 'bg-secondary border-border'"
            [attr.aria-checked]="choice().id === p.id"
            (click)="choose(p)"
          >
            <app-provider-icon [provider]="p.provider" [size]="18" />
            <span class="min-w-0">
              <span class="text-foreground block text-[13px]">{{ p.label }}</span>
              <span class="text-faint block truncate font-mono text-[10px]">{{ p.blurb }}</span>
            </span>
          </button>
        }
      </div>
      <app-settings-group>
        <app-settings-row
          label="Name"
          description="Shown in lists and when you pick a connection. Optional: it defaults to the provider and the account."
          wide
        >
          <input hlmInput class="h-8 w-full text-[13px]" maxlength="80" [placeholder]="namePlaceholder()" [value]="name()" (input)="name.set($any($event.target).value)" aria-label="Name" />
        </app-settings-row>
        <app-settings-row label="Access token" [description]="info[provider()].scopes" wide>
          <div class="relative">
            <input
              hlmInput
              class="h-8 w-full pr-9 font-mono text-xs"
              [type]="showToken() ? 'text' : 'password'"
              autocomplete="off"
              spellcheck="false"
              [placeholder]="placeholder()"
              [value]="token()"
              (input)="token.set($any($event.target).value)"
              aria-label="Access token"
            />
            <button type="button" class="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2" [attr.aria-label]="showToken() ? 'Hide token' : 'Show token'" (click)="showToken.set(!showToken())">
              <svg [lucideIcon]="showToken() ? eyeOff : eye" [size]="14"></svg>
            </button>
          </div>
        </app-settings-row>
        @if (provider() !== 'bitbucket') {
          <app-settings-row [label]="provider() === 'delta' ? 'Delta URL' : 'Base URL'" [description]="baseHint()" wide>
            <input hlmInput class="h-8 w-full font-mono text-xs" type="url" [placeholder]="info[provider()].base" [value]="baseUrl()" (input)="baseUrl.set($any($event.target).value)" aria-label="Base URL" />
          </app-settings-row>
        }
      </app-settings-group>
      <div class="flex items-center justify-end gap-2">
        <button hlmBtn type="button" variant="ghost" (click)="cancelled.emit()">Cancel</button>
        <button hlmBtn type="submit" [disabled]="!canSubmit() || busy()">
          @if (busy()) {
            <hlm-spinner class="size-3.5" />
          }
          {{ busy() ? 'Checking token…' : 'Connect ' + choice().label }}
        </button>
      </div>
    </form>
  `,
})
export class ConnectionAddForm {
  /** Id of the `CHOICES` entry to start on. */
  readonly preset = input<string | null>(null);
  /** Word in the name hint: "GitHub · personal" or "GitHub · workspace". */
  readonly scopeWord = input('personal');
  readonly busy = input(false);
  readonly submitted = output<CreateIntegrationInput>();
  readonly cancelled = output<void>();

  protected readonly info = PROVIDER_INFO;
  protected readonly choices = CHOICES;
  protected readonly eye = LucideEye;
  protected readonly eyeOff = LucideEyeOff;

  protected readonly choice = linkedSignal<Choice>(() => CHOICES.find((c) => c.id === this.preset()) ?? CHOICES[0]);
  protected readonly provider = computed(() => this.choice().provider);
  protected readonly token = signal('');
  protected readonly baseUrl = signal('');
  protected readonly name = signal('');
  protected readonly showToken = signal(false);

  protected readonly baseRequired = computed(() => this.provider() === 'delta' || !!this.choice().selfHosted);
  protected readonly canSubmit = computed(() => !!this.token().trim() && (!this.baseRequired() || !!this.baseUrl().trim()));
  protected readonly baseHint = computed(() =>
    this.baseRequired() ? `Required: the address of your ${this.choice().label.replace(/ Self-Hosted$/, '')} instance.` : PROVIDER_INFO[this.provider()].baseHint,
  );
  protected readonly placeholder = computed(() => tokenPlaceholder(this.provider()));
  protected readonly namePlaceholder = computed(() => `${PROVIDER_INFO[this.provider()].label} · ${this.scopeWord()}`);

  protected choose(c: Choice): void {
    this.choice.set(c);
    this.baseUrl.set('');
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.canSubmit() || this.busy()) return;
    const name = this.name().trim();
    this.submitted.emit({
      provider: this.provider(),
      token: this.token().trim(),
      baseUrl: this.baseUrl().trim() || undefined,
      ...(name ? { label: name } : {}),
    });
  }
}

/** Replace a connection's token (and base URL). A revoked connection needs a new token to come back. */
@Component({
  selector: 'app-connection-token-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, ...SECTION_KIT],
  host: { class: 'block max-w-[720px]' },
  template: `
    <form (submit)="submit($event)">
      <app-settings-group>
        <app-settings-row label="New token" description="Checked against the provider before it replaces the old one." wide>
          <input
            hlmInput
            type="password"
            autocomplete="off"
            class="h-8 w-full font-mono text-xs"
            [placeholder]="tokenRequired() ? 'Paste a new token' : 'Leave empty to keep the current token'"
            [value]="token()"
            (input)="token.set($any($event.target).value)"
            aria-label="New token"
          />
        </app-settings-row>
        @if (provider() !== 'bitbucket') {
          <app-settings-row [label]="provider() === 'delta' ? 'Delta URL' : 'Base URL'" [description]="info[provider()].baseHint" wide>
            <input hlmInput type="url" class="h-8 w-full font-mono text-xs" [placeholder]="info[provider()].base" [value]="baseUrl()" (input)="baseUrl.set($any($event.target).value)" aria-label="Base URL" />
          </app-settings-row>
        }
        <div class="flex items-center justify-end gap-2 px-4 py-2">
          <button hlmBtn type="button" variant="ghost" (click)="cancelled.emit()">Cancel</button>
          <button hlmBtn type="submit" [disabled]="busy() || !valid()">Save and re-validate</button>
        </div>
      </app-settings-group>
    </form>
  `,
})
export class ConnectionTokenForm {
  readonly provider = input.required<ConnProvider>();
  /** The current base URL, to start from. */
  readonly currentBase = input<string | null>(null);
  readonly tokenRequired = input(false);
  readonly busy = input(false);
  readonly saved = output<{ token?: string; baseUrl: string | null }>();
  readonly cancelled = output<void>();

  protected readonly info = PROVIDER_INFO;
  protected readonly token = signal('');
  protected readonly baseUrl = linkedSignal(() => this.currentBase() ?? '');
  protected readonly valid = computed(
    () => (!this.tokenRequired() || !!this.token().trim()) && (this.provider() !== 'delta' || !!this.baseUrl().trim()),
  );

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.valid() || this.busy()) return;
    const token = this.token().trim();
    this.saved.emit({ ...(token ? { token } : {}), baseUrl: this.baseUrl().trim() || null });
  }
}
