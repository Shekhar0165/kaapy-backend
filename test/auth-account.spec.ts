import { createHash } from 'node:crypto';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service.js';
import { verifyPassword } from '../src/auth/password.js';
import { createTestApp, type TestContext } from './support/test-app.js';

const refreshKey = (token: string) =>
  `auth:refresh:${createHash('sha256').update(token).digest('hex')}`;

describe('account auth endpoints', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  const http = () => request(ctx.app.getHttpServer());

  /** A refresh token as login would issue it: signed and registered in Redis. */
  async function registeredRefreshToken(shopId: string, issuedSecondsAgo = 0) {
    const iat = Math.floor(Date.now() / 1000) - issuedSecondsAgo;
    const token = await ctx.jwt.signAsync(
      { sub: shopId, gmail: 'x@gmail.com', type: 'refresh', iat },
      { expiresIn: '7d' },
    );
    await ctx.redis.set(refreshKey(token), shopId);
    return token;
  }

  describe('POST /auth/change-password', () => {
    const changePassword = (token: string, body: object) =>
      http().post('/auth/change-password').set('Authorization', `Bearer ${token}`).send(body);

    it('requires an access token', async () => {
      await http()
        .post('/auth/change-password')
        .send({ currentPassword: 'OldPassword1', newPassword: 'NewPassword1' })
        .expect(401);
    });

    it('changes the password and returns a working token pair', async () => {
      const { id, accessToken } = await ctx.createShop();

      const { body } = await changePassword(accessToken, {
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
      }).expect(200);

      expect(body).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String) });
      const stored = ctx.model.store.get(id)?.passwordHash as string;
      expect(verifyPassword('NewPassword1', stored)).toBe(true);
      expect(verifyPassword('OldPassword1', stored)).toBe(false);

      await http().get('/shops/me').set('Authorization', `Bearer ${body.accessToken}`).expect(200);
      await http().post('/auth/refresh-token').send({ refreshToken: body.refreshToken }).expect(201);
    });

    it('logs out every other session', async () => {
      const { id, accessToken } = await ctx.createShop({ gmail: 'owner@gmail.com' });
      const otherDeviceAccess = await ctx.accessToken(id, 'owner@gmail.com', 60);
      const otherDeviceRefresh = await registeredRefreshToken(id, 60);

      await http().get('/shops/me').set('Authorization', `Bearer ${otherDeviceAccess}`).expect(200);

      await changePassword(accessToken, {
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
      }).expect(200);

      await http().get('/shops/me').set('Authorization', `Bearer ${otherDeviceAccess}`).expect(401);
      await http().post('/auth/refresh-token').send({ refreshToken: otherDeviceRefresh }).expect(401);
    });

    it('rejects a wrong current password with WRONG_PASSWORD', async () => {
      const { id, accessToken } = await ctx.createShop();
      const before = ctx.model.store.get(id)?.passwordHash;

      const { body } = await changePassword(accessToken, {
        currentPassword: 'WrongPassword',
        newPassword: 'NewPassword1',
      }).expect(403);

      expect(body.code).toBe('WRONG_PASSWORD');
      expect(ctx.model.store.get(id)?.passwordHash).toBe(before);
    });

    it('rejects reusing the current password with SAME_PASSWORD', async () => {
      const { accessToken } = await ctx.createShop();
      const { body } = await changePassword(accessToken, {
        currentPassword: 'OldPassword1',
        newPassword: 'OldPassword1',
      }).expect(400);
      expect(body.code).toBe('SAME_PASSWORD');
    });

    it('locks after five wrong attempts with TOO_MANY_ATTEMPTS', async () => {
      const { accessToken } = await ctx.createShop();
      const wrong = { currentPassword: 'WrongPassword', newPassword: 'NewPassword1' };

      for (let i = 0; i < 4; i += 1) {
        await changePassword(accessToken, wrong).expect(403);
      }
      const fifth = await changePassword(accessToken, wrong).expect(429);
      expect(fifth.body.code).toBe('TOO_MANY_ATTEMPTS');

      // Even the right password is refused while locked.
      const locked = await changePassword(accessToken, {
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
      }).expect(429);
      expect(locked.body.code).toBe('TOO_MANY_ATTEMPTS');
    });

    it('explains that Google-only accounts have no password', async () => {
      const { accessToken } = await ctx.createShop({ password: null });
      const { body } = await changePassword(accessToken, {
        currentPassword: 'anything',
        newPassword: 'NewPassword1',
      }).expect(400);
      expect(body.code).toBe('NO_PASSWORD');
      expect(body.message).toBe('You signed in with Google, so there is no password to change.');
    });

    it.each([
      [{ currentPassword: 'OldPassword1', newPassword: 'short' }, 'new password too short'],
      [{ currentPassword: 'OldPassword1', newPassword: 'x'.repeat(101) }, 'new password too long'],
      [{ currentPassword: '', newPassword: 'NewPassword1' }, 'empty current password'],
      [{ newPassword: 'NewPassword1' }, 'missing current password'],
      [{ currentPassword: 'OldPassword1', newPassword: 'NewPassword1', shopId: 'x' }, 'extra field'],
    ])('validates %j (%s)', async (payload, _reason) => {
      const { accessToken } = await ctx.createShop();
      await changePassword(accessToken, payload).expect(400);
    });

    it('only changes the caller’s own password', async () => {
      const alice = await ctx.createShop({ password: 'AlicePass1' });
      const bob = await ctx.createShop({ password: 'BobPass123' });
      const bobHash = ctx.model.store.get(bob.id)?.passwordHash;

      // Alice cannot use Bob's password to change anything, and Bob is unaffected.
      await changePassword(alice.accessToken, {
        currentPassword: 'BobPass123',
        newPassword: 'Hijacked123',
      }).expect(403);
      expect(ctx.model.store.get(bob.id)?.passwordHash).toBe(bobHash);
    });
  });

  describe('POST /auth/google', () => {
    function googleAccount(email: string) {
      vi.spyOn(ctx.app.get(AuthService), 'verifyGoogleToken').mockResolvedValue({
        aud: 'test',
        email,
        email_verified: true,
        exp: 0,
        iat: 0,
        iss: 'accounts.google.com',
        name: 'Raju Kirana',
        sub: 'google-sub',
      });
    }

    it('marks a shop created by this sign-in as new, so the app asks for its address', async () => {
      googleAccount('first-time@gmail.com');
      const { body } = await http().post('/auth/google').send({ idToken: 'id-token' }).expect(201);

      expect(body.isNewShop).toBe(true);
      const me = await http()
        .get('/shops/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
      expect(me.body.address).toBeNull();
      expect(me.body.legacyAddress).toBeNull();
    });

    it('does not mark an existing shop as new', async () => {
      await ctx.createShop({ gmail: 'old@gmail.com', password: null });
      googleAccount('old@gmail.com');
      const { body } = await http().post('/auth/google').send({ idToken: 'id-token' }).expect(201);
      expect(body.isNewShop).toBe(false);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the given refresh token', async () => {
      const { id } = await ctx.createShop();
      const refreshToken = await registeredRefreshToken(id);

      await http().post('/auth/logout').send({ refreshToken }).expect(200, { message: 'Logged out' });

      expect(ctx.redis.data.has(refreshKey(refreshToken))).toBe(false);
      await http().post('/auth/refresh-token').send({ refreshToken }).expect(401);
    });

    it('succeeds for an unknown or garbage token', async () => {
      await http()
        .post('/auth/logout')
        .send({ refreshToken: 'not-a-real-token' })
        .expect(200, { message: 'Logged out' });
    });

    it('does not revoke other sessions of the same shop', async () => {
      const { id } = await ctx.createShop();
      const phone = await registeredRefreshToken(id);
      const tablet = await registeredRefreshToken(id, 5);

      await http().post('/auth/logout').send({ refreshToken: phone }).expect(200);
      expect(ctx.redis.data.has(refreshKey(tablet))).toBe(true);
    });

    it('requires a refresh token in the body', async () => {
      await http().post('/auth/logout').send({}).expect(400);
    });
  });
});
