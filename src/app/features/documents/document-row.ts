import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideFileText } from '@lucide/angular';
import { NablaStore, type DocumentSummary } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { RelativeTimePipe } from '../../shared/pipes';
import { isEmojiIcon } from '../projects/project-glyph';
import { OWNER_ICONS, describeLink } from './document-attach';

/**
 * One document in a list: icon, title, the start of the text (or the passage a search matched), where it is
 * attached, when and by whom it was last edited.
 */
@Component({
  selector: 'app-document-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, ActorAvatar, RelativeTimePipe],
  host: { class: 'block' },
  template: `
    @let d = doc();
    <a
      [routerLink]="['/', slug(), 'documents', d.id]"
      class="hover:bg-hover focus-visible:bg-hover flex items-start gap-3 border-b px-4 py-2.5 outline-none sm:px-6"
    >
      <span
        class="mt-0.5 flex size-6 shrink-0 items-center justify-center text-lg leading-none"
        aria-hidden="true"
      >
        @if (emoji(); as e) {
          {{ e }}
        } @else {
          <svg [lucideIcon]="fileIcon" [size]="18" class="text-muted-foreground"></svg>
        }
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2">
          <span class="truncate text-sm font-medium">{{ d.title }}</span>
          @if (d.archivedAt) {
            <span class="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-px text-[11px]"
              >Archived</span
            >
          }
        </span>
        @if (d.snippet) {
          <span
            class="text-muted-foreground [&_mark]:bg-primary/20 [&_mark]:text-foreground mt-0.5 line-clamp-2 block text-xs [&_mark]:rounded-sm [&_mark]:px-0.5"
            [innerHTML]="d.snippet"
          ></span>
        } @else if (d.excerpt) {
          <span class="text-muted-foreground mt-0.5 line-clamp-1 block text-xs">{{
            d.excerpt
          }}</span>
        }
      </span>
      <span class="text-muted-foreground flex shrink-0 items-center gap-2.5 pt-0.5 text-xs">
        @if (showLinks()) {
          <span class="flex items-center gap-1 max-md:hidden">
            @for (l of shownLinks(); track l.key) {
              <span
                class="border-border-strong inline-flex h-5 max-w-32 items-center gap-1 rounded-full border px-1.5"
              >
                <svg [lucideIcon]="ownerIcons[l.type]" [size]="11" class="shrink-0"></svg>
                <span class="truncate" [class.font-mono]="l.mono">{{ l.label }}</span>
              </span>
            }
            @if (extra() > 0) {
              <span>+{{ extra() }}</span>
            }
          </span>
        }
        <span class="max-sm:hidden">{{ d.updatedAt | relativeTime }}</span>
        <app-actor-avatar [actor]="d.lastEditor" [size]="18" />
      </span>
    </a>
  `,
})
export class DocumentRow {
  private readonly store = inject(NablaStore);

  readonly doc = input.required<DocumentSummary>();
  /** Show where the document is attached (off on a project page, where it is obvious). */
  readonly showLinks = input(true);

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly fileIcon = LucideFileText;
  protected readonly ownerIcons = OWNER_ICONS;
  protected readonly emoji = computed(() =>
    isEmojiIcon(this.doc().icon) ? this.doc().icon! : null,
  );
  private readonly resolved = computed(() =>
    (this.doc().links ?? []).flatMap((l) => {
      const v = describeLink(this.store, l);
      return v ? [{ ...v, key: l.artifactId }] : [];
    }),
  );
  protected readonly shownLinks = computed(() => this.resolved().slice(0, 2));
  protected readonly extra = computed(() => Math.max(0, this.resolved().length - 2));
}
