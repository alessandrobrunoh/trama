import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
  BadRequestException,
  StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  Auth,
  Ctx,
  Multipart,
  Roles,
  type AuthInfo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import {
  contentDisposition,
  UPLOAD_MAX_BYTES,
  type UploadCaller,
} from './upload-rules.js';
import { UploadExceptionFilter } from './upload-exception.filter.js';
import { UploadsService, type IncomingUpload } from './uploads.service.js';

function memoryStorage() {
  return {
    _handleFile(
      _req: unknown,
      file: { stream: NodeJS.ReadableStream },
      cb: (
        error: Error | null,
        info?: { buffer: Buffer; size: number },
      ) => void,
    ) {
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      file.stream.on('data', (chunk: Buffer | string) => {
        if (failed) return;
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += buf.length;
        if (size > UPLOAD_MAX_BYTES) {
          failed = true;
          file.stream.resume();
          cb(
            Object.assign(new Error('File too large'), {
              code: 'LIMIT_FILE_SIZE',
            }),
          );
          return;
        }
        chunks.push(buf);
      });
      file.stream.on('error', (err: Error) => {
        if (!failed) cb(err);
      });
      file.stream.on('end', () => {
        if (failed) return;
        const buffer = Buffer.concat(chunks);
        cb(null, { buffer, size: buffer.length });
      });
    },
    _removeFile(_req: unknown, _file: unknown, cb: (error: null) => void) {
      cb(null);
    },
  };
}

const uploadFile = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
  defParamCharset: 'utf8',
});

function callerOf(ctx: WorkspaceContext, auth: AuthInfo): UploadCaller {
  return {
    actor: ctx.actor,
    role: ctx.role,
    permissions:
      auth.token?.scope === 'custom' ? (auth.token.permissions ?? []) : null,
  };
}

function asFile(file: IncomingUpload | undefined): IncomingUpload {
  if (!file?.buffer?.length)
    throw new BadRequestException('Choose a file to upload');
  return file;
}

@Controller('w/:slug')
@UseFilters(UploadExceptionFilter)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /** A file to insert into a description or a comment. It is not fetchable by anyone else until that text is saved. */
  @Post('uploads')
  @Multipart()
  @Roles('viewer')
  @UseInterceptors(uploadFile)
  stage(
    @Ctx() ctx: WorkspaceContext,
    @Auth() auth: AuthInfo,
    @UploadedFile() file: IncomingUpload,
  ) {
    return this.uploads.stage(
      ctx.workspace.id,
      ctx.workspace.slug,
      callerOf(ctx, auth),
      asFile(file),
    );
  }

  @Post('issues/:idOrKey/artifacts/upload')
  @Multipart()
  @UseInterceptors(uploadFile)
  uploadOnIssue(
    @Ctx() ctx: WorkspaceContext,
    @Auth() auth: AuthInfo,
    @Param('idOrKey') issueId: string,
    @UploadedFile() file: IncomingUpload,
  ) {
    return this.uploads.attachArtifact(
      ctx.workspace.id,
      ctx.workspace.slug,
      callerOf(ctx, auth),
      asFile(file),
      { issueId },
    );
  }

  @Post('projects/:id/artifacts/upload')
  @Multipart()
  @UseInterceptors(uploadFile)
  uploadOnProject(
    @Ctx() ctx: WorkspaceContext,
    @Auth() auth: AuthInfo,
    @Param('id') projectId: string,
    @UploadedFile() file: IncomingUpload,
  ) {
    return this.uploads.attachArtifact(
      ctx.workspace.id,
      ctx.workspace.slug,
      callerOf(ctx, auth),
      asFile(file),
      {
        projectId,
      },
    );
  }

  @Get('uploads/:id')
  async open(
    @Ctx() ctx: WorkspaceContext,
    @Auth() auth: AuthInfo,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.uploads.open(
      ctx.workspace.id,
      id,
      callerOf(ctx, auth),
    );
    const kind = row.contentType.startsWith('image/') ? 'image' : 'file';
    res.setHeader('Content-Type', row.contentType);
    res.setHeader(
      'Content-Disposition',
      contentDisposition(kind, row.filename),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(row.bytes);
  }

  @Delete('uploads/:id')
  @Roles('viewer')
  @HttpCode(204)
  discard(
    @Ctx() ctx: WorkspaceContext,
    @Auth() auth: AuthInfo,
    @Param('id') id: string,
  ) {
    return this.uploads.discard(ctx.workspace.id, callerOf(ctx, auth), id);
  }
}
