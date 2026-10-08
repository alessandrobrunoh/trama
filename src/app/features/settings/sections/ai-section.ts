import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AssistantStore } from '../../../core/ai/assistant.store';
import { SECTION_KIT } from './section-kit';

@Component({
  selector: 'app-ai-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-8' },
  template: `
    <app-section-header
      title="AI & assistant"
      description="Draft suggestions and a contextual assistant, available throughout your workspace."
    />
    @if (ai.statusError()) {
      <p class="text-destructive text-sm" role="alert">{{ ai.statusError() }}</p>
    }
    <app-settings-group
      title="Suggestions & chat"
      description="Use your connected SuperGrok account or the server’s configured provider."
    >
      <app-settings-row
        label="Connection"
        description="Used for draft improvements and assistant conversations."
      >
        <span class="text-sm">{{
          ai.loadingStatus()
            ? 'Checking…'
            : ai.status()?.supergrok?.connected
              ? 'SuperGrok connected'
              : ai.status()?.suggestions?.configured
                ? 'Server provider configured'
                : 'Not configured'
        }}</span>
      </app-settings-row>
      @if (ai.status()?.suggestions?.model; as model) {
        <app-settings-row label="Model"
          ><span class="font-mono text-xs">{{ model }}</span></app-settings-row
        >
      }
      <div class="space-y-3 px-4 py-3">
        @if (!ai.ready()) {
          <p class="text-muted-foreground text-sm">
          Set <code>AI_API_URL</code>, <code>AI_API_KEY</code> and <code>AI_MODEL</code> in the
          server environment, or connect a SuperGrok account below.
          </p>
        }
        <div class="flex gap-2">
          <button
            hlmBtn
            variant="outline"
            size="sm"
            [disabled]="ai.loadingStatus()"
            (click)="ai.refreshStatus()"
          >
            Refresh status
          </button>
          <button hlmBtn size="sm" [disabled]="!ai.ready()" (click)="ai.open.set(true)">
            Open assistant
          </button>
        </div>
        <p class="text-muted-foreground text-xs">
          Configured means the server has credentials; the provider is contacted only when you
          request a suggestion or send a message.
        </p>
      </div>
    </app-settings-group>
    <app-settings-group
      title="SuperGrok account"
      description="Connect with the official Grok Build device authorization flow."
    >
      <app-settings-row label="Connection">
        <span class="text-sm">
          @if (!ai.status()?.supergrok?.available) {
            Not enabled by server
          } @else if (ai.status()?.supergrok?.connected) {
            Connected
          } @else {
            Not connected
          }
        </span>
      </app-settings-row>
      <div class="space-y-3 px-4 py-3">
        @if (ai.status()?.supergrok?.login; as login) {
          @if (login.error) {
            <p class="text-destructive text-sm" role="alert">{{ login.error }}</p>
          } @else if (login.code) {
            <p class="text-sm">Enter this one-time code on Grok’s authorization page:</p>
            <p class="font-mono text-lg font-semibold" aria-live="polite">{{ login.code }}</p>
            @if (login.url) {
              <a
                [href]="login.url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sm underline underline-offset-4"
                >Open Grok authorization</a
              >
            }
          } @else {
            <p class="text-muted-foreground text-sm" aria-live="polite">
              Waiting for the Grok Build CLI to provide a device code…
            </p>
          }
        }
        @if (!ai.status()?.supergrok?.available) {
          <p class="text-muted-foreground text-sm">
            Install the official <code>@xai-official/grok</code> CLI in the API container and set
            <code>GROK_HOME_DIR</code> to a persistent private volume.
          </p>
        }
        <div class="flex gap-2">
          @if (ai.status()?.supergrok?.connected) {
            <button hlmBtn variant="outline" size="sm" (click)="ai.disconnectSuperGrok()">
              Disconnect SuperGrok
            </button>
          } @else {
            <button
              hlmBtn
              size="sm"
              [disabled]="!ai.status()?.supergrok?.available"
              (click)="ai.connectSuperGrok()"
            >
              Connect SuperGrok
            </button>
          }
          <button hlmBtn variant="outline" size="sm" (click)="ai.refreshStatus()">
            Refresh status
          </button>
        </div>
        <p class="text-muted-foreground text-xs">
          Each Trama account gets a separate Grok home directory. The official CLI stores its own
          credentials there; protect the configured volume and its backups.
        </p>
      </div>
    </app-settings-group>
    <app-settings-group
      title="ChatGPT account"
      description="Use your own ChatGPT plan when this installation is eligible."
    >
      <app-settings-row label="Connection"
        ><span class="text-muted-foreground text-sm"
          >Requires OpenAI approval</span
        ></app-settings-row
      >
      <div class="space-y-3 px-4 py-3">
        <p id="chatgpt-availability" class="text-muted-foreground text-sm">
          Connecting a ChatGPT subscription to a remotely hosted app requires OpenAI approval. The
          public local-app login cannot be used on this server. No ChatGPT account is connected.
        </p>
        <button hlmBtn variant="outline" size="sm" disabled aria-describedby="chatgpt-availability">
          Continue with ChatGPT
        </button>
        <p>
          <a
            href="https://developers.openai.com/siwc/token-sharing-open-source"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm underline underline-offset-4"
            >OpenAI eligibility and access information</a
          >
        </p>
      </div>
    </app-settings-group>
    <p class="text-muted-foreground text-sm">
      Suggestions send your draft to your connected SuperGrok account, if available, or the server
      provider. Chat sends your messages and, when
      selected, details of the item you have open. Conversations are kept only in this browser tab
      and cleared when you leave the workspace or sign out. The assistant cannot change workspace
      data.
    </p>
  `,
})
export class AiSection {
  protected readonly ai = inject(AssistantStore);
}
