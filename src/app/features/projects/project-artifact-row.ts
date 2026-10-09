import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideBox,
  LucideChevronRight,
  LucideCircleDot,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideExternalLink,
  LucideHexagon,
  LucidePencil,
  LucideTrash2,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { NablaStore, UiStore, type Artifact, type SubjectRef } from '../../core';
import { ArtifactIcon, CiChip, ConflictChip, ReviewChip } from '../../shared/artifact';
import { Markdown } from '../../shared/markdown';
import { RelativeTimePipe } from '../../shared/pipes';
import { ProviderIcon } from '../../shared/provider-icon';
import { StatusBadge } from '../../shared/status';

/** A project / workstream / issue reference resolved for display and navigation. */
export interface SubjectView {
  type: 'project' | 'workstream' | 'issue';
  label: string;
  /** Show `label` in mono (keys). */
  mono: boolean;
  /** Full title, for the accessible name. */
  title: string;
  link: string[];
}

/** Resolves a `SubjectRef` of the project tree to something renderable; `null` when it is gone or unsupported. */
export function resolveSubject(store: NablaStore, ref: SubjectRef): SubjectView | null {
  const slug = store.slug() ?? '';
  switch (ref.type) {
    case 'project': {
      const p = store.getProject(ref.id);
      return p
        ? {
            type: 'project',
            label: p.name,
            mono: false,
            title: p.name,
            link: ['/', slug, 'projects', p.id],
          }
        : null;
    }
    case 'workstream': {
      const w = store.workstreamById().get(ref.id);
      return w
        ? {
            type: 'workstream',
            label: w.key,
            mono: true,
            title: w.title,
            link: ['/', slug, 'workstreams', w.key],
          }
        : null;
    }
    case 'issue': {
      const i = store.issueById().get(ref.id);
      return i
        ? {
            type: 'issue',
            label: i.key,
            mono: true,
            title: i.title,
            link: ['/', slug, 'issues', i.key],
          }
        : null;
    }
    default:
      return null;
  }
}

export const SUBJECT_ICON: Record<SubjectView['type'], LucideIcon> = {
  project: LucideBox,
  workstream: LucideHexagon,
  issue: LucideCircleDot,
};

export const SUBJECT_TONE: Record<SubjectView['type'], string> = {
  project: 'text-muted-foreground',
  workstream: 'text-entity-workstream',
  issue: 'text-entity-issue',
};

const SHOW_PROVIDER = new Set(['github', 'gitlab', 'bitbucket', 'figma']);
const LONG_DESCRIPTION = 140;

/**
 * One artifact in the project context: kind / provider glyph, title (external link when it has a URL), state, CI /
 * review chips, a short description and an "origin" chip that links back to the project, workstream or issue it is
 * attached to. `origin` picks what the chip shows: just the owner, the whole path, or nothing.
 */
