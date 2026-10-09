import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { CountersService } from '../common/counters.service.js';
import { EventsService } from '../events/events.service.js';
import { HttpClient } from '../integrations/http-client.js';
import { MilestonesService } from '../milestones/milestones.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { TeamsService } from '../teams/teams.service.js';
import { CredentialsService, createAdapter } from './credentials.service.js';
import { ImportJobEntity } from './entities.js';
import { ImportEngine, ImportFatalError, MAX_STORED_ERRORS, emptyProgress, type EngineHooks, type EngineState } from './import-engine.js';
import { TypeormImportSink } from './import-sink.js';
import { redactSecrets } from './mapping.js';

/** A runner that has not touched its job for this long is considered gone; another one takes the job over. */
const STALE_AFTER_SECONDS = 90;
const SWEEP_EVERY_MS = 30_000;
/** Waits up to this long inside the process; longer rate-limit windows hand the job back to the queue. */
const MAX_INLINE_WAIT_MS = 10 * 60_000;
const WAIT_SLICE_MS = 5_000;

/** The rows of an `UPDATE ... RETURNING` result whatever shape the driver gave it (`rows` or `[rows, count]`). */
export function claimedRows(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  return Array.isArray(result[0]) ? (result[0] as unknown[]) : result;
}

const sleep =(ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Runs import jobs in the background of the API process. Jobs are rows: a restart (or a second instance)
 * picks queued and stale ones up and continues from the stored cursor. Nothing here logs a token.
 */
@Injectable()
export class ImportRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ImportRunnerService.name);
  private readonly active = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(
    private readonly ds: DataSource,
    private readonly http: HttpClient,
    private readonly credentials: CredentialsService,
    private readonly events: EventsService,
    private readonly counters: CountersService,
    private readonly teams: TeamsService,
    private readonly projects: ProjectsService,
    private readonly milestones: MilestonesService,
    @InjectRepository(ImportJobEntity) private readonly jobs: Repository<ImportJobEntity>,
  ) {}

  onModuleInit(): void {
    // Unit tests build the module without a database; the sweep is for the real process.
    if (process.env.VITEST || process.env.TRAMA_IMPORT_RUNNER === 'off') return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Starts every queued or abandoned job this process is not already running. */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    const rows = await this.jobs.find({ where: [{ status: 'queued' }, { status: 'running' }], select: { id: true } }).catch(() => []);
    for (const { id } of rows) if (!this.active.has(id)) void this.kick(id);
  }

  /** Claims the job (atomically, so two instances never run it) and runs it in the background. */
  async kick(id: string): Promise<boolean> {
    if (this.active.has(id) || this.stopping) return false;
    // An UPDATE ... RETURNING comes back from TypeORM as `[rows, affectedCount]`, not as the rows.
    const result = await this.ds.query<unknown>(
      `UPDATE "import_jobs" SET "status" = 'running', "heartbeatAt" = now(), "startedAt" = COALESCE("startedAt", now())
       WHERE "id" = $1 AND (
         ("status" = 'queued' AND ("waitingUntil" IS NULL OR "waitingUntil" <= now()))
         OR ("status" = 'running' AND ("heartbeatAt" IS NULL OR "heartbeatAt" < now() - make_interval(secs => $2)))
       ) RETURNING "id"`,
      [id, STALE_AFTER_SECONDS],
    );
    if (!claimedRows(result).length) return false;
    this.active.add(id);
    void this.execute(id)
      .catch((e: unknown) => this.log.error(`Import ${id} crashed: ${redactSecrets(e instanceof Error ? e.message : String(e))}`))
      .finally(() => this.active.delete(id));
    return true;
  }

  private async finish(job: ImportJobEntity, status: 'completed' | 'failed' | 'canceled', lastError?: string) {
    await this.jobs.update(
      { id: job.id },
      { status, finishedAt: new Date(), waitingUntil: null, lastError: lastError ?? null, cursor: status === 'completed' ? null : job.cursor },
    );
    await this.events.record({
      workspaceId: job.workspaceId,
      actor: job.createdBy,
      type: `import.${status}`,
      subject: { type: 'import', id: job.id },
      data: { provider: job.provider, source: job.sourceLabel, ...job.progress, error: lastError },
    });
  }

  private async execute(id: string): Promise<void> {
    const job = await this.jobs.findOneBy({ id });
    if (!job) return;
    let token: string | null = null;
    try {
      const cred = await this.credentials.resolve(job.workspaceId, job.provider, job.credential);
      token = cred.token;
      const adapter = createAdapter(this.http, job.provider, cred, job.source);
      const sink = new TypeormImportSink(
        { ds: this.ds, counters: this.counters, teams: this.teams, projects: this.projects, milestones: this.milestones },
        job.workspaceId,
        job.createdBy,
        job.id,
        job.provider,
      );
      const state: EngineState = {
        phase: job.cursor?.phase ?? 'setup',
        cursor: job.cursor?.cursor ?? null,
        plan: job.cursor?.plan,
        progress: { ...emptyProgress(), ...job.progress },
        errors: job.errors ?? [],
      };
      const hooks: EngineHooks = {
        now: () => new Date(),
        sleep,
        checkpoint: async (s) => {
          job.progress = s.progress;
          job.errors = s.errors.slice(0, MAX_STORED_ERRORS);
          job.cursor = { phase: s.phase, cursor: s.cursor, plan: s.plan };
          await this.jobs.update(
            { id: job.id },
            { progress: job.progress, errors: job.errors, cursor: job.cursor, heartbeatAt: new Date(), waitingUntil: null },
          );
        },
        onDiscovery: async (d) => {
          job.sourceLabel = d.sourceLabel.slice(0, 200);
          await this.jobs.update({ id: job.id }, { sourceLabel: job.sourceLabel });
        },
        isCanceled: async () => !!(await this.jobs.findOne({ where: { id: job.id }, select: { id: true, cancelRequested: true } }))?.cancelRequested,
        wait: async (until) => {
          const ms = until.getTime() - Date.now();
          if (ms > MAX_INLINE_WAIT_MS) {
            // Too long to hold on to: park the job; the sweep resumes it once the window has passed.
            await this.jobs.update({ id: job.id }, { status: 'queued', waitingUntil: until, heartbeatAt: null });
            return 'release';
          }
          await this.jobs.update({ id: job.id }, { waitingUntil: until });
          while (Date.now() < until.getTime()) {
            if (this.stopping) return 'release';
            if (await hooks.isCanceled()) return 'resume';
            await sleep(Math.min(WAIT_SLICE_MS, Math.max(250, until.getTime() - Date.now())));
            await this.jobs.update({ id: job.id }, { heartbeatAt: new Date() });
          }
          await this.jobs.update({ id: job.id }, { waitingUntil: null });
          return 'resume';
        },
      };
      const outcome = await new ImportEngine(job.provider, adapter, sink, job.mapping, job.options, hooks, [token ?? '']).run(state);
      if (outcome === 'completed') await this.finish(job, 'completed');
      else if (outcome === 'canceled') await this.finish(job, 'canceled');
      // 'released': the job is already queued again with its waitingUntil.
    } catch (e) {
      const message = redactSecrets(e instanceof Error ? e.message : String(e), [token]).slice(0, 500);
      if (!(e instanceof ImportFatalError)) this.log.warn(`Import ${job.id} failed: ${message}`);
      await this.finish(job, 'failed', message);
    }
  }
}
