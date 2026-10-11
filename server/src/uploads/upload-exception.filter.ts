import {
  BadRequestException,
  Catch,
  PayloadTooLargeException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { UPLOAD_MAX_BYTES } from './upload-rules.js';

function limitCode(exception: unknown): string {
  if (!exception || typeof exception !== 'object' || !('code' in exception))
    return '';
  return String((exception as { code: unknown }).code);
}

/** Turns multer's size and shape errors into API errors instead of a 500. */
@Catch()
export class UploadExceptionFilter
  extends BaseExceptionFilter
  implements ExceptionFilter
{
  override catch(exception: unknown, host: ArgumentsHost): void {
    const code = limitCode(exception);
    if (code === 'LIMIT_FILE_SIZE') {
      super.catch(
        new PayloadTooLargeException(
          `File is larger than ${UPLOAD_MAX_BYTES} bytes`,
        ),
        host,
      );
      return;
    }
    if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE') {
      super.catch(
        new BadRequestException('Upload a single file in the "file" field'),
        host,
      );
      return;
    }
    super.catch(exception, host);
  }
}
