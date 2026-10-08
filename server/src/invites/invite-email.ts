import type { Role } from '../contracts/domain.js';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface InviteEmailInput {
  workspaceName: string;
  /** Absent when the inviter's account was deleted. */
  inviterName?: string;
  role: Role;
  url: string;
  expiresAt: Date;
}

/** Subject, plain text and a small HTML version of the invitation email. */
export function renderInviteEmail(input: InviteEmailInput): { subject: string; text: string; html: string } {
  const who = input.inviterName ? `${input.inviterName} invited you` : 'You were invited';
  const subject = `${who} to ${input.workspaceName} on Trama`;
  const expires = input.expiresAt.toISOString().slice(0, 10);
  const text = [
    `${who} to join "${input.workspaceName}" on Trama as ${input.role}.`,
    '',
    `Accept the invitation: ${input.url}`,
    '',
    `The link works until ${expires} and only for this email address. If you did not expect it, you can ignore this message.`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f6;font-family:Inter,Segoe UI,Roboto,sans-serif;color:#1b1c1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e8e8ec;border-radius:12px;padding:32px">
<tr><td>
<p style="margin:0 0 16px;font-size:15px;font-weight:600;letter-spacing:-0.01em">Trama</p>
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;letter-spacing:-0.02em">${escapeHtml(who)} to ${escapeHtml(input.workspaceName)}</h1>
<p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#6c6e75">You will join the workspace as <strong style="color:#1b1c1f">${escapeHtml(input.role)}</strong>.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#b5583a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 18px;border-radius:8px">Accept invitation</a></p>
<p style="margin:0;font-size:12px;line-height:1.6;color:#6c6e75">The link works until ${expires} and only for this email address. If you did not expect this message, you can ignore it.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}
