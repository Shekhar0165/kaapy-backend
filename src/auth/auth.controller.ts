import { Body, Controller, Headers, HttpCode, Ip, Logger, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiServiceUnavailableResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiOkResponse,
  ApiBearerAuth,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentShopId } from '../shop/current-shop.decorator.js';
import { JwtAuthGuard } from '../shop/jwt-auth.guard.js';
import { AuthService } from './auth.service.js';
import {
  ChangePasswordDto,
  ErrorWithCodeDto,
  LogoutDto,
  ForgotPasswordDto,
  LoginDto,
  ForgotPasswordResponseDto,
  MessageResponseDto,
  RefreshTokenDto,
  RegisterDto,
  ResendVerificationDto,
  VerificationSentResponseDto,
  ResetPasswordDto,
  TokenResponseDto,
  VerifyGmailDto,
  GoogleLoginDto,
} from './dto/auth.dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({
    summary: 'Start (or restart) an email and password sign-up',
    description:
      'Safe to retry. A new or still-unverified email gets a fresh 6-digit code by email; the shop stays unverified until /auth/verify-gmail. ' +
      'Limits: 5 per email and per IP each hour, one code per 60 seconds.',
  })
  @ApiCreatedResponse({ type: VerificationSentResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid registration data' })
  @ApiConflictResponse({ type: ErrorWithCodeDto, description: 'account_exists_password or account_exists_google' })
  @ApiTooManyRequestsResponse({ type: ErrorWithCodeDto, description: 'too_many_requests or resend_cooldown' })
  @ApiServiceUnavailableResponse({ type: ErrorWithCodeDto, description: 'email_send_failed' })
  register(@Body() dto: RegisterDto, @Ip() ip: string) {
    return this.authService.register(dto, ip);
  }

  @Post('resend-verification')
  @ApiOperation({
    summary: 'Email a new sign-up code',
    description:
      'Always answers the same way for unknown or already verified emails. Only a pending password sign-up gets an email. Same limits as register.',
  })
  @ApiCreatedResponse({ type: VerificationSentResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorWithCodeDto, description: 'too_many_requests or resend_cooldown' })
  @ApiServiceUnavailableResponse({ type: ErrorWithCodeDto, description: 'email_send_failed' })
  resendVerification(@Body() dto: ResendVerificationDto, @Ip() ip: string) {
    return this.authService.resendVerification(dto, ip);
  }

  @Post('verify-gmail')
  @ApiOperation({
    summary: 'Confirm the emailed code and sign in',
    description:
      'Returns the same access and refresh tokens as /auth/login. Five wrong codes throw the code away (too_many_attempts).',
  })
  @ApiCreatedResponse({ type: TokenResponseDto })
  @ApiBadRequestResponse({ type: ErrorWithCodeDto, description: 'invalid_code, code_expired or too_many_attempts' })
  @ApiConflictResponse({ type: ErrorWithCodeDto, description: 'already_verified' })
  @ApiTooManyRequestsResponse({ type: ErrorWithCodeDto, description: 'too_many_requests' })
  verifyGmail(@Body() dto: VerifyGmailDto, @Ip() ip: string) {
    return this.authService.verifyGmail(dto, ip);
  }

  @Post('login')
  @ApiOperation({
    summary: 'Login and receive access and refresh tokens',
    description: 'Five failed attempts are allowed per 30-minute window.',
  })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials or rate limit exceeded' })
  @ApiForbiddenResponse({ type: ErrorWithCodeDto, description: 'email_not_verified (right password, email not confirmed yet)' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('google')
  @ApiOperation({ summary: 'Verify a Google ID token and sign in' })
  @ApiOkResponse({ description: 'Google sign-in succeeded' })
  @ApiUnauthorizedResponse({ description: 'Invalid Google ID token' })
  loginWithGoogle(@Body() dto: GoogleLoginDto) {
    this.logger.log(`[GoogleAuth] POST /auth/google received; token length=${dto.idToken.length}`);
    return this.authService.loginWithGoogle(dto.idToken, dto.language);
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

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change password, log out all other devices, and get new tokens',
    description:
      'Five wrong current-password attempts are allowed per 30-minute window. Errors carry a `code`.',
  })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiBadRequestResponse({
    type: ErrorWithCodeDto,
    description: 'Validation error, SAME_PASSWORD, or NO_PASSWORD (Google-only account)',
  })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid or revoked access token' })
  @ApiForbiddenResponse({ type: ErrorWithCodeDto, description: 'WRONG_PASSWORD' })
  @ApiTooManyRequestsResponse({ type: ErrorWithCodeDto, description: 'TOO_MANY_ATTEMPTS' })
  changePassword(@CurrentShopId() shopId: string, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(shopId, dto);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke a refresh token',
    description:
      'Always succeeds, even for an unknown or expired token. No access token is required, ' +
      'so a device whose access token has expired can still revoke its refresh token.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  logout(@Body() dto: LogoutDto) {
    return this.authService.logout(dto.refreshToken);
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