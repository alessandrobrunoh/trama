import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AppRequest } from './request-context.js';
import { memberAccessStore } from './member-access.js';
import { uploadCallerStore } from './upload-caller.js';

/** Makes `currentAccess()` visible to services for the rest of this request. */
@Injectable()
export class MemberAccessInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<AppRequest>();
    const access = req.ctx?.access ?? null;
    const caller = req.ctx
      ? {
          actor: req.ctx.actor,
          role: req.ctx.role,
          permissions:
            req.auth?.token?.scope === 'custom'
              ? (req.auth.token.permissions ?? [])
              : null,
        }
      : null;
    return new Observable((subscriber) => {
      const forward = () => {
        const sub = next.handle().subscribe(subscriber);
        return () => sub.unsubscribe();
      };
      return memberAccessStore.run(access, () =>
        caller ? uploadCallerStore.run(caller, forward) : forward(),
      );
    });
  }
}
