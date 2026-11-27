import { ConflictException } from '@nestjs/common';
import { THREAD_ALREADY_LINKED } from '../contracts/domain.js';

/** Body of the 409 returned when a task already links a different thread. */
export interface ThreadAlreadyLinkedBody {
  statusCode: 409;
  error: 'Conflict';
  code: typeof THREAD_ALREADY_LINKED;
  message: string;
  /** The thread the task links today. */
  threadUrl: string;
}

/** The 409 for a task that already links `current`. */
export function threadAlreadyLinked(key: string, current: string): ConflictException {
  const body: ThreadAlreadyLinkedBody = {
    statusCode: 409,
    error: 'Conflict',
    code: THREAD_ALREADY_LINKED,
    message: `${key} is already linked to a thread (${current}). Unlink it first, or create a subtask and link that.`,
    threadUrl: current,
  };
  return new ConflictException(body);
}

/**
 * One task links at most one thread. Linking the same URL again is a no-op, `null` unlinks, and a
 * different URL is refused while one is linked.
 */
export function assertThreadLinkable(
  key: string,
  current: string | null | undefined,
  next: string | null | undefined,
): void {
  if (typeof next !== 'string' || !current || current === next) return;
  throw threadAlreadyLinked(key, current);
}
