import { BadGatewayException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GeocodingService,
  mapGoogleResult,
  mapNominatimAddress,
} from '../src/geocoding/geocoding.service.js';

const serviceWith = (env: Record<string, string>, intervalMs = 0) => {
  const service = new GeocodingService(new ConfigService(env));
  service.nominatimIntervalMs = intervalMs;
  return service;
};

const nominatimOk = (address: Record<string, string>) =>
  new Response(JSON.stringify({ address }), { headers: { 'Content-Type': 'application/json' } });

describe('GeocodingService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers 503 when no provider is configured', async () => {
    await expect(serviceWith({}).reverseGeocode(28.6, 77.2)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers 503 for google without an API key', async () => {
    await expect(
      serviceWith({ GEOCODING_PROVIDER: 'google' }).reverseGeocode(28.6, 77.2),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps a Google response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'OK',
          results: [
            {
              address_components: [
                { long_name: '12', types: ['street_number'] },
                { long_name: 'Main Bazaar Road', types: ['route'] },
                { long_name: 'Chandni Chowk', types: ['sublocality_level_1', 'sublocality'] },
                { long_name: 'New Delhi', types: ['locality'] },
                { long_name: 'Delhi', types: ['administrative_area_level_1'] },
                { long_name: '110006', types: ['postal_code'] },
              ],
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await serviceWith({
      GEOCODING_PROVIDER: 'google',
      GEOCODING_API_KEY: 'key',
    }).reverseGeocode(28.65, 77.23);

    expect(result).toEqual({
      line1: '12, Main Bazaar Road',
      area: 'Chandni Chowk',
      city: 'New Delhi',
      state: 'Delhi',
      pincode: '110006',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('latlng=28.65%2C77.23');
  });

  it('turns ZERO_RESULTS into 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }))),
    );
    await expect(
      serviceWith({ GEOCODING_PROVIDER: 'google', GEOCODING_API_KEY: 'k' }).reverseGeocode(0, 0),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('turns timeouts and HTTP errors into 502', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));
    const service = serviceWith({ GEOCODING_PROVIDER: 'nominatim' });
    await expect(service.reverseGeocode(28.6, 77.2)).rejects.toBeInstanceOf(BadGatewayException);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })));
    await expect(service.reverseGeocode(28.6, 77.2)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('never logs coordinates', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));

    await serviceWith({ GEOCODING_PROVIDER: 'nominatim' })
      .reverseGeocode(28.123456, 77.654321)
      .catch(() => undefined);

    const logged = [...errorSpy.mock.calls, ...stdoutSpy.mock.calls].flat().join(' ');
    expect(logged).not.toContain('28.123456');
    expect(logged).not.toContain('77.654321');
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('maps a Nominatim address and extracts a 6-digit PIN', () => {
    expect(
      mapNominatimAddress({
        house_number: '4',
        road: 'MG Road',
        suburb: 'Ashok Nagar',
        city: 'Bengaluru',
        state: 'Karnataka',
        postcode: '560 001',
      }),
    ).toEqual({
      line1: '4, MG Road',
      area: 'Ashok Nagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    });
  });

  it('returns empty strings for missing parts', () => {
    expect(mapGoogleResult([])).toEqual({ line1: '', area: '', city: '', state: '', pincode: '' });
  });

  it('maps Mumbai, where Nominatim has no city key', () => {
    expect(
      mapNominatimAddress({
        road: 'Road No 19',
        neighbourhood: 'Wadala Village',
        suburb: 'Matunga East',
        city_district: 'Mumbai Zone 2',
        state_district: 'Mumbai City District',
        state: 'Maharashtra',
        postcode: '400031',
        country: 'India',
      }),
    ).toEqual({
      line1: 'Road No 19',
      area: 'Wadala Village, Matunga East',
      city: 'Mumbai City',
      state: 'Maharashtra',
      pincode: '400031',
    });
  });

  it('maps Delhi, and town or village names for small places', () => {
    expect(
      mapNominatimAddress({
        road: 'Outer Circle',
        suburb: 'Connaught Place',
        city: 'New Delhi',
        state_district: 'New Delhi District',
        state: 'Delhi',
        postcode: '110001',
      }),
    ).toMatchObject({ line1: 'Outer Circle', area: 'Connaught Place', city: 'New Delhi' });
    expect(mapNominatimAddress({ village: 'Rampur', county: 'Bareilly', state: 'Uttar Pradesh' }))
      .toMatchObject({ city: 'Rampur', pincode: '' });
    expect(mapNominatimAddress({ county: 'Kangra District', state: 'Himachal Pradesh' }).city).toBe(
      'Kangra',
    );
  });

  it('turns an empty Nominatim answer into 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Unable to geocode' }))),
    );
    await expect(
      serviceWith({ GEOCODING_PROVIDER: 'nominatim' }).reverseGeocode(15.0, 75.0),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sends the Kaapy User-Agent, English and a 5 s timeout to Nominatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(nominatimOk({ city: 'Pune', state: 'Maharashtra' }));
    vi.stubGlobal('fetch', fetchMock);

    await serviceWith({ GEOCODING_PROVIDER: 'nominatim' }).reverseGeocode(18.52, 73.85);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('https://nominatim.openstreetmap.org/reverse?');
    expect(String(url)).toContain('addressdetails=1');
    expect(init.headers['User-Agent']).toBe('Kaapy/1.0 (shop address lookup)');
    expect(init.headers['Accept-Language']).toBe('en');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('spaces Nominatim requests at least one second apart', async () => {
    const startedAt: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        startedAt.push(Date.now());
        return nominatimOk({ city: 'Pune', state: 'Maharashtra' });
      }),
    );
    const service = serviceWith({ GEOCODING_PROVIDER: 'nominatim' }, 1100);

    await Promise.all([1, 2, 3].map(() => service.reverseGeocode(18.52, 73.85)));

    expect(startedAt).toHaveLength(3);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(1050);
    expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(1050);
  }, 10000);

  it('answers 503 instead of queueing too many Nominatim lookups', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(nominatimOk({ city: 'Pune' })));
    const service = serviceWith({ GEOCODING_PROVIDER: 'nominatim' }, 200);

    const results = await Promise.allSettled(
      Array.from({ length: 7 }, () => service.reverseGeocode(18.52, 73.85)),
    );

    const busy = results.filter(
      (result) =>
        result.status === 'rejected' && result.reason instanceof ServiceUnavailableException,
    );
    expect(busy).toHaveLength(2);
  }, 10000);
});
