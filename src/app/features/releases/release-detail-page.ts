import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideCalendar,
  LucideCheck,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideInbox,
  LucideLink,
  LucidePencil,
  LucideRocket,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { TramaStore, UiStore, fullDate, shortDate, type Release } from '../../core';
import { Clipboard } from '../../core/notify/notifier';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { DatePicker } from '../../shared/date-picker';
import { EditableMarkdown, InlineText } from '../../shared/inline-edit';
import { PageHeader } from '../../shared/page-header';
import { PropertyRow } from '../../shared/property-row';
import { IssueRow } from '../issues/issue-items';
import { ReleaseFormDialog } from './release-dialogs';
import { isoFromDate, PIPELINE_TYPE_LABEL } from './release-model';
import { ReleaseStatusBadge } from './release-status';

@Component({
  selector: 'app-release-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDialogImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    TopBarActions,
    EmptyState,
    PageHeader,
    PropertyRow,
    DatePicker,
    InlineText,
    EditableMarkdown,
    IssueRow,
    ReleaseStatusBadge,
    ReleaseFormDialog,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (store.status() === 'error') {
      <app-page-header title="Release" />
      <app-empty-state
        [icon]="releaseIcon"
        title="Could not load this release"
        description="The workspace failed to load. Check your connection and try again."
      >
        <button hlmBtn size="sm" variant="outline" (click)="retry()">Try again</button>
      </app-empty-state>
    } @else if (store.status() !== 'ready') {
      <app-page-header title="Release" />
      <p class="text-muted-foreground p-8 text-center text-sm" role="status">Loading release…</p>
    } @else if (release(); as r) {
      <ng-template appTopBarActions>
        @if (canComplete()) {
          <button hlmBtn size="sm" (click)="completeOpen.set(true)">
            <svg [lucideIcon]="checkIcon" [size]="14"></svg>
            <span>Complete release</span>
          </button>
        }
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          [hlmDropdownMenuTrigger]="more"
          aria-label="Release actions"
        >
          <svg [lucideIcon]="moreIcon" [size]="16"></svg>
        </button>
        <ng-template #more>
          <hlm-dropdown-menu class="w-48">
            <button hlmDropdownMenuItem (triggered)="copyLink()">
              <svg [lucideIcon]="linkIcon" [size]="14"></svg> Copy link
            </button>
            @if (canEdit() && r.status === 'draft') {
              <button hlmDropdownMenuItem (triggered)="editOpen.set(true)">
                <svg [lucideIcon]="pencil" [size]="14"></svg> Edit release
              </button>
              <button hlmDropdownMenuItem (triggered)="cancelRelease()">Cancel release</button>
            }
            @if (canEdit()) {
              <button hlmDropdownMenuItem variant="destructive" (triggered)="confirmDelete()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete release
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <app-page-header [title]="r.name" [description]="headerMeta()">
        <span leading class="flex items-center gap-2">
          <app-release-status [status]="r.status" />
        </span>
      </app-page-header>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div
          class="mx-auto grid max-w-5xl gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_16rem]"
        >
          <div class="min-w-0">
            <div class="mb-6">
              <app-inline-text
                class="text-xl font-semibold"
                label="Version"
                placeholder="Version or SHA"
                [value]="r.name"
                [canEdit]="canEdit() && r.status === 'draft'"
                (save)="rename($event)"
              />
            </div>

            <section class="mb-8" aria-labelledby="release-notes-title">
              <h2 id="release-notes-title" class="mb-2 text-sm font-semibold">Release notes</h2>
              <app-editable-markdown
                label="Release notes"
                placeholder="What shipped in this version…"
                [value]="r.notes ?? ''"
                [canEdit]="canEdit()"
                (save)="saveNotes($event)"
              />
            </section>

            <section aria-labelledby="release-issues-title">
              <h2 id="release-issues-title" class="mb-2 text-sm font-semibold">
                Issues
                <span class="text-muted-foreground font-normal">{{ issues().length }}</span>
              </h2>
              @if (issues().length) {
                <ul role="list">
                  @for (i of issues(); track i.id) {
                    <li>
                      <app-issue-row [issue]="i" />
                    </li>
                  }
                </ul>
              } @else {
                <app-empty-state
                  [icon]="inboxIcon"
                  title="No issues in this release"
                  description="Issues with this release assigned appear here. You can still complete the release without any."
                >
                  <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'issues']">
                    Browse issues
                  </a>
                </app-empty-state>
              }
            </section>
          </div>

          <aside class="flex flex-col gap-3 lg:pt-1">
            <app-property-row label="Pipeline" [icon]="releaseIcon">
              <a class="hover:underline" [routerLink]="['/', slug(), 'releases', r.pipelineId]">
                {{ pipeline()?.name ?? 'Pipeline' }}
              </a>
            </app-property-row>
            <app-property-row label="Type">
              {{ pipelineType() }}
            </app-property-row>
            @if (pipeline()?.type === 'scheduled' || r.targetAt) {
              <app-property-row label="Target" [icon]="cal">
                @if (canEdit() && r.status === 'draft' && pipeline()?.type === 'scheduled') {
                  <app-date-picker
                    label="Target date"
                    triggerClass="h-7 gap-1.5 px-1.5 text-sm"
                    [value]="r.targetAt"
                    (dateChange)="setTarget($event)"
                  >
                    <span [class.text-muted-foreground]="!r.targetAt">
                      {{ r.targetAt ? shortDate(r.targetAt) : 'No date' }}
                    </span>
                  </app-date-picker>
                } @else {
                  <span [class.text-muted-foreground]="!r.targetAt">
                    {{ r.targetAt ? shortDate(r.targetAt) : '—' }}
                  </span>
                }
              </app-property-row>
            }
            @if (r.releasedAt) {
              <app-property-row label="Released">
                <span [title]="fullDate(r.releasedAt)">{{ shortDate(r.releasedAt) }}</span>
              </app-property-row>
            }
          </aside>
        </div>
      </div>

      <app-release-form-dialog [(open)]="editOpen" [pipeline]="pipeline()" [release]="r" />

      <hlm-dialog [state]="completeOpen() ? 'open' : 'closed'" (closed)="completeOpen.set(false)">
        <hlm-dialog-content *hlmDialogPortal="let ctx" class="sm:max-w-md">
          <hlm-dialog-header>
            <h2 hlmDialogTitle>Complete {{ r.name }}?</h2>
            <p hlmDialogDescription>
              This marks the release as released. Nothing moves until you confirm.
            </p>
          </hlm-dialog-header>
          <label class="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              class="mt-0.5"
              [checked]="moveToDone()"
              (change)="moveToDone.set($any($event.target).checked)"
            />
            <span>Move open issues in this release to Done</span>
          </label>
          @if (movesToNext()) {
            <p class="text-muted-foreground text-xs">
              Leftover open issues will move to the next draft in this scheduled pipeline.
            </p>
          }
          <hlm-dialog-footer>
            <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
            <button hlmBtn type="button" [disabled]="completeBusy()" (click)="complete()">
              Complete release
            </button>
          </hlm-dialog-footer>
        </hlm-dialog-content>
      </hlm-dialog>
    } @else {
      <app-page-header title="Release" />
      <app-empty-state
        [icon]="releaseIcon"
        title="Release not found"
        description="It may have been deleted, or the link is for another workspace."
      >
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'releases']"
          >Back to releases</a
        >
      </app-empty-state>
    }
  `,
})
export class ReleaseDetailPage {
  readonly workspaceSlug = input<string>();
  readonly pipelineId = input<string>();
  readonly releaseId = input<string>();

  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly clipboard = inject(Clipboard);

  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly checkIcon = LucideCheck;
  protected readonly linkIcon = LucideLink;
  protected readonly cal = LucideCalendar;
  protected readonly releaseIcon = LucideRocket;
  protected readonly inboxIcon = LucideInbox;
  protected readonly shortDate = shortDate;
  protected readonly fullDate = fullDate;

  protected readonly editOpen = signal(false);
  protected readonly completeOpen = signal(false);
  protected readonly completeBusy = signal(false);
  protected readonly moveToDone = signal(false);

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly release = computed(() => this.store.getRelease(this.releaseId()));
  protected readonly pipeline = computed(() => {
    const r = this.release();
    return this.store.getReleasePipeline(r?.pipelineId ?? this.pipelineId());
  });
  protected readonly issues = computed(() => {
    const id = this.release()?.id;
    if (!id) return [];
    return (this.store.issuesByRelease().get(id) ?? [])
      .slice()
      .sort((a, b) => a.key.localeCompare(b.key));
  });
  protected readonly canComplete = computed(
    () => this.canEdit() && this.release()?.status === 'draft',
  );
  protected readonly movesToNext = computed(() => {
    const p = this.pipeline();
    return p?.type === 'scheduled' && p.moveOpenIssuesToNext;
  });
  protected readonly pipelineType = computed(() => {
    const p = this.pipeline();
    return p ? PIPELINE_TYPE_LABEL[p.type] : '';
  });
  protected readonly headerMeta = computed(() => {
    const p = this.pipeline();
    const r = this.release();
    if (!p || !r) return '';
    const n = this.issues().length;
    const count = n === 1 ? '1 issue' : `${n} issues`;
    return `${p.name} · ${count}`;
  });

  private readonly _crumbs = usePageCrumbs(() => {
    const slug = this.slug();
    const p = this.pipeline();
    const r = this.release();
    return [
      { label: 'Releases', link: ['/', slug, 'releases'] },
      ...(p ? [{ label: p.name, link: ['/', slug, 'releases', p.id] }] : []),
      { label: r?.name ?? 'Release' },
    ];
  });

  protected retry(): void {
    void this.store.refetch();
  }

  protected rename(name: string): void {
    const r = this.release();
    if (r) void this.store.updateRelease(r.id, { name });
  }

  protected saveNotes(notes: string): void {
    const r = this.release();
    if (r) void this.store.updateRelease(r.id, { notes: notes.trim() || null });
  }

  protected setTarget(date: Date | null): void {
    const r = this.release();
    if (r) void this.store.updateRelease(r.id, { targetAt: date ? isoFromDate(date) : null });
  }

  protected copyLink(): void {
    void this.clipboard.copy(globalThis.location.href, 'Link copied');
  }

  protected cancelRelease(): void {
    const r = this.release();
    if (!r) return;
    this.ui.setConfirmDelete({
      title: `Cancel ${r.name}?`,
      description: 'The release is marked canceled. Issues stay assigned until you move them.',
      confirmLabel: 'Cancel release',
      destructive: true,
      onConfirm: async () => {
        await this.store.updateRelease(r.id, { status: 'canceled' });
      },
    });
  }

  protected confirmDelete(): void {
    const r = this.release();
    if (!r) return;
    this.ui.setConfirmDelete({
      title: `Delete ${r.name}?`,
      description: 'Issues in this release are unassigned. This cannot be undone.',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const ok = await this.store.deleteRelease(r.id);
        if (ok) {
          void this.router.navigate(['/', this.slug(), 'releases', r.pipelineId]);
        }
      },
    });
  }

  protected async complete(): Promise<void> {
    const r = this.release();
    if (!r || this.completeBusy()) return;
    this.completeBusy.set(true);
    const result = await this.store.completeRelease(r.id, {
      moveOpenIssuesToDone: this.moveToDone(),
    });
    this.completeBusy.set(false);
    if (result) this.completeOpen.set(false);
  }
}
