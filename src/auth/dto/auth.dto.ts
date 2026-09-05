import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsNumberString,
  Length,
  MaxLength,
} from 'class-validator';
import { NoHtml } from '../../common/validators/no-html.validator.js';

export class RegisterDto {
  @ApiProperty({ example: 'owner@gmail.com' })
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

  @ApiProperty({ example: '12 Main Street, New Delhi' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @NoHtml()
  address!: string;
}

export class VerifyGmailDto {
  @ApiProperty({ example: 'owner@gmail.com' })
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
  @IsEmail()
  @IsNotEmpty()
  gmail!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'owner@gmail.com' })
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

export class MessageResponseDto {
  @ApiProperty({ example: 'Gmail verified successfully' })
  message!: string;
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