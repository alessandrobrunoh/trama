// "Add source" (v4 "App · 13 Project · Sources"): an inline panel under the rules. A provider and a source
// path (with the repositories the chosen connection can see), optional filters, the connection to read
// through and whether closing a task also closes the external issue. The same panel edits a rule: its
// source stays fixed, everything else can change.
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
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucidePlus, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type {
  GitProvider,
  ID,
  RoutingConnectionOption,
  RoutingDirection,
  RoutingFilters,
  RoutingRule,
  RoutingSourceSuggestion,
} from '../../../core/contracts/domain';
import { TramaStore } from '../../../core/stores/trama.store';
import { providerLabel } from '../../../shared/provider-icon';
import { V3_FIELD } from '../../../shared/v3';
import { ProjectSourcesStore } from './project-sources.store';
import {
  addFilterTerm,
  filterTerms,
  filterText,
  parseFilterTerm,
  removeFilterTerm,
  sourceProviders,
  suggestionNote,
  suggestionPickable,
  supportsTwoWay,
  type FilterTerm,
} from './source-model';

const SUGGESTION_DELAY_MS = 220;
const SUGGESTIONS_SHOWN = 8;

@Component({
  selector: 'app-source-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon, RouterLink],
  host: { class: 'block' },
  template: `
    <section
      class="bg-background border-primary/40 flex flex-col gap-4 border p-[18px]"
      [attr.aria-label]="editing() ? 'Edit source' : 'Add source'"
    >
      <header class="flex items-center gap-2">
        <svg [lucideIcon]="plusIcon" [size]="14" class="text-muted-foreground"></svg>
        <h3 class="text-foreground m-0 text-sm font-medium">{{ editing() ? 'Edit source' : 'Add source' }}</h3>
        <span class="flex-1"></span>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground inline-flex size-6 items-center justify-center"
          aria-label="Close"
          (click)="closed.emit()"
        >
          <svg [lucideIcon]="closeIcon" [size]="14"></svg>
        </button>
      </header>

      <div class="flex gap-5 max-md:flex-col">
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <label for="source-path" class="text-muted-foreground font-mono text-[10.5px] leading-[14px]">SOURCE</label>
          <div class="flex gap-2">
            <select
              class="{{ field }} w-[130px] shrink-0 disabled:opacity-60"
              aria-label="Provider"
              [disabled]="editing()"
              [value]="provider()"
              (change)="setProvider($any($event.target).value)"
            >
              @for (p of providers; track p) {
                <option [value]="p" [selected]="p === provider()">{{ label(p) }}</option>
              }
            </select>
            <input
              id="source-path"
              class="{{ field }} font-mono disabled:opacity-60"
              autocomplete="off"
              spellcheck="false"
              [placeholder]="provider() === 'gitlab' ? 'group/project or group/*' : 'owner/repo or owner/*'"
              [disabled]="editing()"
              [value]="path()"
              (input)="path.set($any($event.target).value)"
              (keydown.enter)="$event.preventDefault(); submit()"
            />
          </div>

          @if (!editing()) {
            @if (suggestions().length) {
              <ul class="bg-card border-border m-0 flex list-none flex-col border p-0" aria-label="Sources you can add">
                @for (s of suggestions(); track s.sourcePath) {
                  <li>
                    <button
                      type="button"
                      class="hover:bg-secondary flex w-full items-center gap-2 px-2.5 py-[7px] text-left disabled:cursor-default disabled:hover:bg-transparent"
                      [disabled]="!pickable(s)"
                      (click)="pick(s)"
                    >
                      <span class="text-foreground min-w-0 truncate font-mono text-xs" [class.text-muted-foreground]="!pickable(s)">{{ s.sourcePath }}</span>
                      <span class="flex-1"></span>
                      <span
                        class="shrink-0 font-mono text-[10px]"
                        [class]="s.status === 'this_project' ? 'text-primary' : 'text-faint'"
                      >{{ note(s) }}</span>
                    </button>
                  </li>
                }
              </ul>
            } @else if (suggestionsError()) {
              <p class="text-faint m-0 font-mono text-[10.5px]">{{ suggestionsError() }}</p>
            } @else if (connectionId() && !loadingSuggestions()) {
              <p class="text-faint m-0 font-mono text-[10.5px]">
                Type a repository, <span class="text-muted-foreground">owner/name</span>, or a whole group, <span class="text-muted-foreground">owner/*</span>.
              </p>
            }
          } @else {
            <p class="text-faint m-0 font-mono text-[10.5px]">The source can't change. Remove the rule and add another.</p>
          }

          <span class="text-muted-foreground mt-2 font-mono text-[10.5px] leading-[14px]">FILTERS · OPTIONAL</span>
          <div class="flex flex-wrap items-center gap-1.5">
            @for (t of terms(); track filterText(t)) {
              <span class="bg-secondary border-border text-text-2 inline-flex items-center gap-1.5 border py-0.5 pr-1 pl-[7px] font-mono text-[11px]">
                {{ chipText(t) }}
                <button
                  type="button"
                  class="text-faint hover:text-foreground inline-flex"
                  [attr.aria-label]="'Remove filter ' + chipText(t)"
                  (click)="removeFilter(t)"
                >
                  <svg [lucideIcon]="closeIcon" [size]="11"></svg>
                </button>
              </span>
            }
            <input
              class="bg-background border-border text-foreground placeholder:text-faint focus-visible:border-primary w-[240px] max-w-full border px-2.5 py-[7px] font-mono text-xs outline-none"
              aria-label="Add a filter"
              placeholder="label = frontend"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="$event.preventDefault(); commitFilter()"
              (blur)="commitFilter()"
            />
          </div>
          <p class="text-faint m-0 font-mono text-[10.5px]">Every filter must match. <span class="text-muted-foreground">label = x</span> or <span class="text-muted-foreground">milestone = x</span>.</p>
        </div>

        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <span class="text-muted-foreground font-mono text-[10.5px] leading-[14px]">THROUGH</span>
          @for (c of connections(); track c.id) {
            <button
              type="button"
              role="radio"
              class="flex w-full items-start gap-2.5 border px-3 py-[9px] text-left disabled:cursor-not-allowed disabled:opacity-60"
              [class]="connectionId() === c.id ? 'bg-primary/10 border-primary/40' : 'border-border hover:bg-secondary/50'"
              [attr.aria-checked]="connectionId() === c.id"
              [disabled]="!c.healthy"
              (click)="connectionId.set(c.id)"
            >
              <span
                class="bg-background mt-px flex size-4 shrink-0 items-center justify-center border"
                [class]="connectionId() === c.id ? 'border-primary' : 'border-strong'"
                aria-hidden="true"
              >
                @if (connectionId() === c.id) {
                  <span class="bg-primary size-2"></span>
                }
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="flex items-center gap-2">
                  <span class="text-foreground truncate text-[13px]">{{ c.label }}</span>
                  @if (c.suggested) {
                    <span class="bg-primary/10 border-primary/40 text-foreground border px-[7px] py-0.5 font-mono text-[11px]">suggested</span>
                  }
                </span>
                <span class="text-muted-foreground text-[11.5px]">{{ connectionNote(c) }}</span>
              </span>
            </button>
          } @empty {
            @if (loadingConnections()) {
              <p class="text-faint m-0 font-mono text-[11px]">Loading connections…</p>
            } @else {
              <p class="text-muted-foreground m-0 text-[12px] leading-[18px]">
                No {{ label(provider()) }} connection you can read through here.
                <a class="text-primary underline-offset-2 hover:underline" [routerLink]="['/', slug(), 'settings', 'my-integrations']">Connect your account</a>
                or ask an admin to connect one for the workspace.
              </p>
            }
          }

          <span class="text-muted-foreground mt-2 font-mono text-[10.5px] leading-[14px]">SYNC</span>
          <div class="bg-background border-border flex w-fit gap-0.5 border p-0.5" role="radiogroup" aria-label="Sync direction">
            <button
              type="button"
              role="radio"
              class="px-2.5 py-1 font-mono text-[11.5px]"
              [class]="direction() === 'inbound' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'"
              [attr.aria-checked]="direction() === 'inbound'"
              (click)="direction.set('inbound')"
            >
              Inbound
            </button>
            <button
              type="button"
              role="radio"
              class="px-2.5 py-1 font-mono text-[11.5px] disabled:cursor-not-allowed disabled:opacity-50"
              [class]="direction() === 'two_way' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'"
              [attr.aria-checked]="direction() === 'two_way'"
              [disabled]="!twoWay()"
              [title]="twoWay() ? '' : label(provider()) + ' cannot close issues from here yet'"
              (click)="direction.set('two_way')"
            >
              Two-way
            </button>
          </div>
          <p class="text-faint m-0 font-mono text-[10.5px]">
            @if (twoWay()) {
              Two-way also closes the {{ label(provider()) }} issue when the task is done.
            } @else {
              Two-way isn't supported for {{ label(provider()) }} yet: only inbound.
            }
          </p>
        </div>
      </div>

      @if (error()) {
        <p class="text-destructive m-0 font-mono text-[11px] leading-4" role="alert">{{ error() }}</p>
      }

      <footer class="flex flex-wrap items-center gap-2">
        <span class="text-faint min-w-0 flex-1 font-mono text-[10.5px]">
          One source, one project: a source that already routes somewhere can't be added twice.
        </span>
        <button hlmBtn variant="outline" type="button" (click)="closed.emit()">Cancel</button>
        <button hlmBtn type="button" [disabled]="!canSubmit()" (click)="submit()">
          {{ busy() ? 'Saving…' : editing() ? 'Save source' : 'Add source' }}
        </button>
      </footer>
    </section>
  `,
})
export class SourcePanel {
  readonly projectId = input.required<ID>();
  /** A rule to change; none adds a source. */
  readonly rule = input<RoutingRule | null>(null);
  readonly closed = output<void>();

