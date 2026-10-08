import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Outgoing email over SMTP. Configure with `SMTP_URL` (e.g. `smtp://user:pass@smtp.example.com:587`,
 * `smtps://…` for implicit TLS) and optionally `MAIL_FROM` ("Trama <no-reply@example.com>").
 * Without `SMTP_URL` nothing is sent: callers get `false` and show the link in the UI instead.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private readonly transport: Transporter | null;
  private readonly from: string;

  constructor() {
    const url = process.env.SMTP_URL?.trim();
    this.transport = url ? createTransport(url) : null;
    this.from = process.env.MAIL_FROM?.trim() || 'Trama <no-reply@localhost>';
    if (!this.transport) this.log.log('SMTP_URL is not set: emails are not sent');
  }

  get enabled(): boolean {
    return this.transport !== null;
  }

  /** True when the message was accepted by the SMTP server. Never throws: failures are logged. */
  async send(mail: Mail): Promise<boolean> {
    if (!this.transport) return false;
    try {
      await this.transport.sendMail({ from: this.from, ...mail });
      return true;
    } catch (e) {
      this.log.warn(`Could not send "${mail.subject}": ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
