// Estimate picker dialog (v3 · 27): the workspace's scale as a row of cells, picked with the mouse or the
// number / letter keys, applied with "Set estimate N" (⌘↵). Opened by `e` and the bulk actions through
// `IssueActions.openPrompt('estimate', ids)`; mounted by `IssueCommandDialog`.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmKbd } from '@spartan-ng/helm/kbd';
import {
  ESTIMATE_SCALE_DEFS,
  TramaStore,
  formatEstimate,
  formatPoints,
} from '../../core';
import { Kbd } from '../../shared/kbd';
import { V3DialogFoot, V3DialogHead } from '../../shared/v3';
import { IssueActions } from './issue-actions';
import { issueEstimateOptions } from './issue-model';

interface Cell {
  /** '' = no estimate ("unknown"). */
  value: string;
  /** Big text: "5", "M", "?". */
  main: string;
  /** Small mono text under it. */
  sub: string;
  quickKey?: string;
  /** Large values are offered but dimmed: they should become subtasks. */
  split: boolean;
}

/** Values above this are dimmed ("split"). */
const SPLIT_ABOVE = 8;

@Component({
  selector: 'app-estimate-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDialogImports, HlmButtonImports, HlmKbd, Kbd, V3DialogHead, V3DialogFoot],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="actions.closePrompt()">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="gap-0 p-0 sm:-top-[8.5svh] sm:w-[680px] sm:max-w-[680px]"
        [showCloseButton]="false"
        (keydown)="onKey($event)"
      >
        <v3-dialog-head [kicker]="subject()" (dismiss)="actions.closePrompt()">
          <h2 hlmDialogTitle>Estimate</h2>
        </v3-dialog-head>
        <p hlmDialogDescription class="sr-only">
          Pick an estimate for {{ subject() }}. Number and letter keys pick a value; Ctrl or ⌘ and Enter set it.
        </p>
        <div class="flex flex-col gap-3.5 p-[18px]">
          @if (title(); as t) {
            <p class="text-text-2 truncate text-sm">{{ t }}</p>
          }
          <div class="flex gap-1.5" role="radiogroup" aria-label="Estimate">
            @for (c of cells(); track c.value) {
              <button
                type="button"
                role="radio"
                class="bg-background hover:border-border-strong flex min-w-0 flex-1 flex-col items-center gap-[3px] border py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                [class]="
                  selected() === c.value
                    ? 'border-red bg-red/10 shadow-[inset_0_0_0_1px_var(--red)]'
                    : 'border-border'
                "
                [class.opacity-45]="c.split && selected() !== c.value"
                [attr.aria-checked]="selected() === c.value"
                [attr.aria-label]="c.value === '' ? 'No estimate' : c.main + ' · ' + c.sub"
                (click)="selected.set(c.value)"
                (dblclick)="apply()"
              >
                <span class="font-title text-foreground text-[24px] leading-normal">{{ c.main }}</span>
                <span
                  class="font-mono text-[10px] leading-[13px]"
                  [class]="selected() === c.value ? 'text-foreground' : 'text-faint'"
                  >{{ c.sub }}</span
                >
              </button>
            }
          </div>
          <p class="text-faint font-mono text-[10px] leading-[13px]">{{ caption() }}</p>
        </div>
        <v3-dialog-foot [hint]="keysHint()">
          <button hlmBtn type="button" variant="outline" (click)="actions.closePrompt()">
            Cancel <kbd hlmKbd class="h-4">esc</kbd>
          </button>
          <button hlmBtn type="button" (click)="apply()">
            {{ applyLabel() }} <app-kbd keys="mod+enter" class="[&_kbd]:h-4" />
          </button>
        </v3-dialog-foot>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class EstimateDialog {
  protected readonly actions = inject(IssueActions);
  private readonly store = inject(TramaStore);

  private readonly prompt = computed(() => {
    const p = this.actions.prompt();
    return p?.field === 'estimate' ? p : null;
  });
  protected readonly open = computed(() => !!this.prompt());
  private readonly issues = computed(() => {
    const p = this.prompt();
    return p ? this.actions.issues(p.ids) : [];
  });
  protected readonly subject = computed(() => {
    const p = this.prompt();
    return p ? this.actions.subject(p.ids) : '';
  });
  protected readonly title = computed(() => {
    const list = this.issues();
    return list.length === 1 ? list[0].title : '';
  });

  /** The value every selected task already has ('' when none or when they differ). */
  private readonly current = computed(() => {
    const [first, ...rest] = this.issues();
    if (!first || first.estimate === undefined || first.estimate === null) return '';
    return rest.every((i) => i.estimate === first.estimate) ? String(first.estimate) : '';
  });
  protected readonly selected = linkedSignal<string>(() => this.current());

  private readonly scale = computed(() => this.store.estimateScale());
  protected readonly cells = computed<Cell[]>(() => {
    const scale = this.scale();
    const values = this.issues().map((i) => i.estimate);
    const first = values.find((v): v is number => v !== undefined && v !== null);
    const opts = issueEstimateOptions(first, scale).map((o): Cell => {
      const n = Number(o.value);
      const split = n > SPLIT_ABOVE;
      const label = formatEstimate(n, scale);
      return {
        value: o.value,
        main: label,
        sub: split ? 'split' : label === o.value ? (n === 1 ? 'point' : 'points') : formatPoints(n),
        quickKey: o.quickKey,
        split,
      };
    });
    return [...opts, { value: '', main: '?', sub: 'unknown', quickKey: '?', split: false }];
  });
  protected readonly caption = computed(() => {
    const name = ESTIMATE_SCALE_DEFS[this.scale()]?.name.toLowerCase() ?? '';
    return `${name} · values above ${SPLIT_ABOVE} should become subtasks`;
  });
  protected readonly keysHint = computed(() => {
    const keys = this.cells()
      .map((c) => c.quickKey)
      .filter((k): k is string => !!k && k !== '?');
    if (!keys.length) return '';
    return keys.length > 2 && keys.every((k) => /^\d$/.test(k))
      ? `${keys[0]}–${keys[keys.length - 1]} keys pick a value`
      : `${keys.join(' ').toUpperCase()} keys pick a value`;
  });
  protected readonly applyLabel = computed(() => {
    const c = this.cells().find((x) => x.value === this.selected());
    return c && c.value !== '' ? `Set estimate ${c.main}` : 'Clear estimate';
  });

  protected onKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      this.apply();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    const key = e.key.toLowerCase();
    const hit = this.cells().find((c) => c.quickKey === key);
    if (!hit) return;
    e.preventDefault();
    this.selected.set(hit.value);
  }

  protected apply(): void {
    const p = this.prompt();
    if (!p) return;
    const v = this.selected();
    this.actions.setEstimate(p.ids, v === '' ? null : Number(v));
    this.actions.closePrompt();
  }
}
