import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideBot, LucideDynamicIcon, LucideSparkles, LucideZap } from '@lucide/angular';
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
  host: { class: 'flex flex-col gap-9' },
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
            <button hlmBtn size="sm" variant="outline" [disabled]="!ai.ready()" (click)="ai.open.set(true)">Open</button>
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
              <svg [lucideIcon]="bot" [size]="15"></svg>
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
            <button hlmBtn size="sm" variant="outline" [disabled]="ai.loadingStatus()" (click)="ai.refreshStatus()">Refresh status</button>
          </div>
          @if (!ai.ready()) {
            <div class="pl-[42px]">
              <div class="bg-bg-deep border-border flex flex-col gap-1 border px-3.5 py-3">
                @for (line of envLines; track line) {
                  <code class="font-mono text-[11.5px] leading-[17px]" [class]="line.startsWith('#') ? 'text-faint' : 'text-foreground/80'">{{ line }}</code>
                }
                <div class="mt-1 flex justify-end">
                  <button hlmBtn size="sm" variant="ghost" (click)="copyEnv()">{{ copied() ? 'Copied' : 'Copy env' }}</button>
                </div>
              </div>
            </div>
          }
          <p class="text-faint pl-[42px] font-mono text-[10.5px] leading-snug">
            Configured means the server has credentials; the provider is contacted only when you request a suggestion or send a message.
          </p>
        </div>

        <!-- SuperGrok -->
        <div class="flex flex-col gap-3 px-4 py-3.5">
          <div class="flex items-center gap-3">
            <span class="bg-secondary border-border text-muted-foreground grid size-[30px] shrink-0 place-items-center border">
              <svg [lucideIcon]="zap" [size]="15"></svg>
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-foreground text-[13.5px]">SuperGrok</span>
                <ng-container [ngTemplateOutlet]="badge" [ngTemplateOutletContext]="{ text: grokBadge().text, tone: grokBadge().tone }" />
              </div>
              <span class="text-muted-foreground text-[12px]">Use your own subscription, with the official Grok Build device authorization flow.</span>
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
          @if (!ai.status()?.supergrok?.available) {
            <p class="text-muted-foreground pl-[42px] text-[12.5px] leading-snug">
              Install the official <code class="font-mono">@xai-official/grok</code> CLI in the API container and set
              <code class="font-mono">GROK_HOME_DIR</code> to a persistent private volume.
            </p>
          }
          <p class="text-faint pl-[42px] font-mono text-[10.5px] leading-snug">
            Each Trama account gets a separate Grok home directory. The official CLI stores its own credentials there; protect the configured volume and its backups.
          </p>
        </div>

        <!-- ChatGPT -->
        <div class="flex flex-col gap-3 px-4 py-3.5">
          <div class="flex items-center gap-3">
            <span class="bg-secondary border-border text-muted-foreground grid size-[30px] shrink-0 place-items-center border">
              <svg [lucideIcon]="sparkles" [size]="15"></svg>
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-foreground text-[13.5px]">ChatGPT</span>
                <ng-container [ngTemplateOutlet]="badge" [ngTemplateOutletContext]="{ text: 'Waiting for OpenAI approval', tone: 'off' }" />
              </div>
              <span class="text-muted-foreground text-[12px]">Sign in with your OpenAI account.</span>
            </div>
            <button hlmBtn size="sm" variant="outline" disabled aria-describedby="chatgpt-availability">Connect</button>
          </div>
          <p id="chatgpt-availability" class="text-muted-foreground pl-[42px] text-[12.5px] leading-snug">
            Connecting a ChatGPT subscription to a remotely hosted app requires OpenAI approval. The public local-app login cannot be used on this server. No ChatGPT account is connected.
            <a
              href="https://developers.openai.com/siwc/token-sharing-open-source"
              target="_blank"
              rel="noopener noreferrer"
              class="text-foreground underline underline-offset-4"
              >OpenAI eligibility and access information</a
            >
          </p>
        </div>
      </app-settings-card>
    </app-settings-block>

    <app-settings-block title="What AI can see">
      <app-settings-card>
        <div class="text-muted-foreground px-4 py-3.5 text-[12.5px] leading-[19px]">
          Suggestions send your draft to your connected SuperGrok account, if available, or the server provider. Chat sends your messages and,
          when selected, details of the item you have open. Conversations are kept only in this browser tab and cleared when you leave the
          workspace or sign out. The assistant cannot change workspace data.
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
  protected readonly zap = LucideZap;
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
