import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMail } = vi.hoisted(() => ({
  sendMail: vi.fn().mockResolvedValue({ accepted: ['recipient@example.com'] }),
}));

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({ sendMail })),
}));

import { MailService } from './mail.service.js';

describe('MailService', () => {
  beforeEach(() => {
    vi.stubEnv('SMTP_URL', 'smtp://localhost');
    vi.stubEnv('MAIL_FROM', 'Trama <mail@example.com>');
    sendMail.mockClear();
  });

  it('sends only the explicit Mail fields using Nodemailer 10 sendMail', async () => {
    const mail = Object.assign(
      {
        to: 'recipient@example.com',
        subject: 'Invitation',
        text: 'Join Trama',
        html: '<p>Join Trama</p>',
      },
      { raw: 'unexpected', attachments: [{ path: '/etc/passwd' }] },
    );

    expect(await new MailService().send(mail)).toBe(true);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Trama <mail@example.com>',
      to: 'recipient@example.com',
      subject: 'Invitation',
      text: 'Join Trama',
      html: '<p>Join Trama</p>',
    });
  });
});
