import { HttpErrorResponse } from '@angular/common/http';

/** Normalised error thrown by every ApiClient call. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    /** HTTP status; 0 = network failure / server unreachable. */
    readonly status: number,
    message: string,
    /** Machine code from the server body (`code`/`error`), when present. */
    readonly code?: string,
    /** Field-level validation messages, when the server sends them. */
    readonly details?: Record<string, string> | string[],
  ) {
    super(message);
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isValidation(): boolean {
    return this.status === 400 || this.status === 422;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }

  static from(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) return new ApiError(0, 'Cannot reach the Trama server');
      const body: unknown = error.error;
      let message = error.statusText || `Request failed (${error.status})`;
      let code: string | undefined;
      let details: ApiError['details'];
      if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        const m = b['message'];
        if (typeof m === 'string') message = m;
        else if (Array.isArray(m) && m.every((x) => typeof x === 'string')) {
          message = m.join('; ');
          details = m as string[];
        } else if (typeof b['error'] === 'string') message = b['error'] as string;
        if (typeof b['code'] === 'string') code = b['code'];
        else if (typeof b['error'] === 'string' && typeof m === 'string') code = b['error'] as string;
        if (b['details'] && typeof b['details'] === 'object') {
          details = b['details'] as Record<string, string>;
        }
      } else if (typeof body === 'string' && body.trim() && body.length < 300) {
        message = body;
      }
      return new ApiError(error.status, message, code, details);
    }
    return new ApiError(0, error instanceof Error ? error.message : 'Unexpected error');
  }
}
