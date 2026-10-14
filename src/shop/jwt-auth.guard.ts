import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { SessionService } from '../auth/session.service.js';

export interface AccessTokenPayload {
  sub: string;
  gmail: string;
  type: 'access';
  iat?: number;
}

export type AuthenticatedRequest = Request & { user: AccessTokenPayload };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly sessionService: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Bearer token is required');
    }

    let payload: Partial<AccessTokenPayload> & { type?: string };
    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Refresh tokens are signed with the same secret; they must never act as access tokens.
    if (payload.type !== 'access' || !payload.sub) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (await this.sessionService.isRevoked(payload.sub, payload.iat)) {
      throw new UnauthorizedException('This session has been logged out');
    }

    request.user = payload as AccessTokenPayload;
    return true;
  }
}
