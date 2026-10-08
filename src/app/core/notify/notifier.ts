// Notifier — the single place core code raises user-facing toasts.
// Core never imports a UI library. By default messages go to the console; the app
// installs the real toast sink (ngx-sonner / Spartan sonner) once with `Notifier.use(sink)`
// (see app.config.ts). Feature code may inject Notifier too, or use the UI toast directly.
import { Injectable } from '@angular/core';

export type NoticeKind = 'success' | 'error' | 'info';

export interface NoticeOptions {
  description?: string;
  /** Auto-dismiss in ms (sink-specific default when omitted). */
  duration?: number;
  /** One inline action button, e.g. `{ label: 'Undo', run: () => restore() }`. */
  action?: { label: string; run: () => void };
}

export type NoticeSink = (kind: NoticeKind, title: string, options?: NoticeOptions) => void;

@Injectable({ providedIn: 'root' })
export class Notifier {
  private sink: NoticeSink = (kind, title, options) => {
    const line = options?.description ? `${title} - ${options.description}` : title;
    if (kind === 'error') console.error(`[nabla] ${line}`);
    else console.info(`[nabla] ${line}`);
  };

  /** Install the toast implementation. */
  use(sink: NoticeSink): void {
    this.sink = sink;
  }

  success(title: string, options?: NoticeOptions): void {
    this.sink('success', title, options);
  }

  error(title: string, options?: NoticeOptions): void {
    this.sink('error', title, options);
  }

  info(title: string, options?: NoticeOptions): void {
    this.sink('info', title, options);
  }
}

/**
 * Copy text to the clipboard and confirm with a toast.
 *   inject(Clipboard).copy(location.href, 'Link copied')
 */
@Injectable({ providedIn: 'root' })
export class Clipboard {
  constructor(private readonly notifier: Notifier) {}

  async copy(text: string, title = 'Copied to clipboard'): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      this.notifier.success(title, { description: text.length > 80 ? text.slice(0, 77) + '…' : text, duration: 2000 });
      return true;
    } catch {
      this.notifier.error('Could not copy to clipboard');
      return false;
    }
  }
}
