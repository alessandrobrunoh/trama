import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';
import { TramaStore, type ResolvedActor } from '../core/stores/trama.store';
import type { ActorRef } from '../core/contracts/domain';
import { initials } from '../core/utils';
import { ProviderIcon } from './provider-icon';

/** Anything that can be shown as an actor: a raw ref (resolved via TramaStore) or an already resolved actor. */
export type ActorInput = ActorRef | ResolvedActor | null | undefined;

function isResolved(a: ActorRef | ResolvedActor): a is ResolvedActor {
  return 'name' in a;
}

/**
 * Avatar for a user, agent or team. The shapes differ on purpose:
 *   user  → round, initials on a hue-derived tint
 *   agent → rounded SQUARE with the provider mark + a small "bot" corner pip (never mistaken for a person)
 *   team  → rounded square in the team colour with the team key
 *   system→ Trama symbol
 *   <app-actor-avatar [actor]="ws.accountable" [size]="20" />   (ActorRef or ResolvedActor)
 */
@Component({
  selector: 'app-actor-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmAvatarImports, ProviderIcon],
  host: {
    class: 'relative inline-flex shrink-0',
    '[attr.title]': 'null',
    '[attr.aria-label]': 'a().name',
    role: 'img',
  },
  template: `
    @let r = a();
    @switch (r.type) {
      @case ('user') {
        <hlm-avatar class="after:hidden" [style.width.px]="size()" [style.height.px]="size()">
          <span
            hlmAvatarFallback
            class="font-medium text-white"
            [style.background]="userBg()"
            [style.font-size.px]="fontSize()"
          >
            {{ ini() }}
          </span>
        </hlm-avatar>
      }
      @case ('agent') {
        <span
          class="bg-muted text-foreground ring-border inline-flex items-center justify-center rounded-[5px] ring-1"
          [style.width.px]="size()"
          [style.height.px]="size()"
        >
          <app-provider-icon [provider]="r.provider ?? 'other'" [size]="glyph()" />
        </span>
        <span
          class="bg-primary ring-background absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2"
          aria-hidden="true"
        ></span>
      }
      @case ('team') {
        <span
          class="inline-flex items-center justify-center rounded-[5px] font-mono font-semibold text-white"
          [style.width.px]="size()"
          [style.height.px]="size()"
          [style.font-size.px]="fontSize() - 1"
          [style.background]="r.color || 'var(--tone-slate)'"
        >
          {{ (r.key || r.name).slice(0, 2) }}
        </span>
      }
      @default {
        <span
          class="bg-muted text-muted-foreground inline-flex items-center justify-center rounded-full"
          [style.width.px]="size()"
          [style.height.px]="size()"
          >
          <img src="/icons/trama-symbol-black.svg" alt="" [style.width.px]="glyph()" [style.height.px]="glyph()" class="dark:hidden" />
          <img src="/icons/trama-symbol-white.svg" alt="" [style.width.px]="glyph()" [style.height.px]="glyph()" class="hidden dark:block" />
        </span>
      }
    }
  `,
})
export class ActorAvatar {
  private readonly store = inject(TramaStore);

  readonly actor = input<ActorInput>();
  readonly size = input(20);

  protected readonly a = computed<ResolvedActor>(() => {
    const x = this.actor();
    if (!x) return { type: 'system', name: 'Trama', known: false };
    return isResolved(x) ? x : this.store.resolveActor(x);
  });
  protected readonly ini = computed(() => initials(this.a().name));
  protected readonly fontSize = computed(() => Math.max(8, Math.round(this.size() * 0.45)));
  protected readonly glyph = computed(() => Math.round(this.size() * 0.62));
  protected readonly userBg = computed(() => `hsl(${this.a().hue ?? 220} 32% 40%)`);
}

/** Avatar + name (+ optional secondary text). */
@Component({
  selector: 'app-actor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorAvatar],
  host: { class: 'inline-flex min-w-0 items-center gap-1.5' },
  template: `
    <app-actor-avatar [actor]="actor()" [size]="size()" />
    <span class="truncate">{{ name() }}</span>
  `,
})
export class ActorLabel {
  private readonly store = inject(TramaStore);
  readonly actor = input<ActorInput>();
  readonly size = input(18);
  protected readonly name = computed(() => {
    const x = this.actor();
    if (!x) return 'Trama';
    return isResolved(x) ? x.name : this.store.resolveActor(x).name;
  });
}

/**
 * Overlapping avatars with a "+N" overflow.
 *   <app-avatar-stack [actors]="execution.performers" [max]="3" [size]="20" />
 */
@Component({
  selector: 'app-avatar-stack',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorAvatar],
  host: { class: 'inline-flex items-center' },
  template: `
    @for (x of visible(); track $index) {
      <app-actor-avatar
        class="ring-background rounded-full ring-2 not-first:-ml-1.5"
        [actor]="x"
        [size]="size()"
      />
    }
    @if (extra() > 0) {
      <span
        class="bg-muted text-muted-foreground ring-background -ml-1.5 inline-flex items-center justify-center rounded-full px-1 text-[10px] font-medium ring-2"
        [style.height.px]="size()"
        [style.min-width.px]="size()"
        >+{{ extra() }}</span
      >
    }
  `,
})
export class AvatarStack {
  readonly actors = input.required<readonly ActorInput[]>();
  readonly max = input(3);
  readonly size = input(20);
  protected readonly visible = computed(() => this.actors().slice(0, this.max()));
  protected readonly extra = computed(() => Math.max(0, this.actors().length - this.max()));
}
