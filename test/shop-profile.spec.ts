import request from 'supertest';
import { BadGatewayException } from '@nestjs/common';
import { createTestApp, type TestContext } from './support/test-app.js';

const validAddress = {
  line1: '12 Main Bazaar Road',
  line2: 'Near Hanuman Mandir',
  city: 'New Delhi',
  state: 'Delhi',
  pincode: '110001',
  source: 'manual',
};

describe('/shops/me', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  const http = () => request(ctx.app.getHttpServer());

  describe('authentication', () => {
    it.each([
      ['GET', '/shops/me'],
      ['PATCH', '/shops/me'],
      ['PUT', '/shops/me/address'],
      ['POST', '/shops/me/address/reverse-geocode'],
      ['PATCH', '/shops/me/settings'],
    ])('%s %s requires an access token', async (method, path) => {
      const response = await http()[method.toLowerCase() as 'get'](path);
      expect(response.status).toBe(401);
    });

    it('rejects a refresh token used as an access token', async () => {
      const { id } = await ctx.createShop();
      const refreshToken = await ctx.jwt.signAsync(
        { sub: id, gmail: 'x@gmail.com', type: 'refresh' },
        { expiresIn: '7d' },
      );

      await http().get('/shops/me').set('Authorization', `Bearer ${refreshToken}`).expect(401);
    });

    it('no longer exposes the list or by-id routes', async () => {
      const { id, accessToken } = await ctx.createShop();
      await http().get('/shops').set('Authorization', `Bearer ${accessToken}`).expect(404);
      await http().get(`/shops/${id}`).set('Authorization', `Bearer ${accessToken}`).expect(404);
    });
  });

  describe('GET /shops/me', () => {
    it('returns the profile without secret fields', async () => {
      const { id, accessToken } = await ctx.createShop({ gmail: 'owner@gmail.com' });

      const { body } = await http()
        .get('/shops/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(body).toEqual({
        id,
        shopName: 'Sharma General Store',
        fullName: 'Rakesh Sharma',
        gmail: 'owner@gmail.com',
        isGmailVerify: true,
        provider: 'gamil',
        hasPassword: true,
        address: null,
        legacyAddress: null,
        // Shops saved before settings existed read back with the defaults.
        language: 'en',
        settings: { emailFallback: true, includeNote: true, messageLanguage: 'en', notifyCustomers: true },
      });
      expect(JSON.stringify(body)).not.toContain('passwordHash');
    });

    it('keeps an old free-text address readable', async () => {
      const { accessToken } = await ctx.createShop({ address: '12 Old Market, Jaipur' });
      const { body } = await http().get('/shops/me').set('Authorization', `Bearer ${accessToken}`);
      expect(body.legacyAddress).toBe('12 Old Market, Jaipur');
      expect(body.address).toBeNull();
    });

    it('reports Google-only accounts as having no password', async () => {
      const { accessToken } = await ctx.createShop({ password: null });
      const { body } = await http().get('/shops/me').set('Authorization', `Bearer ${accessToken}`);
      expect(body.hasPassword).toBe(false);
      expect(body.provider).toBe('google');
    });
  });

  describe('PATCH /shops/me', () => {
    it('updates and trims the shop name', async () => {
      const { id, accessToken } = await ctx.createShop();

      const { body } = await http()
        .patch('/shops/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ shopName: '  Gupta Kirana  ' })
        .expect(200);

      expect(body.shopName).toBe('Gupta Kirana');
      expect(ctx.model.store.get(id)?.shopName).toBe('Gupta Kirana');
    });

    it.each([
      [{ shopName: 'A' }, 'too short'],
      [{ shopName: 'x'.repeat(61) }, 'too long'],
      [{ shopName: '   ' }, 'blank after trimming'],
      [{ shopName: '<b>Shop</b>' }, 'HTML'],
      [{}, 'missing'],
      [{ shopName: 'Valid Name', gmail: 'evil@gmail.com' }, 'non-whitelisted field'],
    ])('rejects %j (%s)', async (payload, _reason) => {
      const { id, accessToken } = await ctx.createShop();

      await http()
        .patch('/shops/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(payload)
        .expect(400);

      expect(ctx.model.store.get(id)?.shopName).toBe('Sharma General Store');
    });

    it('only ever changes the caller’s own shop', async () => {
      const alice = await ctx.createShop({ shopName: 'Alice Store' });
      const bob = await ctx.createShop({ shopName: 'Bob Store' });

      // There is no way to name another shop: a shopId field is rejected outright.
      await http()
        .patch('/shops/me')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ shopName: 'Hacked', shopId: bob.id })
        .expect(400);

      await http()
        .patch('/shops/me')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ shopName: 'Alice Renamed' })
        .expect(200);

      expect(ctx.model.store.get(alice.id)?.shopName).toBe('Alice Renamed');
      expect(ctx.model.store.get(bob.id)?.shopName).toBe('Bob Store');
    });
  });

  describe('PUT /shops/me/address', () => {
    it('saves a manual address', async () => {
      const { id, accessToken } = await ctx.createShop();

      const { body } = await http()
        .put('/shops/me/address')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validAddress)
        .expect(200);

      expect(body.address).toEqual(validAddress);
      expect(ctx.model.store.get(id)?.addressDetails).toMatchObject({ pincode: '110001' });
    });

    it('stores GPS coordinates as a GeoJSON point [lng, lat]', async () => {
      const { id, accessToken } = await ctx.createShop();

      const { body } = await http()
        .put('/shops/me/address')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validAddress, source: 'gps', location: { lat: 28.6139, lng: 77.209 } })
        .expect(200);

      expect(ctx.model.store.get(id)?.addressDetails?.location).toEqual({
        type: 'Point',
        coordinates: [77.209, 28.6139],
      });
      expect(body.address.location).toEqual({ lat: 28.6139, lng: 77.209 });
    });

    it('treats an empty area/landmark as not provided', async () => {
      const { accessToken } = await ctx.createShop();
      const { body } = await http()
        .put('/shops/me/address')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validAddress, line2: '  ' })
        .expect(200);
      expect(body.address.line2).toBeUndefined();
    });

    it.each([
      [{ pincode: '11001' }, '5-digit PIN'],
      [{ pincode: '011001' }, 'PIN starting with 0'],
      [{ pincode: '11000A' }, 'non-numeric PIN'],
      [{ city: '' }, 'empty city'],
      [{ line1: 'x'.repeat(121) }, 'line1 too long'],
      [{ state: '<script>x</script>' }, 'HTML in state'],
      [{ source: 'satellite' }, 'unknown source'],
      [{ location: { lat: 91, lng: 77 } }, 'latitude out of range'],
      [{ location: { lat: 28, lng: -181 } }, 'longitude out of range'],
      [{ location: { lat: 28 } }, 'missing longitude'],
      [{ shopId: 'someone-else' }, 'non-whitelisted field'],
    ])('rejects %j (%s)', async (override, _reason) => {
      const { id, accessToken } = await ctx.createShop();

      await http()
        .put('/shops/me/address')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validAddress, ...override })
        .expect(400);

      expect(ctx.model.store.get(id)?.addressDetails).toBeUndefined();
    });

    it('does not touch another shop’s address', async () => {
      const alice = await ctx.createShop();
      const bob = await ctx.createShop();

      await http()
        .put('/shops/me/address')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send(validAddress)
        .expect(200);

      expect(ctx.model.store.get(bob.id)?.addressDetails).toBeUndefined();
    });
  });

  describe('POST /shops/me/address/reverse-geocode', () => {
    const suggestion = {
      line1: '12 Main Bazaar Road',
      area: 'Chandni Chowk',
      city: 'New Delhi',
      state: 'Delhi',
      pincode: '110006',
    };

    it('returns the provider suggestion without saving anything', async () => {
      const { id, accessToken } = await ctx.createShop();
      ctx.geocoding.reverseGeocode.mockResolvedValue(suggestion);

      const { body } = await http()
        .post('/shops/me/address/reverse-geocode')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ lat: 28.65, lng: 77.23 })
        .expect(200);

      expect(body).toEqual(suggestion);
      expect(ctx.geocoding.reverseGeocode).toHaveBeenCalledWith(28.65, 77.23);
      expect(ctx.model.store.get(id)?.addressDetails).toBeUndefined();
    });

    it('validates coordinates', async () => {
      const { accessToken } = await ctx.createShop();
      await http()
        .post('/shops/me/address/reverse-geocode')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ lat: 120, lng: 77 })
        .expect(400);
      expect(ctx.geocoding.reverseGeocode).not.toHaveBeenCalled();
    });

    it('passes provider failures through as 502', async () => {
      const { accessToken } = await ctx.createShop();
      ctx.geocoding.reverseGeocode.mockRejectedValue(new BadGatewayException('Address lookup failed'));
      await http()
        .post('/shops/me/address/reverse-geocode')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ lat: 28.65, lng: 77.23 })
        .expect(502);
    });

    it('rate-limits each shop separately', async () => {
      const alice = await ctx.createShop();
      const bob = await ctx.createShop();
      ctx.geocoding.reverseGeocode.mockResolvedValue(suggestion);
      const lookup = (token: string) =>
        http()
          .post('/shops/me/address/reverse-geocode')
          .set('Authorization', `Bearer ${token}`)
          .send({ lat: 28.65, lng: 77.23 });

      for (let i = 0; i < 10; i += 1) {
        await lookup(alice.accessToken).expect(200);
      }
      await lookup(alice.accessToken).expect(429);
      await lookup(bob.accessToken).expect(200);
    });
  });

  describe('PATCH /shops/me/settings', () => {
    const patch = (token: string, body: object) =>
      http().patch('/shops/me/settings').set('Authorization', `Bearer ${token}`).send(body);

    it('updates only the fields sent and returns the whole profile', async () => {
      const { id, accessToken } = await ctx.createShop();

      const first = await patch(accessToken, { notifyCustomers: false }).expect(200);
      expect(first.body.language).toBe('en');
      expect(first.body.settings).toEqual({
        emailFallback: true,
        includeNote: true,
        messageLanguage: 'en',
        notifyCustomers: false,
      });

      const second = await patch(accessToken, { language: 'ta', messageLanguage: 'app' }).expect(200);
      expect(second.body.language).toBe('ta');
      expect(second.body.settings).toEqual({
        emailFallback: true,
        includeNote: true,
        messageLanguage: 'app',
        notifyCustomers: false,
      });

      await patch(accessToken, { emailFallback: false, includeNote: false }).expect(200);
      const stored = ctx.model.store.get(id)!;
      expect(stored.language).toBe('ta');
      expect(stored.settings).toEqual({
        emailFallback: false,
        includeNote: false,
        messageLanguage: 'app',
        notifyCustomers: false,
      });

      const me = await http().get('/shops/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
      expect(me.body.settings.includeNote).toBe(false);
    });

    it('an empty body changes nothing', async () => {
      const { accessToken } = await ctx.createShop();
      const { body } = await patch(accessToken, {}).expect(200);
      expect(body.settings.notifyCustomers).toBe(true);
    });

    it.each([
      [{ language: 'xx' }, 'unknown language'],
      [{ language: 'ur' }, 'disabled language (Tier 2)'],
      [{ language: 'HI' }, 'wrong case'],
      [{ messageLanguage: 'hi' }, 'messageLanguage must be en or app'],
      [{ notifyCustomers: 'yes' }, 'string instead of boolean'],
      [{ emailFallback: 1 }, 'number instead of boolean'],
      [{ includeNote: null }, 'null'],
      [{ shopName: 'Hacked' }, 'unknown field'],
      [{ shopId: '66f1c0ffee0000000000abcd' }, 'shop id from the client'],
    ])('rejects %j (%s) with 400 and changes nothing', async (body: object, _reason: string) => {
      const { id, accessToken } = await ctx.createShop();
      await patch(accessToken, body).expect(400);
      expect(ctx.model.store.get(id)!.settings).toBeUndefined();
      expect(ctx.model.store.get(id)!.language).toBeUndefined();
    });

    it('only ever changes the caller’s own settings', async () => {
      const alice = await ctx.createShop({ gmail: 'alice@gmail.com' });
      const bob = await ctx.createShop({ gmail: 'bob@gmail.com' });
      await patch(alice.accessToken, { notifyCustomers: false, language: 'hi' }).expect(200);
      expect(ctx.model.store.get(bob.id)!.settings).toBeUndefined();
      const bobMe = await http().get('/shops/me').set('Authorization', `Bearer ${bob.accessToken}`);
      expect(bobMe.body.settings.notifyCustomers).toBe(true);
      expect(bobMe.body.language).toBe('en');
    });

    it('rejects a refresh token', async () => {
      const { id } = await ctx.createShop();
      const refreshToken = await ctx.jwt.signAsync(
        { sub: id, gmail: 'x@gmail.com', type: 'refresh' },
        { expiresIn: '7d' },
      );
      await patch(refreshToken, { notifyCustomers: false }).expect(401);
      expect(ctx.model.store.get(id)!.settings).toBeUndefined();
    });
  });
});
