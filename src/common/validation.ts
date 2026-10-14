import { ValidationPipe } from '@nestjs/common';
import { Transform } from 'class-transformer';

/** The app-wide validation pipe; also used by the HTTP tests. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
  });
}

/** Trims strings; turns an empty optional string into `undefined`. */
export function TrimString(options: { emptyAsUndefined?: boolean } = {}): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    // NFC: the same name typed with different Unicode sequences (common in Indic
    // scripts) is stored and searched the same way.
    const trimmed = value.normalize('NFC').trim();
    return options.emptyAsUndefined && trimmed === '' ? undefined : trimmed;
  });
}

/** Emails are compared and stored trimmed and lowercased everywhere. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Trims and lowercases an email before it is validated. */
export function NormalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  );
}

/**
 * Keeps the value exactly as the client sent it. The global pipe's implicit
 * conversion would otherwise turn "yes" or 1 into true for boolean fields.
 */
export function NoImplicitConversion(): PropertyDecorator {
  return Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key]);
}
