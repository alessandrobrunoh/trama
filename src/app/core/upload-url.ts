/** Keep in step with `server/src/uploads/upload-rules.ts`. */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export const UPLOAD_ACCEPT =
  '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.docx,.xlsx,.pptx';

const EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'txt',
  'md',
  'csv',
  'json',
  'docx',
  'xlsx',
  'pptx',
]);

/** A same-origin upload path. Remote addresses are not loaded as images. */
export function isWorkspaceUploadUrl(url: string | null | undefined): boolean {
  return !!url && /^\/api\/w\/[a-z0-9][a-z0-9-]{0,39}\/uploads\/upl_[a-z0-9]{10,24}$/.test(url);
}

export function uploadIdsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/\/uploads\/(upl_[a-z0-9]{10,24})\b/g)].map((match) => match[1]);
}

/** A message when the browser can already tell the file will be rejected. The server checks the bytes. */
export function clientUploadError(file: File): string | null {
  if (file.size <= 0) return 'The file is empty';
  if (file.size > UPLOAD_MAX_BYTES) return 'File is larger than 8 MB';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!EXT.has(ext))
    return 'This file type is not allowed. Use an image, PDF, text or Office document.';
  return null;
}
