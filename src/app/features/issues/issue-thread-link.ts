import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { type Issue } from '../../core';
import { isThreadUrl } from '../../core/contracts/domain';
import { threadId } from './task-record-model';

/** What a person typed, as a full link: a bare `delta.dev/…` gets `https://`. */
export function toThreadUrl(raw: string): string {
  const v = raw.trim();
  return v && !/^[a-z][a-z0-9+.-]*:/i.test(v) ? `https://${v}` : v;
}

/**
 * The contract's `isThreadUrl`, plus a host check: browsers percent-encode spaces in a host
 * (`https://not a link` parses), which the server rejects.
 */
export function isValidThreadUrl(url: string): boolean {
  if (!isThreadUrl(url)) return false;
  try {
    return /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(new URL(url).hostname) && !/\s/.test(url);
  } catch {
    return false;
  }
}

/**
 * The THREAD row of the task inspector: the id of the Delta thread linked to the task (new tab), or "No thread".
 * The agent links the thread with /trama, so the row is read-only.
 */
@Component({
  selector: 'app-issue-thread-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip],
  host: { class: 'block min-w-0' },
  template: `
    @let url = issue().threadUrl;
    @if (url) {
      <a
        [href]="url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-delta focus-visible:ring-ring flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-[14px] outline-none hover:underline focus-visible:ring-2"
        [hlmTooltip]="'Open thread · ' + url"
      >
        <span class="bg-delta-line size-1.5 shrink-0" aria-hidden="true"></span>
        <span class="truncate">{{ id(url) }}</span>
        <span aria-hidden="true">↗</span>
      </a>
    } @else {
      <span class="text-faint font-mono text-[11px]">No thread</span>
    }
  `,
})
export class IssueThreadLink {
  readonly issue = input.required<Issue>();

  protected id(url: string): string {
    return threadId(url);
  }
}
