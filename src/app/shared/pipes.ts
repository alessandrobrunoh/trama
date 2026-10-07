import { Pipe, type PipeTransform } from '@angular/core';
import { fullDate, relativeTime, shortDate } from '../core/format';

/** `{{ iso | relativeTime }}` → "3h ago". Pure; pair with `[title]`-free <app-tooltip> if you need the exact time. */
@Pipe({ name: 'relativeTime' })
export class RelativeTimePipe implements PipeTransform {
  transform(value: string | undefined | null): string {
    return value ? relativeTime(value) : '';
  }
}

/** `{{ iso | shortDate }}` → "Oct 7". */
@Pipe({ name: 'shortDate' })
export class ShortDatePipe implements PipeTransform {
  transform(value: string | undefined | null): string {
    return value ? shortDate(value) : '';
  }
}

/** `{{ iso | fullDate }}` → "Oct 7, 2026". */
@Pipe({ name: 'fullDate' })
export class FullDatePipe implements PipeTransform {
  transform(value: string | undefined | null): string {
    return value ? fullDate(value) : '';
  }
}
