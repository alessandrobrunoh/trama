import { Injectable, Logger } from '@nestjs/common';

export interface WorkstreamTouched {
  workspaceId: string;
  workstreamId: string;
  /** What changed, e.g. `execution.state_changed`, `artifact.updated`, `workstream.updated`. */
  reason: string;
}

export type WorkstreamTouchedHandler = (event: WorkstreamTouched) => void | Promise<void>;

/**
 * In-process bus fired after ANY change to a workstream or to its executions,
 * input requests, artifacts, decisions, dependencies (both ends) and criteria.
 * Domain services `await bus.touch(...)` after persisting; handlers run
 * sequentially, errors are logged and never fail the request.
 *
 * The status engine subscribes with `onTouched()` (e.g. in `onModuleInit`),
 * recomputes `status` / `derivedStatus` / `shippedAt` on the workstream row,
 * and may call `EventsService.record(...)` / `publish(...)`.
 */
@Injectable()
export class WorkstreamBus {
  private readonly logger = new Logger(WorkstreamBus.name);
  private readonly handlers = new Set<WorkstreamTouchedHandler>();

  /** Returns an unsubscribe function. */
  onTouched(handler: WorkstreamTouchedHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async touch(workspaceId: string, workstreamId: string, reason: string): Promise<void> {
    const event: WorkstreamTouched = { workspaceId, workstreamId, reason };
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.error(`WorkstreamTouched handler failed: ${(error as Error).message}`);
      }
    }
  }

  async touchMany(workspaceId: string, workstreamIds: Iterable<string>, reason: string): Promise<void> {
    for (const id of new Set(workstreamIds)) await this.touch(workspaceId, id, reason);
  }
}