  private readonly store = inject(ProjectSourcesStore);
  private readonly trama = inject(TramaStore);

  protected readonly field = V3_FIELD;
  protected readonly plusIcon = LucidePlus;
  protected readonly closeIcon = LucideX;
  protected readonly providers = sourceProviders();
  protected readonly filterText = filterText;

  protected readonly slug = computed(() => this.trama.slug() ?? '');
  protected readonly editing = computed(() => !!this.rule());

  protected readonly provider = signal<GitProvider>('github');
  protected readonly path = signal('');
  protected readonly filters = signal<RoutingFilters>({});
  protected readonly draft = signal('');
  protected readonly connectionId = signal<ID | null>(null);
  protected readonly direction = signal<RoutingDirection>('inbound');

  protected readonly connections = signal<readonly RoutingConnectionOption[]>([]);
  protected readonly loadingConnections = signal(true);
  protected readonly suggestions = signal<readonly RoutingSourceSuggestion[]>([]);
  protected readonly suggestionsError = signal('');
  protected readonly loadingSuggestions = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly terms = computed(() => filterTerms(this.filters()));
  protected readonly twoWay = computed(() => supportsTwoWay(this.provider()));
  protected readonly canSubmit = computed(
    () => !this.busy() && !!this.connectionId() && (this.editing() || this.path().trim().length > 0),
  );

