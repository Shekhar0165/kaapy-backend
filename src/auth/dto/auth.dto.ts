import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  gmail!: string;

  @ApiProperty({ example: 'StrongPassword123!' })
  password!: string;

  @ApiProperty({ example: 'John Doe' })
  fullName!: string;

  @ApiProperty({ example: 'Johns Grocery' })
  shopName!: string;

  @ApiProperty({ example: '12 Main Street, New Delhi' })
  address!: string;
}

export class VerifyGmailDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  gmail!: string;

  @ApiProperty({ example: '123456' })
  code!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  gmail!: string;

  @ApiProperty({ example: 'StrongPassword123!' })
  password!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  gmail!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'owner@gmail.com' })
  gmail!: string;

  @ApiProperty({ example: '123456' })
  code!: string;

  @ApiProperty({ example: 'NewStrongPassword123!' })
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
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