import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  LucideChartGantt,
  LucideChevronsUpDown,
  LucideCheck,
  LucideCircleUser,
  LucideCornerDownRight,
  LucideFileCode,
  LucideGitPullRequest,
  LucideHouse,
  LucideInbox,
  LucideListChecks,
  LucideListTree,
  LucidePanelLeft,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideSparkles,
  LucideBraces,
  LucideBell,
  LucideGlobe,
  LucideSmartphone,
  LucideSquareKanban,
  LucideTimer,
  LucideDynamicIcon,
  type LucideIcon,
} from '@lucide/angular';
import { TramaLogo } from '../../shared/trama-logo';

interface NavItem {
  label: string;
  icon: LucideIcon;
  count?: string;
  current?: boolean;
}

interface SubtaskRow {
  key: string;
  title: string;
  done: boolean;
  thread: boolean;
  est: number;
  status: 'Done' | 'In progress' | 'Todo';
  who: string;
  whoBg: string;
}

interface ChangedFile {
  path: string;
  delta: string;
}

/**
 * Static product mockup for the landing page ("Product shot" in the v3 landing frame): the task
 * detail of TRM-128 with its subtasks and Delta thread record. Illustrative content, no store.
 * On large screens it is the 1440px app clipped to the frame; on small ones the side panes drop out.
 */
