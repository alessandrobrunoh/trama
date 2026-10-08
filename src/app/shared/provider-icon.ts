import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';
import {
  LucideAsterisk,
  LucideBot,
  LucideDynamicIcon,
  LucideMousePointer2,
  LucideTerminal,
  LucideUser,
  type LucideIcon,
} from '@lucide/angular';
import type { ArtifactProvider, ExecutionProvider, GitProvider } from '../core/contracts/domain';

export type AnyProvider = ExecutionProvider | GitProvider | ArtifactProvider;

const LABEL: Record<string, string> = {
  human: 'Human',
  delta: 'Delta',
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  other: 'Other',
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  figma: 'Figma',
  docs: 'Docs',
  ci: 'CI',
};
const LUCIDE: Record<string, LucideIcon> = {
  human: LucideUser,
  claude_code: LucideAsterisk,
  codex: LucideTerminal,
  cursor: LucideMousePointer2,
  other: LucideBot,
  ci: LucideTerminal,
};

export function providerLabel(provider: AnyProvider): string {
  return LABEL[provider] ?? provider;
}

/**
 * Execution / git / artifact provider mark. Monochrome (currentColor) so it works in both themes.
 *   <app-provider-icon provider="claude_code" />   <app-provider-icon provider="github" showLabel />
 */
@Component({
  selector: 'app-provider-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'inline-flex items-center gap-1.5 whitespace-nowrap' },
  template: `
    @switch (provider()) {
      @case ('delta') {
        <!-- Delta: the official delta.dev mark (from https://delta.dev/favicon.svg) -->
        <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M15.0907 5.15945C15.3263 4.75139 15.7618 4.5 16.233 4.5C16.7042 4.5 17.1396 4.75139 17.3753 5.15945L29.3238 25.8549C29.5594 26.2629 29.5594 26.7657 29.3238 27.1738C29.0882 27.5819 28.6527 27.8333 28.1815 27.8333H9.34553C8.87431 27.8333 8.43888 27.5819 8.20327 27.1738C7.96766 26.7657 7.96766 26.2629 8.20327 25.8549L16.233 11.947L22.8744 23.4503H14.6526L15.782 21.4942H19.4863L16.233 15.8593L10.4491 25.8772H27.0779L16.233 7.09328L4.25871 27.8333H2L15.0907 5.15945Z"
          />
        </svg>
      }
      @case ('github') {
        <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path
            d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
          />
        </svg>
      }
      @case ('gitlab') {
        <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 21.5 2.6 14.4 5 5.2l2.7 6.3h8.6L19 5.2l2.4 9.2z"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linejoin="round"
          />
        </svg>
      }
      @case ('bitbucket') {
        <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M3.5 4.5h17l-2.2 14.4a1 1 0 0 1-1 .85H6.7a1 1 0 0 1-1-.85zM8.4 14h7.2l.9-5.5H7.5z"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linejoin="round"
          />
        </svg>
      }
      @default {
        <svg [lucideIcon]="icon()" [size]="size()" [strokeWidth]="1.75"></svg>
      }
    }
    @if (showLabel()) {
      <span>{{ label() }}</span>
    }
  `,
})
export class ProviderIcon {
  readonly provider = input.required<AnyProvider>();
  readonly size = input(14);
  readonly showLabel = input(false, { transform: booleanAttribute });

  protected readonly label = computed(() => providerLabel(this.provider()));
  protected readonly icon = computed(() => LUCIDE[this.provider()] ?? LucideBot);
}