  /** Takes the rule's values when editing; runs once, when the panel opens. */
  private readonly _init = effect(() => {
    const rule = this.rule();
    if (!rule) return;
    untracked(() => {
      this.provider.set(rule.provider);
      this.path.set(rule.sourcePath);
      this.filters.set({ ...rule.filters });
      this.direction.set(rule.direction);
      this.connectionId.set(rule.connectionId ?? null);
    });
  });

  /** The connections for the provider, with the suggested one picked unless there is a choice already. */
  private readonly _connections = effect(() => {
    const provider = this.provider();
    const projectId = this.projectId();
    untracked(() => void this.loadConnections(projectId, provider));
  });

  /** Repositories the connection can see, matching what has been typed. */
  private readonly _suggestions = effect((onCleanup) => {
    const provider = this.provider();
    const projectId = this.projectId();
    const connectionId = this.connectionId();
    const q = this.path().trim();
    if (untracked(() => this.editing()) || !connectionId) {
      untracked(() => this.suggestions.set([]));
      return;
    }
    const timer = setTimeout(() => void this.loadSuggestions(projectId, provider, connectionId, q), SUGGESTION_DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  });

  protected label(p: GitProvider): string {
    return providerLabel(p);
  }

  protected chipText(t: FilterTerm): string {
    return filterText(t);
  }

  protected note(s: RoutingSourceSuggestion): string {
    return suggestionNote(s.status, s.projectName);
  }

  protected pickable(s: RoutingSourceSuggestion): boolean {
    return suggestionPickable(s.status);
  }

  protected connectionNote(c: RoutingConnectionOption): string {
    if (!c.healthy) return 'Needs attention: reconnect it in settings first';
    if (c.ownerType === 'workspace') return 'Workspace · keeps working if you leave';
    return c.mine
      ? `Yours · others see "via ${c.label}"`
      : `${c.ownerName ?? 'Someone'}'s · stops if they leave`;
  }

  protected setProvider(value: string): void {
    const provider = value as GitProvider;
    if (provider === this.provider()) return;
    this.provider.set(provider);
    this.connectionId.set(null);
    this.suggestions.set([]);
    if (!supportsTwoWay(provider)) this.direction.set('inbound');
  }

  protected pick(s: RoutingSourceSuggestion): void {
    if (suggestionPickable(s.status)) this.path.set(s.sourcePath);
  }

  protected commitFilter(): void {
    const text = this.draft();
    if (!text.trim()) return;
    const term = parseFilterTerm(text);
    if (term) this.filters.update((f) => addFilterTerm(f, term));
    this.draft.set('');
  }

  protected removeFilter(term: FilterTerm): void {
    this.filters.update((f) => removeFilterTerm(f, term));
  }

  protected async submit(): Promise<void> {
    this.commitFilter();
    const connectionId = this.connectionId();
    if (!this.canSubmit() || !connectionId) return;
    this.busy.set(true);
    this.error.set('');
    const rule = this.rule();
    const projectId = this.projectId();
    const result = rule
      ? await this.store.update(projectId, rule.id, {
          connectionId,
          filters: this.filters(),
          direction: this.direction(),
        })
      : await this.store.create(projectId, {
          provider: this.provider(),
          sourcePath: this.path().trim(),
          connectionId,
          filters: this.filters(),
          direction: this.direction(),
        });
    this.busy.set(false);
    if (result.ok) this.closed.emit();
    else this.error.set(result.message);
  }

  private async loadConnections(projectId: ID, provider: GitProvider): Promise<void> {
    this.loadingConnections.set(true);
    const list = await this.store.connections(projectId, provider);
    if (this.provider() !== provider) return;
    this.connections.set(list);
    this.loadingConnections.set(false);
    const current = this.connectionId();
    if (current && list.some((c) => c.id === current)) return;
    // an edited rule whose connection is gone has none; a new one starts on the suggested connection
    const next = list.find((c) => c.suggested && c.healthy) ?? list.find((c) => c.healthy);
    this.connectionId.set(next?.id ?? null);
  }

  private async loadSuggestions(projectId: ID, provider: GitProvider, connectionId: ID, q: string): Promise<void> {
    this.loadingSuggestions.set(true);
    const res = await this.store.suggestions(projectId, provider, connectionId, q);
    if (this.provider() !== provider || this.connectionId() !== connectionId || this.path().trim() !== q) return;
    this.loadingSuggestions.set(false);
    this.suggestionsError.set(res.error ?? '');
    this.suggestions.set(res.items.slice(0, SUGGESTIONS_SHOWN));
  }
}
