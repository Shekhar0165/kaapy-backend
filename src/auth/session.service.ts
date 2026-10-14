import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

// Must outlive every token we issue (refresh tokens live 7 days).
const MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;

const markerKey = (shopId: string) => `auth:sessions-valid-after:${shopId}`;

/**
 * Per-shop "sessions valid after" marker. Any access or refresh token whose
 * `iat` is older than the marker is rejected, which logs out every device at
 * once without having to track individual tokens.
 */
@Injectable()
export class SessionService {
  constructor(private readonly redisService: RedisService) {}

  /** Invalidate every token issued for this shop before now. */
  async revokeAll(shopId: string): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    await this.redisService.set(markerKey(shopId), String(nowSeconds), MARKER_TTL_SECONDS);
  }

  /** True when a token issued at `issuedAt` (JWT `iat`, seconds) has been revoked. */
  async isRevoked(shopId: string, issuedAt: number | undefined): Promise<boolean> {
    const marker = await this.redisService.get(markerKey(shopId));
    if (!marker) return false;
    // Tokens minted in the same second as the revocation (the new pair) stay valid.
    return (issuedAt ?? 0) < Number(marker);
  }
}
