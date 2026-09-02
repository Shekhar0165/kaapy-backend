import { Body, Controller, Headers, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiOkResponse,
  ApiBearerAuth,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import {
  ForgotPasswordDto,
  LoginDto,
  ForgotPasswordResponseDto,
  MessageResponseDto,
  RefreshTokenDto,
  RegisterDto,
  RegisterResponseDto,
  ResetPasswordDto,
  TokenResponseDto,
  VerifyGmailDto,
} from './dto/auth.dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a shop with Gmail' })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid registration data' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('verify-gmail')
  @ApiOperation({ summary: 'Verify the Gmail registration code' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired verification code' })
  verifyGmail(@Body() dto: VerifyGmailDto) {
    return this.authService.verifyGmail(dto);
  }

  @Post('login')
  @ApiOperation({
    summary: 'Login and receive access and refresh tokens',
    description: 'Five failed attempts are allowed per 30-minute window.',
  })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials or rate limit exceeded' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('forgot-password')
  @ApiOperation({ summary: 'Send a password reset code' })
  @ApiOkResponse({ type: ForgotPasswordResponseDto })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @ApiOperation({ summary: 'Set a new password with a reset code' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired reset code' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('refresh-token')
  @ApiBearerAuth('refresh-token')
  @ApiOperation({
    summary: 'Rotate access and refresh tokens',
    description:
      'Send the refresh token as a Bearer token or in the request body. It returns a new access/refresh pair.',
  })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid, expired, or already rotated refresh token' })
  refresh(
    @Body() dto: RefreshTokenDto,
    @Headers('authorization') authorization?: string,
  ) {
    const refreshToken = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : dto.refreshToken;
    return this.authService.refresh({ refreshToken });
  }
}