@Component({
  selector: 'app-project-artifact-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    ArtifactIcon,
    CiChip,
    ReviewChip,
    ConflictChip,
    Markdown,
    ProviderIcon,
    StatusBadge,
    RelativeTimePipe,
  ],
  host: { class: 'hover:bg-hover block border-b' },
  template: `
    @let a = artifact();
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pr-4 sm:pr-6"
      [style.padding-left.px]="indent()"
    >
      <span class="flex min-w-0 flex-1 items-center gap-2 max-sm:basis-full">
        <app-artifact-icon [kind]="a.kind" [state]="a.state" [size]="16" />
        @if (showProvider()) {
          <app-provider-icon [provider]="a.provider" [size]="12" class="text-muted-foreground" />
        }
        @if (a.externalId) {
          <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ a.externalId }}</span>
        }
        @if (a.documentId) {
          <a
            [routerLink]="['/', slug(), 'documents', a.documentId]"
            class="inline-flex min-w-0 items-center gap-1 text-sm hover:underline"
            ><span class="truncate">{{ a.title }}</span></a
          >
        } @else if (a.url) {
          <a
            [href]="a.url"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex min-w-0 items-center gap-1 text-sm hover:underline"
          >
            <span class="truncate">{{ a.title }}</span>
            <svg [lucideIcon]="ext" [size]="11" class="text-muted-foreground shrink-0"></svg>
          </a>
        } @else {
          <span class="min-w-0 truncate text-sm">{{ a.title }}</span>
        }
      </span>

      <span class="flex flex-wrap items-center gap-1.5 max-sm:pl-6">
        <app-status-badge [status]="a.state" />
        @if (a.ci) {
          <app-ci-chip [ci]="a.ci" />
        }
        @if (a.review) {
          <app-review-chip [review]="a.review" />
        }
        @if (a.hasConflicts) {
          <app-conflict-chip />
        }
        @if (a.environment) {
          <span
            class="text-muted-foreground bg-muted rounded-md px-1.5 py-0.5 font-mono text-[11px]"
            >{{ a.environment }}</span
          >
        }
      </span>

      <span class="text-muted-foreground flex min-w-0 items-center gap-2 text-xs max-sm:pl-6">
        @if (origin() !== 'none') {
          <nav class="flex min-w-0 items-center gap-0.5" aria-label="Origin">
            @for (s of chain(); track s.link.join('/'); let last = $last) {
              <a
                [routerLink]="s.link"
                class="hover:bg-accent hover:text-foreground border-border-strong inline-flex h-6 min-w-0 max-w-40 items-center gap-1 rounded-full border px-2"
                [attr.aria-label]="s.type + ' ' + s.label + ': ' + s.title"
              >
                <svg
                  [lucideIcon]="icon[s.type]"
                  [size]="12"
                  class="shrink-0"
                  [class]="tone[s.type]"
                ></svg>
                <span class="truncate" [class]="s.mono ? 'font-mono text-[11px]' : ''">{{
                  s.label
                }}</span>
              </a>
              @if (!last) {
                <svg [lucideIcon]="sep" [size]="12" class="shrink-0 opacity-60"></svg>
              }
            }
          </nav>
        }
        <span class="max-md:hidden">{{ a.updatedAt | relativeTime }}</span>
      </span>

      @if (editable()) {
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground size-7"
          [hlmDropdownMenuTrigger]="menu"
          aria-label="Artifact actions"
        >
          <svg [lucideIcon]="more" [size]="15"></svg>
        </button>
        <ng-template #menu>
          <hlm-dropdown-menu class="w-44">
            @if (a.documentId) {
              <a hlmDropdownMenuItem [routerLink]="['/', slug(), 'documents', a.documentId]">
                <svg [lucideIcon]="pencil" [size]="14"></svg>Open document
              </a>
            } @else {
              <button hlmDropdownMenuItem (triggered)="edit.emit(a)">
                <svg [lucideIcon]="pencil" [size]="14"></svg>Edit
              </button>
            }
            <hlm-dropdown-menu-separator />
            <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
              <svg [lucideIcon]="trash" [size]="14"></svg>{{ a.documentId ? 'Detach' : 'Remove' }}
            </button>
          </hlm-dropdown-menu>
        </ng-template>
      }
    </div>

    @if (a.description) {
      <div class="pr-4 pb-2 sm:pr-6" [style.padding-left.px]="indent() + 24">
        <div class="text-muted-foreground text-xs [&_p]:my-0" [class.line-clamp-2]="!expanded()">
          <app-markdown [source]="a.description" />
        </div>
        @if (a.description.length > longLimit) {
          <button
            type="button"
            class="text-primary mt-0.5 text-xs hover:underline"
            (click)="expanded.set(!expanded())"
          >
            {{ expanded() ? 'Show less' : 'Show more' }}
          </button>
        }
      </div>
    }
  `,
})
export class ProjectArtifactRow {
  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);

  readonly artifact = input.required<Artifact>();
  /** Chain project → … → owner, as in `ProjectContextArtifact.path`. */
  readonly path = input<readonly SubjectRef[]>([]);
  /** What the origin chip shows: the owner only, the whole chain, or nothing. */
  readonly origin = input<'owner' | 'path' | 'none'>('owner');
  /** Left padding in px, to nest the row under its tree node. */
  readonly indent = input(16);
  /** Show the edit / remove menu. */
  readonly editable = input(false);
  readonly edit = output<Artifact>();

  protected readonly ext = LucideExternalLink;
  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly sep = LucideChevronRight;
  protected readonly icon = SUBJECT_ICON;
  protected readonly tone = SUBJECT_TONE;
  protected readonly longLimit = LONG_DESCRIPTION;
  protected readonly expanded = signal(false);

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly showProvider = computed(() => SHOW_PROVIDER.has(this.artifact().provider));
  protected readonly chain = computed(() => {
    const mode = this.origin();
    if (mode === 'none') return [];
    const path = this.path();
    const refs = mode === 'owner' ? path.slice(-1) : path;
    return refs.flatMap((r) => {
      const v = resolveSubject(this.store, r);
      return v ? [v] : [];
    });
  });

  protected remove(): void {
    const a = this.artifact();
    this.ui.setConfirmDelete({
      title: `${a.documentId ? 'Detach' : 'Remove'} “${a.title}”?`,
      description: a.documentId
        ? 'The document is detached from here. The document itself is kept.'
        : 'The item is detached from the context. The linked page itself is not touched.',
      confirmLabel: a.documentId ? 'Detach' : 'Remove',
      onConfirm: async () => {
        await this.store.removeArtifact(a.id);
      },
    });
  }
}
