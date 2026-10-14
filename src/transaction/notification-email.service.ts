import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

const TIMEOUT_MS = 8000;

export type EmailSendResult = { ok: true } | { ok: false; error: EmailErrorCode };
export type EmailErrorCode = 'not_configured' | 'timeout' | 'network' | 'provider_error';

class TimeoutError extends Error {}

/** Minimal surface of the Resend client this service uses (lets tests fake it). */
export interface ResendLike {
  emails: {
    send(
      payload: { from: string; to: string; subject: string; text: string; html: string },
      options?: { idempotencyKey?: string },
    ): Promise<{ error: { name?: string; statusCode?: number | null } | null }>;
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ??
      character,
  );
}

/**
 * Sends the ledger notification email through Resend (RESEND_API_KEY and
 * RESEND_FROM_EMAIL, the same settings as the verification emails).
 * Logs only the entry id and status codes; never addresses or message text.
 */
@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);
  private readonly client: ResendLike | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY');
    this.client = apiKey ? (new Resend(apiKey) as unknown as ResendLike) : null;
    this.from = config.get<string>('RESEND_FROM_EMAIL', 'Kaapy <no-reply@relaysms.cloud>');
  }

  /** For tests: swap in a fake client. */
  static withClient(client: ResendLike | null, from = 'Kaapy <test@example.com>'): NotificationEmailService {
    const service = Object.create(NotificationEmailService.prototype) as NotificationEmailService;
    Object.assign(service, { client, from, logger: new Logger(NotificationEmailService.name) });
    return service;
  }

  async send(params: {
    transactionId: string;
    to: string;
    /** Already in the message language (see buildEmailSubject). */
    subject: string;
    text: string;
  }): Promise<EmailSendResult> {
    if (!this.client) {
      this.logger.warn(`Notification email skipped for entry ${params.transactionId}: not configured`);
      return { error: 'not_configured', ok: false };
    }

    const payload = {
      from: this.from,
      // Plain HTML, no links, no images, no tracking.
      html: `<p>${escapeHtml(params.text)}</p>`,
      subject: params.subject,
      text: params.text,
      to: params.to,
    };
    // Same key on the retry: Resend delivers at most one email per entry.
    const options = { idempotencyKey: `kaapy-entry-${params.transactionId}` };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { error } = await this.withTimeout(this.client.emails.send(payload, options));
        if (!error) return { ok: true };
        this.logger.warn(
          `Notification email failed for entry ${params.transactionId}: provider status ${error.statusCode ?? 'n/a'}`,
        );
        return { error: 'provider_error', ok: false };
      } catch (error) {
        if (error instanceof TimeoutError) {
          // Don't retry a timeout: the first request may still be delivering.
          this.logger.warn(`Notification email timed out for entry ${params.transactionId}`);
          return { error: 'timeout', ok: false };
        }
        // A network error: one quick retry.
        if (attempt === 2) {
          this.logger.warn(`Notification email network error for entry ${params.transactionId}`);
          return { error: 'network', ok: false };
        }
      }
    }
    return { error: 'network', ok: false };
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutError()), TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
