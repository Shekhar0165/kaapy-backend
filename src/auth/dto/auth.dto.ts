import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  IsNumberString,
  IsOptional,
  Length,
  MaxLength,
} from 'class-validator';
import { ENABLED_LANGUAGES, type LanguageCode } from '../../common/languages.js';
import { NormalizeEmail } from '../../common/validation.js';
import { NoHtml } from '../../common/validators/no-html.validator.js';

export class RegisterDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  @NormalizeEmail()
  @IsEmail()
  @IsNotEmpty()
  gmail!: string;

  @ApiProperty({ example: 'StrongPassword123!' })
  @IsString()
  @IsNotEmpty()
  @Length(8, 100)
  password!: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @NoHtml()
  fullName!: string;

  @ApiProperty({ example: 'Johns Grocery' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @NoHtml()
  shopName!: string;

  @ApiProperty({
    example: 'Not provided',
    required: false,
    description: 'Legacy free-text address; the app now asks for the address after sign-up.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @NoHtml()
  address?: string;

  @ApiProperty({
    enum: ENABLED_LANGUAGES,
    required: false,
    description: 'Language picked on the first screen; used only when this creates the account.',
  })
  @IsOptional()
  @IsIn(ENABLED_LANGUAGES as unknown as string[], { message: 'language must be one of the enabled languages' })
  language?: LanguageCode;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  @NormalizeEmail()
  @IsEmail()
  @IsNotEmpty()
  gmail!: string;
}

export class VerifyGmailDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  @NormalizeEmail()
  @IsEmail()
  @IsNotEmpty()
  gmail!: string;

  @ApiProperty({ example: '123456' })
  @IsNumberString()
  @Length(6, 6)
  code!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  @NormalizeEmail()
  @IsEmail()
  @IsNotEmpty()
  gmail!: string;

  @ApiProperty({ example: 'StrongPassword123!' })
  @IsString()
  @IsNotEmpty()
  @Length(8, 100)
  password!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  @NormalizeEmail()
  @IsEmail()
  @IsNotEmpty()
  gmail!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  @NormalizeEmail()
  @IsEmail()
  @IsNotEmpty()
  gmail!: string;

  @ApiProperty({ example: '123456' })
  @IsNumberString()
  @Length(6, 6)
  code!: string;

  @ApiProperty({ example: 'NewStrongPassword123!' })
  @IsString()
  @IsNotEmpty()
  @Length(8, 100)
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'StrongPassword123!' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  currentPassword!: string;

  @ApiProperty({ example: 'EvenStronger456!', minLength: 8, maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @Length(8, 100)
  newPassword!: string;
}

export class LogoutDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class ErrorWithCodeDto {
  @ApiProperty({ example: 403 })
  statusCode!: number;

  @ApiProperty({
    example: 'WRONG_PASSWORD',
    enum: [
      'WRONG_PASSWORD',
      'SAME_PASSWORD',
      'TOO_MANY_ATTEMPTS',
      'NO_PASSWORD',
      'account_exists_password',
      'account_exists_google',
      'email_send_failed',
      'email_not_verified',
      'invalid_code',
      'code_expired',
      'too_many_attempts',
      'already_verified',
      'resend_cooldown',
      'too_many_requests',
    ],
  })
  code!: string;

  @ApiProperty({ example: 'Current password is incorrect' })
  message!: string;
}

export class GoogleLoginDto {
  @ApiProperty({ description: 'Google ID token returned by the mobile client' })
  @IsString()
  @IsNotEmpty()
  idToken!: string;

  @ApiProperty({
    enum: ENABLED_LANGUAGES,
    required: false,
    description: 'Language picked on the first screen; used only when this creates the account.',
  })
  @IsOptional()
  @IsIn(ENABLED_LANGUAGES as unknown as string[], { message: 'language must be one of the enabled languages' })
  language?: LanguageCode;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'Gmail verified successfully' })
  message!: string;
}

export class VerificationSentResponseDto {
  @ApiProperty({ example: 'verification_sent', enum: ['verification_sent'] })
  status!: 'verification_sent';

  @ApiProperty({
    example: '123456',
    required: false,
    description: 'Development only, for manual testing. Never returned in production and never used by the app.',
  })
  verificationCode?: string;
}

export class RegisterResponseDto extends MessageResponseDto {
  @ApiProperty({
    example: '123456',
    required: false,
    description: 'Development only. Never returned in production.',
  })
  verificationCode?: string;
}

export class ForgotPasswordResponseDto extends MessageResponseDto {
  @ApiProperty({
    example: '123456',
    required: false,
    description: 'Development only. Never returned in production.',
  })
  resetCode?: string;
}

export class TokenResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.access-payload.signature',
    description: 'JWT access token, valid for 1 day.',
  })
  accessToken!: string;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh-payload.signature',
    description: 'JWT refresh token, valid for 7 days and stored in Redis.',
  })
  refreshToken!: string;
}