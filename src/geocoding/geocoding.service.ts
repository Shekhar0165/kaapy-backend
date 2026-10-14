import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ReverseGeocodeResult {
  line1: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
}

export type GeocodingProvider = 'google' | 'nominatim' | 'none';

const REQUEST_TIMEOUT_MS = 5000;
/** The OSM usage policy allows at most one request per second (for the whole app). */
const NOMINATIM_MIN_INTERVAL_MS = 1100;
/** Beyond this many queued lookups we answer 503 instead of making owners wait. */
const NOMINATIM_MAX_WAITING = 5;
const NOMINATIM_USER_AGENT = 'Kaapy/1.0 (shop address lookup)';

type GoogleComponent = { long_name: string; types: string[] };
type GoogleResponse = {
  status: string;
  results?: { address_components: GoogleComponent[] }[];
};
type NominatimResponse = {
  error?: string;
  address?: Record<string, string | undefined>;
};

const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(', ');
const pincodeOf = (value: string | undefined) => value?.replace(/\s/g, '').match(/\d{6}/)?.[0] ?? '';

export function mapGoogleResult(components: GoogleComponent[]): ReverseGeocodeResult {
  const pick = (...types: string[]) =>
    components.find((component) => types.some((type) => component.types.includes(type)))
      ?.long_name;

  return {
    line1: join(pick('premise', 'street_number'), pick('route')),
    area: join(pick('sublocality_level_1', 'sublocality', 'neighborhood')),
    city: pick('locality', 'administrative_area_level_3', 'administrative_area_level_2') ?? '',
    state: pick('administrative_area_level_1') ?? '',
    pincode: pincodeOf(pick('postal_code')),
  };
}

const withoutDistrict = (value: string | undefined) =>
  value?.replace(/\s+district$/i, '').trim() || undefined;

/**
 * Nominatim's keys differ a lot across India: big cities often have no `city`
 * (Mumbai gives state_district "Mumbai City District"), small places use town or
 * village, and areas come as neighbourhood plus suburb. The owner edits the result
 * before saving, so this only has to be a good first guess.
 */
export function mapNominatimAddress(
  address: Record<string, string | undefined>,
): ReverseGeocodeResult {
  const areas = [address.neighbourhood, address.quarter, address.suburb, address.hamlet].filter(
    (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
  );
  return {
    line1: join(
      address.house_number,
      address.building,
      address.road ?? address.pedestrian ?? address.residential ?? address.footway,
    ),
    area: join(...areas.slice(0, 2)),
    city:
      address.city ??
      address.town ??
      address.village ??
      address.municipality ??
      withoutDistrict(address.state_district) ??
      withoutDistrict(address.county) ??
      address.city_district ??
      '',
    state: address.state ?? '',
    pincode: pincodeOf(address.postcode),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reverse geocoding behind a single provider switch:
 *   GEOCODING_PROVIDER=google     needs GEOCODING_API_KEY (Google Geocoding API)
 *   GEOCODING_PROVIDER=nominatim  OpenStreetMap, no key; low volume only per OSM policy,
 *                                 so requests are spaced at least 1.1 s apart
 *   unset / none                  endpoint answers 503 and the app falls back to typing
 * Coordinates and API keys are never logged.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly provider: GeocodingProvider;
  private readonly apiKey: string | undefined;
  /** Start times of Nominatim requests are chained through this promise. */
  private nominatimQueue: Promise<void> = Promise.resolve();
  private lastNominatimAt = 0;
  private nominatimWaiting = 0;
  /** Exposed for tests. */
  nominatimIntervalMs = NOMINATIM_MIN_INTERVAL_MS;

  constructor(config: ConfigService) {
    const configured = config.get<string>('GEOCODING_PROVIDER', 'none').toLowerCase();
    this.provider = configured === 'google' || configured === 'nominatim' ? configured : 'none';
    this.apiKey = config.get<string>('GEOCODING_API_KEY') || undefined;

    if (this.provider === 'google' && !this.apiKey) {
      this.logger.warn('GEOCODING_PROVIDER=google but GEOCODING_API_KEY is not set');
    }
  }

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    if (this.provider === 'google' && this.apiKey) {
      return this.fromGoogle(lat, lng, this.apiKey);
    }
    if (this.provider === 'nominatim') {
      return this.fromNominatim(lat, lng);
    }
    throw new ServiceUnavailableException('Address lookup is not configured');
  }

  private async fromGoogle(lat: number, lng: number, key: string): Promise<ReverseGeocodeResult> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('language', 'en');
    url.searchParams.set('region', 'in');
    url.searchParams.set('key', key);

    const body = await this.fetchJson<GoogleResponse>(url, {});
    if (body.status === 'ZERO_RESULTS' || !body.results?.length) {
      throw new NotFoundException('No address found for this location');
    }
    if (body.status !== 'OK') {
      this.logger.error(`Google geocoding failed with status ${body.status}`);
      throw new BadGatewayException('Address lookup failed');
    }
    return mapGoogleResult(body.results[0].address_components);
  }

  private async fromNominatim(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('zoom', '18');

    await this.waitForNominatimTurn();
    const body = await this.fetchJson<NominatimResponse>(url, {
      'Accept-Language': 'en',
      // Required by the OSM usage policy.
      'User-Agent': NOMINATIM_USER_AGENT,
    });
    if (body.error || !body.address) {
      throw new NotFoundException('No address found for this location');
    }
    return mapNominatimAddress(body.address);
  }

  /** Spaces Nominatim calls at least `nominatimIntervalMs` apart, in arrival order. */
  private async waitForNominatimTurn(): Promise<void> {
    if (this.nominatimWaiting >= NOMINATIM_MAX_WAITING) {
      this.logger.warn('nominatim lookup queue is full');
      throw new ServiceUnavailableException('Address lookup is busy. Try again in a moment.');
    }
    this.nominatimWaiting += 1;
    const turn = this.nominatimQueue.then(async () => {
      const wait = this.lastNominatimAt + this.nominatimIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastNominatimAt = Date.now();
    });
    this.nominatimQueue = turn;
    try {
      await turn;
    } finally {
      this.nominatimWaiting -= 1;
    }
  }

  private async fetchJson<T>(url: URL, headers: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error';
      this.logger.error(`${this.provider} geocoding request failed: ${reason}`);
      throw new BadGatewayException('Address lookup failed');
    }

    if (!response.ok) {
      this.logger.error(`${this.provider} geocoding returned HTTP ${response.status}`);
      throw new BadGatewayException('Address lookup failed');
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new BadGatewayException('Address lookup failed');
    }
  }
}
