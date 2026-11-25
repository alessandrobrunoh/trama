import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideDynamicIcon, LucideLink2, LucideListTodo, LucidePlus, LucideSquareKanban, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { ApiClient } from '../../../core/api/api-client';
import { ApiError } from '../../../core/api/api-error';
import {
  EXTERNAL_IDENTITY_PROVIDERS,
  EXTERNAL_IDENTITY_PROVIDER_META,
  normalizeIdentityHost,
  normalizeIdentityLogin,
  type ExternalIdentity,
  type ExternalIdentityProvider,
} from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { Picker, type PickOption } from '../../../shared/picker';
import { ProviderIcon } from '../../../shared/provider-icon';
import { V3_FIELD, V3Field } from '../../../shared/v3';
import { SettingsGroup } from './section-kit';

const PROVIDER_OPTIONS: PickOption[] = EXTERNAL_IDENTITY_PROVIDERS.map((value) => ({
  value,
  label: EXTERNAL_IDENTITY_PROVIDER_META[value].label,
}));

/** Column layout shared by the header and the rows (wide screens). */
const COLUMNS = 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1.2fr)]';

/**
 * The logins the signed-in person has in other tools (settings · Integrations · Personal, "External
 * identities"). Every one of them counts as them: issues assigned to it, reviews requested from it and
 * its activity show up in My tasks and Inbox. Rows come from personal connections (`from a connection`)
 * or are added by hand; the server refuses a login another person already has (409).
 * The list belongs to the account, not to a workspace.
 *   <app-external-identities />
 */
@Component({
  selector: 'app-external-identities',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, LucideDynamicIcon, Picker, ProviderIcon, V3Field, SettingsGroup],
  host: { class: 'block' },
  template: `
    <app-settings-group
      title="External identities"
      [caption]="items() ? '' + items()!.length : ''"
      description="All the logins that are you. Issues assigned to any of them, reviews requested from them, and their activity show up in My tasks and Inbox."
    >
      <button aside type="button" hlmBtn variant="outline" size="sm" [attr.aria-expanded]="adding()" (click)="toggleForm()">
        <svg [lucideIcon]="plusIcon" [size]="13"></svg>
        Add identity
      </button>

      @if (adding()) {
        <form class="border-border grid gap-3 border-b px-1 py-3.5 sm:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" (submit)="submit($event)">
          <v3-field label="PROVIDER">
            <app-picker
              variant="input"
              label="Provider"
              [searchable]="false"
              [options]="providerOptions"
              [value]="[provider()]"
              (valueChange)="setProvider($event[0])"
            />
          </v3-field>
          <v3-field label="HOST" for="xid-host">
            <input
              id="xid-host"
              hlmInput
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              [class]="fieldClass + ' font-mono'"
              [placeholder]="hostPlaceholder()"
              [value]="host()"
              (input)="host.set($any($event.target).value)"
            />
          </v3-field>
          <v3-field label="LOGIN" for="xid-login">
            <input
              id="xid-login"
              hlmInput
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              [class]="fieldClass + ' font-mono'"
              placeholder="your login"
              [value]="login()"
              (input)="login.set($any($event.target).value)"
            />
          </v3-field>
          <div class="flex items-center gap-2">
            <button type="submit" hlmBtn [disabled]="!canSubmit() || busy()">Add</button>
            <button type="button" hlmBtn variant="ghost" (click)="closeForm()">Cancel</button>
          </div>
          @if (formError()) {
            <p class="text-red font-mono text-[11.5px] leading-snug sm:col-span-full" role="alert">{{ formError() }}</p>
          }
        </form>
      }

      @if (items(); as list) {
        @if (list.length) {
          <div class="border-border mt-4 border">
            <div class="text-faint border-border bg-bg-deep hidden gap-x-3 border-b py-2.5 pr-[52px] pl-3 font-mono text-[10.5px] leading-none sm:grid" [class]="columns" aria-hidden="true">
              <span>PROVIDER</span><span>HOST</span><span>LOGIN</span><span>ADDED</span>
            </div>
            <ul>
              @for (item of list; track item.id) {
                <li class="border-border flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
                  <div class="grid min-w-0 flex-1 grid-cols-2 items-center gap-x-3 gap-y-1" [class]="columns">
                    <span class="text-foreground flex min-w-0 items-center gap-2 text-[13px]">
                      @switch (item.provider) {
                        @case ('github') { <app-provider-icon provider="github" [size]="14" /> }
                        @case ('gitlab') { <app-provider-icon provider="gitlab" [size]="14" /> }
                        @case ('bitbucket') { <app-provider-icon provider="bitbucket" [size]="14" /> }
                        @case ('linear') { <svg [lucideIcon]="linearIcon" [size]="14" aria-hidden="true"></svg> }
                        @default { <svg [lucideIcon]="jiraIcon" [size]="14" aria-hidden="true"></svg> }
                      }
                      <span class="truncate">{{ providerLabel(item.provider) }}</span>
                    </span>
                    <span class="text-muted-foreground min-w-0 truncate font-mono text-[11.5px]">{{ item.host }}</span>
                    <span class="text-foreground min-w-0 truncate font-mono text-[12.5px]">{{ item.login }}</span>
                    <span class="text-faint flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]">
                      @if (item.source === 'connection') {
                        <svg [lucideIcon]="linkIcon" [size]="12" aria-hidden="true"></svg>
                        <span class="truncate">from a connection</span>
                      } @else {
                        <span class="truncate">by hand</span>
                      }
                    </span>
                  </div>
                  <button
                    type="button"
                    hlmBtn
                    variant="ghost"
                    size="icon-sm"
                    class="text-faint hover:text-foreground size-7 shrink-0"
                    [attr.aria-label]="'Remove ' + providerLabel(item.provider) + ' login ' + item.login"
                    title="Remove"
                    [disabled]="removing() === item.id"
                    (click)="remove(item)"
                  >
                    <svg [lucideIcon]="removeIcon" [size]="14"></svg>
                  </button>
                </li>
              }
            </ul>
          </div>
        } @else {
          <p class="text-muted-foreground border-border border-b px-1 py-4 text-[12.5px] leading-snug">
            No logins yet. They are added when you connect an account of your own, or you can add one by hand.
          </p>
        }
      } @else if (loadError()) {
        <div class="border-border flex flex-wrap items-center gap-3 border-b px-1 py-4">
          <p class="text-red font-mono text-[11.5px]" role="alert">{{ loadError() }}</p>
          <button type="button" hlmBtn variant="outline" size="sm" (click)="load()">Try again</button>
        </div>
      } @else {
        <p class="text-faint border-border border-b px-1 py-4 font-mono text-[11.5px]" aria-live="polite">Loading…</p>
      }
    </app-settings-group>
  `,
})
export class ExternalIdentitiesSection {
  private readonly api = inject(ApiClient);
  private readonly notifier = inject(Notifier);

