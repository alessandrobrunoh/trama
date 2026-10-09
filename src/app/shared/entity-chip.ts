import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TramaStore } from '../core/stores/trama.store';
import { StatusIcon, type AnyStatus, type StatusEntity } from './status';

export type EntityChipType = 'workstream' | 'issue' | 'decision';

/**
 * Compact, linkable reference to another entity: status glyph · key · title.
 * Workstreams draw a hexagon glyph, issues a circle — the same visual language used in every list,
 * so "this issue contributes to that outcome" reads at a glance.
 *   <app-entity-chip type="workstream" [ref]="ws.id" />
 *   <app-entity-chip type="issue" [ref]="'BUG-142'" compact />
 */
@Component({
  selector: 'app-entity-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, StatusIcon],
  host: { class: 'inline-flex min-w-0 max-w-full' },
  template: `
    @if (resolved(); as r) {
      <a
        [routerLink]="r.link"
        class="border-border-strong hover:bg-accent hover:border-foreground/20 inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 text-xs transition-colors"
        [attr.title]="r.key + ' · ' + r.title"
      >
        <app-status-icon [status]="r.status" [entity]="r.entity" [size]="12" />
        <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{ r.key }}</span>
        @if (!compact()) {
          <span class="min-w-0 truncate">{{ r.title }}</span>
        }
      </a>
    } @else {
      <span class="text-muted-foreground font-mono text-xs">{{ ref() }}</span>
    }
  `,
})
export class EntityChip {
  private readonly store = inject(TramaStore);
  readonly type = input.required<EntityChipType>();
  /** Id or key. */
  readonly ref = input.required<string>();
  /** Key only (no title). */
  readonly compact = input(false, { transform: booleanAttribute });

  protected readonly resolved = computed(() => {
    const slug = this.store.slug() ?? '';
    const ref = this.ref();
    switch (this.type()) {
      case 'workstream': {
        const w = this.store.getWorkstream(ref);
        return w
          ? { key: w.key, title: w.title, status: w.status as AnyStatus, entity: 'workstream' as StatusEntity, link: ['/', slug, 'workstreams', w.key] }
          : null;
      }
      case 'issue': {
        const i = this.store.getIssue(ref);
        return i
          ? { key: i.key, title: i.title, status: i.status as AnyStatus, entity: 'issue' as StatusEntity, link: ['/', slug, 'issues', i.key] }
          : null;
      }
      case 'decision': {
        const d = this.store.getDecision(ref);
        return d
          ? { key: d.key, title: d.title, status: d.status as AnyStatus, entity: 'other' as StatusEntity, link: ['/', slug, 'decisions', d.key] }
          : null;
      }
    }
  });
}
