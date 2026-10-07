import { ValidateIf } from 'class-validator';

/** Optional, but `null` is rejected (for required fields in PATCH bodies). */
export const OptionalNotNull = () =>
  ValidateIf((_obj: object, value: unknown) => value !== undefined);

/** Optional and nullable (PATCH: `null` clears the field). */
export const Clearable = () =>
  ValidateIf((_obj: object, value: unknown) => value !== undefined && value !== null);
