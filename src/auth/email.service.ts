import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.from = this.config.get<string>(
      'RESEND_FROM_EMAIL',
      'Kaapy <no-reply@relaysms.cloud>',
    );
  }

  async sendVerificationCode(
    email: string,
    fullName: string,
    code: string,
  ): Promise<void> {
    await this.send(
      email,
      'Verify your Kaapy shop Gmail',
      `<p>Hello ${this.escape(fullName)},</p>
       <p>Your Kaapy Gmail verification code is:</p>
       <p><strong>${this.escape(code)}</strong></p>
       <p>This code expires in 10 minutes.</p>`,
    );
  }

  async sendPasswordResetCode(email: string, code: string): Promise<void> {
    await this.send(
      email,
      'Reset your Kaapy password',
      `<p>Use this code to reset your Kaapy password:</p>
       <p><strong>${this.escape(code)}</strong></p>
       <p>This code expires in 10 minutes.</p>`,
    );
  }

  private async send(
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    if (!this.resend) {
      throw new ServiceUnavailableException('Email service is not configured');
    }

    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html,
    });

    if (error) {
      throw new ServiceUnavailableException('Unable to send email');
    }
  }

  private escape(value: string): string {
    return value.replace(
      /[&<>'"]/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          "'": '&#39;',
          '"': '&quot;',
        })[character] ?? character,
    );
  }
}