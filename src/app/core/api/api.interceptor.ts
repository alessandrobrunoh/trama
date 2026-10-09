import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { API_BASE_URL } from '../config';
import { CLIENT_ID } from '../sync/client-id';

/**
 * For requests to the Trama API: send the session cookie (`withCredentials`) and tag every
 * write with `X-Client-Id` so the server echoes it back on the SSE stream and this tab can
 * ignore its own changes.
 */
export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const base = inject(API_BASE_URL).replace(/\/$/, '');
  if (!req.url.startsWith(base)) return next(req);
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  return next(
    req.clone({
      withCredentials: true,
      setHeaders: write ? { 'X-Client-Id': CLIENT_ID } : {},
    }),
  );
};