@Component({
  selector: 'app-landing-product-shot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, TramaLogo],
  host: {
    class: 'relative block h-[560px] overflow-hidden leading-normal md:h-[820px]',
    role: 'img',
    'aria-label':
      'Preview of a Trama task, TRM-128, with its subtasks and the read-only record of the Delta thread linked to it',
  },
  template: `
    <div
      class="bg-background text-foreground flex w-full select-none max-lg:min-h-full lg:h-[820px]"
      aria-hidden="true"
    >
      <!-- Sidebar -->
      <aside class="bg-card border-border hidden w-[248px] shrink-0 flex-col border-r lg:flex">
        <div class="border-border flex h-[44px] items-center gap-2.5 border-b px-3.5">
          <app-trama-logo [size]="24" />
          <span class="flex flex-col gap-px">
            <span class="font-title text-foreground text-[18px] leading-tight">Trama</span>
            <span class="text-faint font-mono text-[10px]">acme · 6 members</span>
          </span>
          <span class="flex-1"></span>
          <svg [lucideIcon]="chevronsIcon" [size]="13" class="text-faint"></svg>
          <svg [lucideIcon]="panelIcon" [size]="14" class="text-faint"></svg>
        </div>
        <div class="px-3 pb-2.5">
          <div class="bg-background border-border flex h-[30px] items-center gap-2 border px-2">
            <svg [lucideIcon]="searchIcon" [size]="13" class="text-faint"></svg>
            <span class="text-faint font-mono text-[11.5px]">Search or jump…</span>
            <span class="flex-1"></span>
            <span
              class="bg-secondary border-border text-muted-foreground border px-[5px] py-px font-mono text-[10.5px]"
              >⌘K</span
            >
          </div>
        </div>
        <div class="flex flex-col gap-px px-2 py-1.5">
          @for (item of mainNav; track item.label) {
            <div class="flex h-[30px] items-center gap-2.5 px-2.5" [class.bg-hover]="item.current">
              <svg
                [lucideIcon]="item.icon"
                [size]="15"
                [class]="item.current ? 'text-foreground' : 'text-muted-foreground'"
              ></svg>
              <span
                class="text-[13px]"
                [class]="item.current ? 'text-foreground' : 'text-muted-foreground'"
                >{{ item.label }}</span
              >
              <span class="flex-1"></span>
              <span class="text-faint font-mono text-[11px]">{{ item.count }}</span>
            </div>
          }
        </div>
        <div class="flex flex-col gap-px px-2 py-1.5">
          <span class="text-faint pb-0.5 font-mono text-[10px]">PROJECTS</span>
          @for (item of projects; track item.label) {
            <div class="flex h-[30px] items-center gap-2.5 px-2.5">
              <svg [lucideIcon]="item.icon" [size]="15" [class]="item.tone"></svg>
              <span class="text-muted-foreground text-[13px]">{{ item.label }}</span>
              <span class="flex-1"></span>
              <span class="text-faint font-mono text-[11px]">{{ item.count }}</span>
            </div>
          }
        </div>
        <div class="flex flex-col gap-px px-2 py-1.5">
          <span class="text-faint pb-0.5 font-mono text-[10px]">WORKSPACE</span>
          <div class="flex h-[30px] items-center gap-2.5 px-2.5">
            <svg [lucideIcon]="settingsIcon" [size]="15" class="text-muted-foreground"></svg>
            <span class="text-muted-foreground text-[13px]">Settings</span>
          </div>
        </div>
        <div class="flex-1"></div>
        <div class="border-border flex flex-col gap-1 border-t px-3.5 py-2.5">
          <div class="flex items-center gap-2">
            <span class="bg-green size-[7px]"></span>
            <span class="text-foreground font-mono text-[10.5px]">Delta · /trama skill</span>
          </div>
          <span class="text-faint font-mono text-[10px]">last agent sync 4m ago · CLI 1.2</span>
        </div>
        <div class="border-border flex items-center gap-2.5 border-t px-3.5 py-2.5">
          <span
            class="flex size-[22px] items-center justify-center bg-[#2b3a5c] font-mono text-[9.5px] text-[#dce3f7]"
            >AB</span
          >
          <span class="text-foreground text-[12.5px]">Alessandro Bruno</span>
          <span class="flex-1"></span>
          <svg [lucideIcon]="bellIcon" [size]="14" class="text-faint"></svg>
        </div>
      </aside>

      <!-- Main -->
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="border-border flex h-11 shrink-0 items-center gap-2.5 border-b px-5">
          <span class="text-faint truncate font-mono text-[11.5px]"
            >acme / Web app / TRM-128 /</span
          >
          <span class="text-foreground truncate text-[13px]"
            >Rotate OAuth tokens before expiry</span
          >
          <span class="flex-1"></span>
          <div class="flex items-center gap-2 max-md:hidden">
            <span class="bg-red/12 border-red/40 flex items-center gap-2 border py-0.5 pr-1 pl-2">
              <span class="bg-red size-1.5"></span>
              <span class="text-muted-foreground font-mono text-[10.5px]">TRM-128</span>
              <span class="text-foreground font-mono text-[11px]">00:42:13</span>
              <span class="bg-red/20 flex size-[18px] items-center justify-center">
                <span class="bg-foreground size-[7px]"></span>
              </span>
            </span>
            <span
              class="bg-secondary border-border text-foreground flex items-center gap-2 border py-[5px] pr-1.5 pl-2.5 font-mono text-[12px]"
            >
              Share
              <span class="bg-background text-muted-foreground px-[5px] py-px text-[10.5px]"
                >⇧S</span
              >
            </span>
            <span
              class="bg-secondary border-border text-foreground flex items-center gap-2 border py-[5px] pr-1.5 pl-2.5 font-mono text-[12px]"
            >
              Set status
              <span class="bg-background text-muted-foreground px-[5px] py-px text-[10.5px]"
                >S</span
              >
            </span>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 overflow-hidden">
          <div class="flex min-w-0 flex-1 flex-col gap-7 px-5 py-6 md:px-11 md:py-8">
            <!-- Title block -->
            <div class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center gap-2.5">
                <span class="text-muted-foreground font-mono text-[11.5px]">TRM-128</span>
                <span
                  class="bg-secondary text-muted-foreground flex items-center gap-[5px] px-[7px] py-0.5 font-mono text-[10.5px]"
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"
                    />
                    <path d="M9 18c-4.51 2-5-2-7-2" />
                  </svg>
                  acme/web#412
                </span>
                <span class="text-faint font-mono text-[10.5px]">synced 1m ago</span>
              </div>
              <h3
                class="font-title text-foreground text-[28px] leading-tight tracking-[-0.014em] md:text-[36px]"
              >
                Rotate OAuth tokens before expiry
              </h3>
              <p class="text-text-2 text-[14.5px] leading-[22px]">
                GitHub and GitLab tokens expire after 8 hours and the sync silently stops. Refresh
                them before expiry, backfill the ones that already expired, and alert when a refresh
                fails.
              </p>
            </div>

            <!-- Subtasks -->
            <div class="flex flex-col">
              <div class="border-border flex items-end gap-2.5 border-b pb-2">
                <span class="font-title text-foreground text-[20px] leading-tight">Subtasks</span>
                <span class="text-faint font-mono text-[10.5px] max-md:hidden"
                  >2 of 4 done · each subtask can link its own Delta thread</span
                >
                <span class="flex-1"></span>
                <span
                  class="text-muted-foreground flex items-center gap-1.5 px-2.5 py-[5px] font-mono text-[12px]"
                >
                  <svg [lucideIcon]="plusIcon" [size]="13"></svg>
                  Add subtask
                </span>
              </div>
              <div class="bg-secondary h-[3px]">
                <div class="bg-green h-[3px] w-[52%]"></div>
              </div>
              @for (row of subtasks; track row.key) {
                <div class="border-border flex h-[37.5px] items-center gap-2.5 border-b px-3.5">
                  <svg [lucideIcon]="cornerIcon" [size]="13" class="text-faint max-md:hidden"></svg>
                  <span
                    class="flex size-3.5 shrink-0 items-center justify-center border"
                    [class]="row.done ? 'bg-green border-green' : 'border-faint'"
                  >
                    @if (row.done) {
                      <svg [lucideIcon]="checkIcon" [size]="10" class="text-background"></svg>
                    }
                  </span>
                  <span class="text-faint font-mono text-[11px] max-sm:hidden">{{ row.key }}</span>
                  <span class="text-foreground truncate text-[13px]">{{ row.title }}</span>
                  <span class="flex-1"></span>
                  <span
                    class="flex items-center gap-[5px] border px-[7px] py-0.5 font-mono text-[10.5px] whitespace-nowrap max-md:hidden"
                    [class]="
                      row.thread ? 'border-delta-line/40 text-delta' : 'border-border text-faint'
                    "
                  >
                    <span
                      class="size-1.5"
                      [class]="row.thread ? 'bg-delta-line' : 'bg-faint'"
                    ></span>
                    {{ row.thread ? 'Thread linked' : 'No thread' }}
                  </span>
                  <span
                    class="border-border flex items-center gap-[5px] border px-1.5 py-0.5 max-md:hidden"
                  >
                    <span class="text-faint font-mono text-[9.5px]">EST</span>
                    <span class="text-foreground font-mono text-[11px] font-semibold">{{
                      row.est
                    }}</span>
                  </span>
                  <span
                    class="border-border text-foreground flex items-center gap-1.5 border px-2 py-[3px] font-mono text-[11px] whitespace-nowrap"
                  >
                    <span
                      class="size-[7px]"
                      [class]="
                        row.status === 'Done'
                          ? 'bg-green'
                          : row.status === 'In progress'
                            ? 'bg-yellow'
                            : 'bg-muted-foreground'
                      "
                    ></span>
                    {{ row.status }}
                  </span>
                  <span
                    class="flex size-[22px] shrink-0 items-center justify-center font-mono text-[9.5px] text-[#dce3f7]"
                    [style.background]="row.whoBg"
                    >{{ row.who }}</span
                  >
                </div>
              }
            </div>

            <!-- Delta thread -->
            <div class="flex flex-col gap-3">
              <div class="border-border flex items-end gap-2.5 border-b pb-2">
                <span class="font-title text-foreground text-[20px] leading-tight"
                  >Delta thread</span
                >
                <span class="text-faint font-mono text-[10.5px] max-md:hidden"
                  >exactly one per task · linked by the agent via /trama</span
                >
                <span class="flex-1"></span>
                <span class="text-faint font-mono text-[10.5px] max-md:hidden"
                  >linked by Alessandro · Nov 21</span
                >
              </div>
              <div class="bg-card border-border flex flex-col border">
                <div class="border-border flex flex-col gap-2.5 border-b px-[18px] py-4">
                  <div class="flex items-center gap-2.5">
                    <span class="bg-delta-line size-2"></span>
                    <span class="text-delta font-mono text-[10.5px]">DELTA THREAD</span>
                    <span class="flex-1"></span>
                    <span class="text-faint font-mono text-[10.5px]"
                      >read-only · synced 4m ago</span
                    >
                  </div>
                  <span class="font-title text-foreground text-[22px] leading-tight"
                    >Rotate OAuth tokens before expiry</span
                  >
                  <div class="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px]">
                    <span class="text-muted-foreground">th_8f2a19</span>
                    <span class="text-faint">by Alessandro</span>
                    <span class="text-faint">cloud runner</span>
                    <span class="text-faint">38 turns · 6 files</span>
                  </div>
                  <div class="flex gap-2">
                    <span
                      class="bg-secondary border-border text-foreground flex items-center gap-2 border py-[5px] pr-1.5 pl-2.5 font-mono text-[12px]"
                    >
                      Open in Delta ↗
                      <span class="bg-background text-muted-foreground px-[5px] py-px text-[10.5px]"
                        >O</span
                      >
                    </span>
                    <span
                      class="bg-secondary border-border text-foreground flex items-center gap-2 border py-[5px] pr-1.5 pl-2.5 font-mono text-[12px]"
                    >
                      Copy share link
                      <span class="bg-background text-muted-foreground px-[5px] py-px text-[10.5px]"
                        >⇧L</span
                      >
                    </span>
                  </div>
                </div>
                <div class="border-border flex flex-col gap-2 border-b px-[18px] py-3.5">
                  <span class="text-faint font-mono text-[10px]">SUMMARY</span>
                  <p class="text-text-2 text-[13.5px] leading-[1.55]">
                    Added a background scheduler that refreshes OAuth tokens 10 minutes before
                    expiry. Expired tokens now trigger a single retry instead of failing the sync.
                    Covered with integration tests against the GitHub sandbox.
                  </p>
                </div>
                <div class="border-border flex flex-col gap-[7px] border-b px-[18px] py-3.5">
                  <span class="text-faint font-mono text-[10px]">DECISIONS</span>
                  @for (d of decisions; track d) {
                    <div class="flex gap-2">
                      <span class="text-delta-line font-mono text-[11px]">→</span>
                      <span class="text-text-2 text-[13px]">{{ d }}</span>
                    </div>
                  }
                </div>
                <div class="border-border flex flex-col gap-[7px] border-b px-[18px] py-3.5">
                  <span class="text-faint font-mono text-[10px]">KEY EVENTS</span>
                  @for (e of events; track e.at) {
                    <div class="flex gap-3">
                      <span class="text-faint w-[84px] shrink-0 font-mono text-[10.5px]">{{
                        e.at
                      }}</span>
                      <span class="text-text-2 text-[13px]">{{ e.text }}</span>
                    </div>
                  }
                </div>
                <div class="flex flex-col gap-1.5 px-[18px] py-3.5">
                  <div class="flex items-center">
                    <span class="text-faint font-mono text-[10px]">CHANGES VS ORIGIN/MAIN</span>
                    <span class="flex-1"></span>
                    <span class="text-green font-mono text-[10.5px]">+214 −37</span>
                  </div>
                  @for (f of files; track f.path) {
                    <div class="flex items-center gap-2">
                      <svg [lucideIcon]="fileIcon" [size]="12" class="text-faint"></svg>
                      <span class="text-text-2 font-mono text-[11px]">{{ f.path }}</span>
                      <span class="flex-1"></span>
                      <span class="text-faint font-mono text-[10.5px]">{{ f.delta }}</span>
                    </div>
                  }
                  <div class="flex items-center gap-2 pt-2">
                    <svg [lucideIcon]="prIcon" [size]="13" class="text-green"></svg>
                    <span class="text-text-2 font-mono text-[11px]"
                      >acme/web#418 · open · checks passing</span
                    >
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Properties -->
          <div class="bg-card border-border hidden w-[300px] shrink-0 flex-col border-l xl:flex">
            <div class="border-border flex flex-col gap-2 border-b px-[18px] py-3.5">
              <span class="text-foreground font-mono text-[10px]">WORK ON IT IN DELTA</span>
              <span
                class="bg-background border-border text-foreground flex items-center gap-2 border px-2.5 py-2 font-mono text-[12px]"
                >/trama TRM-128</span
              >
            </div>
            <div class="border-border flex items-center gap-2.5 border-b px-[18px] py-2.5">
              <span class="text-faint w-[84px] shrink-0 font-mono text-[10px]">STATUS</span>
              <span
                class="border-border text-foreground flex items-center gap-1.5 border px-2 py-[3px] font-mono text-[11px]"
              >
                <span class="bg-yellow size-[7px]"></span>In progress
              </span>
            </div>
            <div class="border-border flex items-center gap-2.5 border-b px-[18px] py-2.5">
              <span class="text-faint w-[84px] shrink-0 font-mono text-[10px]">PRIORITY</span>
              <span class="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
                <span class="flex h-[11px] items-end gap-0.5">
                  <span class="bg-foreground h-[5px] w-[3px]"></span>
                  <span class="bg-foreground h-2 w-[3px]"></span>
                  <span class="bg-faint h-[11px] w-[3px]"></span>
                </span>
                High
              </span>
            </div>
            <div class="border-border flex items-center gap-2.5 border-b px-[18px] py-2">
              <span class="text-faint w-[84px] shrink-0 font-mono text-[10px]">ASSIGNEE</span>
              <span class="flex items-center gap-1.5">
                <span
                  class="flex size-[22px] items-center justify-center bg-[#2b3a5c] font-mono text-[9.5px] text-[#dce3f7]"
                  >AB</span
                >
                <span class="text-foreground text-[12.5px]">Alessandro</span>
              </span>
            </div>
            <div class="border-border flex items-center gap-2.5 border-b px-[18px] py-2.5">
              <span class="text-faint w-[84px] shrink-0 font-mono text-[10px]">PROJECT</span>
              <span class="flex items-center gap-1.5">
                <span class="bg-red size-2"></span>
                <span class="text-foreground text-[12.5px]">Web app</span>
              </span>
            </div>
            <div class="border-border flex items-center gap-2.5 border-b px-[18px] py-2.5">
              <span class="text-faint w-[84px] shrink-0 font-mono text-[10px]">DUE</span>
              <span class="text-foreground text-[12.5px]">Nov 26 · in 2 days</span>
            </div>
            <div class="border-border flex flex-col gap-2.5 border-b px-[18px] py-3.5">
              <div class="flex items-center gap-2.5">
                <span class="text-faint w-[84px] shrink-0 font-mono text-[10px]">ESTIMATE</span>
                <span class="font-title text-foreground text-[26px] leading-tight">5</span>
                <span
                  class="border-border text-muted-foreground border px-1.5 py-px font-mono text-[10.5px]"
                  >fibonacci</span
                >
              </div>
              <span class="text-muted-foreground font-mono text-[10.5px]"
                >a 5 usually takes ~18h (12–24h) · 31 tasks</span
              >
              <div class="flex flex-col gap-[5px]">
                <div class="flex items-center gap-1.5 font-mono text-[10.5px]">
                  <span class="text-faint text-[10px]">TRACKED</span>
                  <span class="text-foreground">6h 20m</span>
                  <span class="text-faint">of ~18h</span>
                </div>
                <div class="bg-secondary h-1.5">
                  <div class="bg-foreground h-1.5 w-[35%]"></div>
                </div>
              </div>
              <div
                class="bg-primary/7 border-primary/27 text-primary flex items-center gap-2 border px-[9px] py-[7px] font-mono text-[10.5px]"
              >
                <svg [lucideIcon]="treeIcon" [size]="12"></svg>
                subtasks add up to 6 · raise to 8?
              </div>
            </div>
            <div class="border-border flex items-center gap-2.5 border-b px-[18px] py-2.5">
              <span class="text-faint w-[84px] shrink-0 font-mono text-[10px]">LABELS</span>
              <span class="flex gap-1.5">
                <span
                  class="border-border text-muted-foreground border px-1.5 py-px font-mono text-[10.5px]"
                  >auth</span
                >
                <span
                  class="border-border text-muted-foreground border px-1.5 py-px font-mono text-[10.5px]"
                  >sync</span
                >
              </span>
            </div>
            <div class="border-border flex items-center gap-2.5 border-b px-[18px] py-2.5">
              <span class="text-faint w-[84px] shrink-0 font-mono text-[10px]">SOURCE</span>
              <span class="text-foreground font-mono text-[11px]">acme/web#412 ↗</span>
            </div>
            <div class="border-border flex items-center gap-2.5 border-b px-[18px] py-2.5">
              <span class="text-faint w-[84px] shrink-0 font-mono text-[10px]">THREAD</span>
              <span class="flex items-center gap-1.5">
                <span class="bg-delta-line size-1.5"></span>
                <span class="text-delta font-mono text-[11px]">th_8f2a19 ↗</span>
              </span>
            </div>
            <div class="flex flex-col gap-1.5 px-[18px] py-3.5">
              <span class="text-foreground font-mono text-[10px]">ONE THREAD PER TASK</span>
              <p class="text-muted-foreground text-[12px] leading-[19px]">
                To relink, run /trama TRM-128 in a new Delta thread — the agent will offer to create
                a subtask instead. Need parallel work? Use subtasks.
              </p>
            </div>
            <div class="flex flex-col gap-1 px-[18px] py-1.5">
              <span class="text-faint font-mono text-[10.5px]">Created Nov 20 by GitHub sync</span>
              <span class="text-faint font-mono text-[10.5px]">Updated 4m ago</span>
            </div>
          </div>
        </div>

        <!-- Status bar -->
        <div
          class="border-border hidden h-7 shrink-0 items-center gap-4 border-t px-4 font-mono text-[10.5px] lg:flex"
        >
          <span class="text-faint flex items-center gap-1.5">
            <span class="bg-green size-1.5"></span>Agent sync 4m ago
          </span>
          <span class="text-faint">GitHub · GitLab · Jira synced 1m ago</span>
          <span class="flex-1"></span>
          <span
            class="bg-primary/10 border-primary/40 text-foreground flex items-center gap-1.5 border py-0.5 pr-1.5 pl-2"
          >
            <svg [lucideIcon]="sparklesIcon" [size]="11" class="text-primary"></svg>
            Ask Trama
            <span class="bg-secondary text-muted-foreground px-1 text-[10px]">⌘J</span>
          </span>
          <span class="text-faint">? shortcuts &nbsp; ⌘K command</span>
          <span class="bg-red/12 border-red/40 flex items-center gap-2 border py-0.5 pr-1 pl-2">
            <span class="bg-red size-1.5"></span>
            <span class="text-muted-foreground">TRM-128</span>
            <span class="text-foreground text-[11px]">00:42:13</span>
            <span class="bg-red/20 flex size-[18px] items-center justify-center">
              <span class="bg-foreground size-[7px]"></span>
            </span>
          </span>
        </div>
      </div>
    </div>
    <div class="border-border pointer-events-none absolute inset-0 border"></div>
  `,
})
export class LandingProductShot {
  protected readonly panelIcon = LucidePanelLeft;
  protected readonly chevronsIcon = LucideChevronsUpDown;
  protected readonly searchIcon = LucideSearch;
  protected readonly bellIcon = LucideBell;
  protected readonly sparklesIcon = LucideSparkles;
  protected readonly settingsIcon = LucideSettings;
  protected readonly plusIcon = LucidePlus;
  protected readonly cornerIcon = LucideCornerDownRight;
  protected readonly checkIcon = LucideCheck;
  protected readonly fileIcon = LucideFileCode;
  protected readonly prIcon = LucideGitPullRequest;
  protected readonly treeIcon = LucideListTree;

