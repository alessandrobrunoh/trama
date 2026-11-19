import { ValidateBy, ValidateIf, buildMessage } from 'class-validator';
import { ISSUE_THREAD_URL_MAX, isThreadUrl } from '../contracts/domain.js';

/** An `http(s)` URL of at most 2048 characters (`Issue.threadUrl`). */
export const IsThreadUrl = () =>
  ValidateBy({
    name: 'isThreadUrl',
    validator: {
      validate: (value: unknown) => isThreadUrl(value),
      defaultMessage: buildMessage(
        (eachPrefix) =>
          `${eachPrefix}$property must be an http or https URL of at most ${ISSUE_THREAD_URL_MAX} characters`,
      ),
    },
  });

/** Optional, but `null` is rejected (for required fields in PATCH bodies). */
export const OptionalNotNull = () =>
  ValidateIf((_obj: object, value: unknown) => value !== undefined);

/** Optional and nullable (PATCH: `null` clears the field). */
export const Clearable = () =>
  ValidateIf((_obj: object, value: unknown) => value !== undefined && value !== null);