  /** `null` until the first answer. */
  protected readonly items = signal<ExternalIdentity[] | null>(null);
  protected readonly loadError = signal('');
  protected readonly removing = signal('');

  protected readonly adding = signal(false);
  protected readonly provider = signal<ExternalIdentityProvider>('github');
  protected readonly host = signal('');
  protected readonly login = signal('');
  protected readonly busy = signal(false);
  protected readonly formError = signal('');

  protected readonly providerOptions = PROVIDER_OPTIONS;
  protected readonly fieldClass = V3_FIELD;
  protected readonly columns = COLUMNS;
  protected readonly plusIcon = LucidePlus;
  protected readonly removeIcon = LucideX;
  protected readonly linkIcon = LucideLink2;
  protected readonly linearIcon = LucideListTodo;
  protected readonly jiraIcon = LucideSquareKanban;

  /** What an empty host means: the provider's public host, or a hint when it has none (Jira). */
  protected readonly hostPlaceholder = computed(
    () => EXTERNAL_IDENTITY_PROVIDER_META[this.provider()].defaultHost ?? 'your-site.atlassian.net',
  );
  protected readonly canSubmit = computed(
    () =>
      this.login().trim().length > 0 &&
      (this.host().trim().length > 0 || !!EXTERNAL_IDENTITY_PROVIDER_META[this.provider()].defaultHost),
  );

  constructor() {
    void this.load();
  }

  protected providerLabel(provider: ExternalIdentityProvider): string {
    return EXTERNAL_IDENTITY_PROVIDER_META[provider].label;
  }

  protected async load(): Promise<void> {
    this.loadError.set('');
    try {
      this.items.set(await this.api.externalIdentities.list());
    } catch (e) {
      this.loadError.set(ApiError.from(e).message || 'Could not load your external identities.');
    }
  }

  protected toggleForm(): void {
    if (this.adding()) this.closeForm();
    else this.adding.set(true);
  }

  protected closeForm(): void {
    this.adding.set(false);
    this.host.set('');
    this.login.set('');
    this.formError.set('');
  }

  protected setProvider(value: string | undefined): void {
    if (value && (EXTERNAL_IDENTITY_PROVIDERS as string[]).includes(value)) {
      this.provider.set(value as ExternalIdentityProvider);
      this.formError.set('');
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const provider = this.provider();
    const rawHost = this.host().trim();
    const login = normalizeIdentityLogin(this.login());
    if (!login) {
      this.formError.set('Enter the login exactly as the tool spells it, without spaces.');
      return;
    }
    if (rawHost ? !normalizeIdentityHost(rawHost) : !EXTERNAL_IDENTITY_PROVIDER_META[provider].defaultHost) {
      this.formError.set(rawHost ? 'That is not a valid host name.' : 'Enter the host of the site, for example acme.atlassian.net.');
      return;
    }
    this.busy.set(true);
    this.formError.set('');
    try {
      const created = await this.api.externalIdentities.add({ provider, host: rawHost || undefined, login });
      this.items.update((list) => [...(list ?? []), created]);
      this.closeForm();
      this.notifier.success('Identity added', { description: `${this.providerLabel(provider)} · ${created.login}` });
    } catch (e) {
      // 409: this login is already yours, or belongs to another account. The server says which.
      this.formError.set(ApiError.from(e).message || 'Could not add the identity.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(item: ExternalIdentity): Promise<void> {
    if (this.removing()) return;
    this.removing.set(item.id);
    try {
      await this.api.externalIdentities.remove(item.id);
      this.items.update((list) => (list ?? []).filter((x) => x.id !== item.id));
    } catch (e) {
      const err = ApiError.from(e);
      if (err.isNotFound) this.items.update((list) => (list ?? []).filter((x) => x.id !== item.id));
      else this.notifier.error('Could not remove the identity', { description: err.message });
    } finally {
      this.removing.set('');
    }
  }
}
