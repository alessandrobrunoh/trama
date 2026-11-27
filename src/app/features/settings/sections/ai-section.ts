import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideBot, LucideCopy, LucideDynamicIcon, LucideMessageCircle, LucideServer, LucideSparkles } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AssistantStore } from '../../../core/ai/assistant.store';
import { UiStore } from '../../../core/stores/ui.store';
import { Kbd } from '../../../shared/kbd';
import { SECTION_KIT } from './section-kit';

/** Dot colour of a provider badge. */
type Tone = 'ok' | 'warn' | 'off';

const ENV_LINES: readonly string[] = [
  '# .env on the server, then restart',
  'AI_API_URL=https://api.example.com/v1',
  'AI_API_KEY=sk-…',
  'AI_MODEL=your-model',
];

/**
 * Settings → AI & assistant (v4 frame): the Ask assistant (how to open it, who answers, what it sees, with a
 * preview of its panel), the providers behind it (server, SuperGrok, ChatGPT) and what is shared with them.
 */
@Component({
  selector: 'app-ai-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, Kbd, LucideDynamicIcon, NgTemplateOutlet, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9 leading-[normal]' },
  template: `
    <app-section-header
      flush
      title="AI & assistant"
      description="Ask is the assistant you open from any page. Pick who answers and what it can see."
    />
    @if (ai.statusError()) {
      <p class="text-red -mt-5 text-[13px]" role="alert">{{ ai.statusError() }}</p>
    }

    <app-settings-block title="Ask">
      <div class="flex flex-col gap-5 md:flex-row md:items-start">
        <app-settings-card class="min-w-0 flex-1">
          <app-card-row label="Open Ask" description="From the status bar on every page.">
            <app-kbd keys="mod+j" />
          </app-card-row>
          <app-card-row label="Answer with" [description]="answerHint()">
            <span class="text-foreground font-mono text-[12px]">{{ answerWith() }}</span>
          </app-card-row>
          <app-card-row label="Include the current page" description="Ask sees the task, project or view you’re on.">
            <app-switch [checked]="ai.shareContext()" (checkedChange)="ai.shareContext.set($event)" aria-label="Include the current page" />
          </app-card-row>
        </app-settings-card>

        <div class="bg-secondary border-selected hidden w-[250px] shrink-0 flex-col border md:flex" aria-hidden="true">
          <div class="border-border flex items-center gap-1.5 border-b px-2.5 py-2">
            <svg [lucideIcon]="sparkles" [size]="11" class="text-primary"></svg>
            <span class="text-foreground/80 font-mono text-[10.5px]">Ask</span>
            <span class="flex-1"></span>
            <app-kbd keys="mod+j" />
          </div>
          <div class="flex flex-col gap-2 p-2.5">
            <span class="border-primary/40 bg-primary/10 text-foreground/80 w-fit border px-1.5 py-0.5 font-mono text-[10px]">This page</span>
            <span class="text-faint text-[12px]">Summarise the open review comments</span>
          </div>
        </div>
      </div>
    </app-settings-block>

    <app-settings-block title="Providers">
      <app-settings-card>
        <!-- server -->
        <div class="bg-bg-deep flex flex-col gap-3 px-4 py-3.5">
          <div class="flex items-center gap-3">
            <span class="bg-secondary border-border text-muted-foreground grid size-[30px] shrink-0 place-items-center border">
              <svg [lucideIcon]="server" [size]="15"></svg>
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-foreground text-[13.5px]">Server provider</span>
                <ng-container [ngTemplateOutlet]="badge" [ngTemplateOutletContext]="{ text: serverBadge().text, tone: serverBadge().tone }" />
              </div>
              <span class="text-muted-foreground text-[12px]">
                @if (ai.status()?.suggestions?.model; as model) {
                  Model <span class="font-mono">{{ model }}</span>
                } @else {
                  Any OpenAI-compatible endpoint set by your admin.
                }
              </span>
            </div>
            @if (!ai.ready()) {
              <button hlmBtn size="sm" variant="outline" (click)="copyEnv()">
                <svg [lucideIcon]="copy" [size]="13"></svg>
                {{ copied() ? 'Copied' : 'Copy env' }}
              </button>
            }
          </div>
          @if (!ai.ready()) {
            <div class="pl-[42px]">
              <div class="bg-bg-deep border-border flex flex-col gap-1 border px-3.5 py-3">
                @for (line of envLines; track line) {
                  <code class="font-mono text-[11.5px] leading-[17px]" [class]="line.startsWith('#') ? 'text-faint' : 'text-text-2'">{{ line }}</code>
                }
              </div>
            </div>
          }
        </div>

        <!-- SuperGrok -->
        <div class="flex flex-col gap-3 px-4 py-3.5">
          <div class="flex items-center gap-3">
            <span class="bg-secondary border-border text-muted-foreground grid size-[30px] shrink-0 place-items-center border">
              <svg [lucideIcon]="bot" [size]="15"></svg>
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-foreground text-[13.5px]">SuperGrok</span>
                <ng-container [ngTemplateOutlet]="badge" [ngTemplateOutletContext]="{ text: grokBadge().text, tone: grokBadge().tone }" />
              </div>
              <span class="text-muted-foreground text-[12px]">Use your own subscription.</span>
            </div>
            @if (ai.status()?.supergrok?.connected) {
              <button hlmBtn size="sm" variant="outline" (click)="disconnectSuperGrok()">Disconnect</button>
            } @else {
              <button hlmBtn size="sm" variant="outline" [disabled]="!ai.status()?.supergrok?.available" (click)="ai.connectSuperGrok()">Connect</button>
            }
          </div>
          @if (ai.status()?.supergrok?.login; as login) {
            <div class="flex flex-col gap-2.5 pl-[42px]">
              @if (login.error) {
                <p class="text-red text-[13px]" role="alert">{{ login.error }}</p>
              } @else if (login.code) {
                <p class="text-[13px]">Enter this one-time code on Grok’s authorization page:</p>
                <p class="border-border text-foreground w-fit border px-3 py-1.5 font-mono text-[18px]" aria-live="polite">{{ login.code }}</p>
                @if (login.url) {
                  <a [href]="login.url" target="_blank" rel="noopener noreferrer" class="w-fit text-sm underline underline-offset-4">Open Grok authorization</a>
                }
              } @else {
                <p class="text-muted-foreground text-sm" aria-live="polite">Waiting for the Grok Build CLI to provide a device code…</p>
              }
            </div>
          }
        </div>

        <!-- ChatGPT -->
        <div class="flex flex-col gap-3 px-4 py-3.5">
          <div class="flex items-center gap-3">
            <span class="bg-secondary border-border text-muted-foreground grid size-[30px] shrink-0 place-items-center border">
              <svg [lucideIcon]="chat" [size]="15"></svg>
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-foreground text-[13.5px]">ChatGPT</span>
                <ng-container [ngTemplateOutlet]="badge" [ngTemplateOutletContext]="{ text: 'Waiting for OpenAI approval', tone: 'off' }" />
              </div>
              <span class="text-muted-foreground text-[12px]">Sign in with your OpenAI account.</span>
            </div>
            <button hlmBtn size="sm" variant="outline" disabled>Connect</button>
          </div>
        </div>
      </app-settings-card>
    </app-settings-block>

    <ng-template #badge let-text="text" let-tone="tone">
      <span class="border-border text-foreground/80 inline-flex items-center gap-[5px] border px-[7px] py-0.5 font-mono text-[10.5px]">
        <span class="size-1.5" [class]="tone === 'ok' ? 'bg-green' : tone === 'warn' ? 'bg-primary' : 'bg-faint'"></span>{{ text }}
      </span>
    </ng-template>
  `,
})
export class AiSection {
  protected readonly ai = inject(AssistantStore);
  private readonly ui = inject(UiStore);