  protected readonly mainNav: readonly NavItem[] = [
    { label: 'Home', icon: LucideHouse },
    { label: 'Inbox', icon: LucideInbox, count: '4' },
    { label: 'My tasks', icon: LucideCircleUser, count: '9' },
    { label: 'Tasks', icon: LucideListChecks, count: '128', current: true },
    { label: 'Board', icon: LucideSquareKanban },
    { label: 'Timeline', icon: LucideChartGantt },
    { label: 'Time', icon: LucideTimer, count: '6h 20m' },
    { label: 'Ask', icon: LucideSparkles },
  ];

  protected readonly projects: readonly {
    label: string;
    count: string;
    icon: LucideIcon;
    tone: string;
  }[] = [
    { label: 'Web app', count: '42', icon: LucideGlobe, tone: 'text-red' },
    { label: 'API', count: '31', icon: LucideBraces, tone: 'text-delta-line' },
    { label: 'Mobile', count: '18', icon: LucideSmartphone, tone: 'text-green' },
  ];

  protected readonly subtasks: readonly SubtaskRow[] = [
    {
      key: 'TRM-128.1',
      title: 'Add refresh scheduler',
      done: true,
      thread: true,
      est: 1,
      status: 'Done',
      who: 'AB',
      whoBg: '#2b3a5c',
    },
    {
      key: 'TRM-128.2',
      title: 'Backfill expired tokens',
      done: false,
      thread: true,
      est: 2,
      status: 'In progress',
      who: 'LS',
      whoBg: '#2e4430',
    },
    {
      key: 'TRM-128.3',
      title: 'Alerting when refresh fails',
      done: false,
      thread: false,
      est: 2,
      status: 'Todo',
      who: 'AB',
      whoBg: '#2b3a5c',
    },
    {
      key: 'TRM-128.4',
      title: 'Docs: token lifecycle',
      done: true,
      thread: false,
      est: 1,
      status: 'Done',
      who: 'MR',
      whoBg: '#4a2c26',
    },
  ];

  protected readonly decisions: readonly string[] = [
    'Refresh window is 10 min, configurable per provider',
    'Keep tokens encrypted at rest (KMS), never in logs',
    'No retry storm: max 1 retry, then mark integration degraded',
  ];

  protected readonly events: readonly { at: string; text: string }[] = [
    { at: 'Nov 21 10:02', text: 'Thread started from TRM-128' },
    { at: 'Nov 21 11:40', text: 'Subagent Scout mapped token usage' },
    { at: 'Nov 22 09:15', text: 'Reviewer: approved with 2 notes' },
    { at: 'Nov 22 16:30', text: 'PR #418 opened' },
  ];

  protected readonly files: readonly ChangedFile[] = [
    { path: 'src/auth/refresh.ts', delta: '+128 −4' },
    { path: 'src/auth/store.ts', delta: '+41 −22' },
    { path: 'src/sync/github.ts', delta: '+19 −11' },
    { path: 'test/auth/refresh.test.ts', delta: '+26 −0' },
  ];
}