  protected readonly sparkles = LucideSparkles;
  protected readonly bot = LucideBot;
  protected readonly server = LucideServer;
  protected readonly copy = LucideCopy;
  protected readonly chat = LucideMessageCircle;
  protected readonly envLines = ENV_LINES;
  protected readonly copied = signal(false);

  /** Who answers the assistant: the connected SuperGrok account first, else the server provider. */
  protected readonly answerWith = computed(() => {
    if (this.ai.loadingStatus()) return 'Checking…';
    const status = this.ai.status();
    if (status?.supergrok?.connected) return 'SuperGrok';
    if (status?.suggestions?.configured) return 'Server provider';
    return 'Not configured';
  });
  protected readonly answerHint = computed(() =>
    this.answerWith() === 'Not configured'
      ? 'Configure a provider below to use Ask and draft suggestions.'
      : 'Used for draft improvements and assistant conversations.',
  );

  protected readonly serverBadge = computed<{ text: string; tone: Tone }>(() => {
    if (this.ai.loadingStatus()) return { text: 'Checking…', tone: 'off' };
    return this.ai.status()?.suggestions?.configured
      ? { text: 'Configured', tone: 'ok' }
      : { text: 'Not configured', tone: 'warn' };
  });
  protected readonly grokBadge = computed<{ text: string; tone: Tone }>(() => {
    const grok = this.ai.status()?.supergrok;
    if (!grok?.available) return { text: 'Not enabled by server', tone: 'off' };
    return grok.connected ? { text: 'Connected', tone: 'ok' } : { text: 'Not connected', tone: 'warn' };
  });

  protected async copyEnv(): Promise<void> {
    try {
      await navigator.clipboard.writeText(ENV_LINES.join('\n'));
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      /* clipboard not available: the lines are on screen to copy by hand */
    }
  }

  protected disconnectSuperGrok(): void {
    this.ui.setConfirmDelete({
      title: 'Disconnect SuperGrok?',
      description: 'The assistant stops using your SuperGrok account until you connect it again.',
      confirmLabel: 'Disconnect',
      onConfirm: () => this.ai.disconnectSuperGrok(),
    });
  }
}
