// Server-side WeatherKit REST client for scheduled Daily Briefs.
//
// The private key remains on the server. Apple requires a Service ID in the
// developer token's `sub` claim and the Team ID + Service ID in the header's
// `id` field. Responses are normalized into the same brief shape the existing
// renderer consumes so WeatherKit changes the source, not the presentation
// contract.

import { createPrivateKey, sign } from 'node:crypto';
import type {
  TemperatureUnit,
  WeatherConditionCode,
} from '@/components/tool-ui/weather-widget/schema-runtime';
import type { BriefWeather, DailyPoint, GeocodedPlace, HourlyPoint, NormalizedForecast } from './open-meteo';

export type WeatherKitFetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text?(): Promise<string> }>;

interface WeatherKitConfiguration {
  keyId: string;
  teamId: string;
  serviceId: string;
  privateKey: string;
}

const TOKEN_AGE_SECONDS = 45 * 60;
let cachedToken: { identity: string; issuedAt: number; token: string } | undefined;

export function weatherKitConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): WeatherKitConfiguration | null {
  // One Apple key can be enabled for both APNs and WeatherKit. Reusing the
  // server-side key/team variables avoids duplicating the secret in Railway.
  const keyId = String(environment.WEATHERKIT_KEY_ID || environment.APNS_KEY_ID || '').trim();
  const teamId = String(environment.WEATHERKIT_TEAM_ID || environment.APNS_TEAM_ID || '').trim();
  const serviceId = String(environment.WEATHERKIT_SERVICE_ID || '').trim();
  const privateKey = String(environment.WEATHERKIT_PRIVATE_KEY || environment.APNS_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .trim();
  if (!keyId || !teamId || !serviceId || !privateKey) return null;
  return { keyId, teamId, serviceId, privateKey };
}

export function weatherKitProviderToken(
  config: WeatherKitConfiguration,
  timestamp = Math.floor(Date.now() / 1_000),
) {
  const identity = `${config.teamId}:${config.keyId}:${config.serviceId}:${config.privateKey.length}`;
  if (cachedToken?.identity === identity && timestamp - cachedToken.issuedAt < TOKEN_AGE_SECONDS) {
    return cachedToken.token;
  }
  const header = Buffer.from(
    JSON.stringify({
      alg: 'ES256',
      kid: config.keyId,
      id: `${config.teamId}.${config.serviceId}`,
    }),
  ).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: config.teamId,
      iat: timestamp,
      exp: timestamp + TOKEN_AGE_SECONDS,
      sub: config.serviceId,
    }),
  ).toString('base64url');
  const unsigned = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const token = `${unsigned}.${signature}`;
  cachedToken = { identity, issuedAt: timestamp, token };
  return token;
}

const CONDITION_MAP: Record<string, { code: WeatherConditionCode; label: string }> = {
  Clear: { code: 'clear', label: 'Clear' },
  MostlyClear: { code: 'partly-cloudy', label: 'Mostly clear' },
  PartlyCloudy: { code: 'partly-cloudy', label: 'Partly cloudy' },
  MostlyCloudy: { code: 'cloudy', label: 'Mostly cloudy' },
  Cloudy: { code: 'overcast', label: 'Cloudy' },
  Foggy: { code: 'fog', label: 'Fog' },
  Haze: { code: 'fog', label: 'Haze' },
  Smoky: { code: 'fog', label: 'Smoky' },
  Breezy: { code: 'windy', label: 'Breezy' },
  Windy: { code: 'windy', label: 'Windy' },
  Drizzle: { code: 'drizzle', label: 'Drizzle' },
  FreezingDrizzle: { code: 'sleet', label: 'Freezing drizzle' },
  Rain: { code: 'rain', label: 'Rain' },
  HeavyRain: { code: 'heavy-rain', label: 'Heavy rain' },
  SunShowers: { code: 'rain', label: 'Sun showers' },
  IsolatedThunderstorms: { code: 'thunderstorm', label: 'Isolated thunderstorms' },
  ScatteredThunderstorms: { code: 'thunderstorm', label: 'Scattered thunderstorms' },
  Thunderstorms: { code: 'thunderstorm', label: 'Thunderstorms' },
  StrongStorms: { code: 'thunderstorm', label: 'Strong storms' },
  Flurries: { code: 'snow', label: 'Flurries' },
  Snow: { code: 'snow', label: 'Snow' },
  HeavySnow: { code: 'snow', label: 'Heavy snow' },
  SunFlurries: { code: 'snow', label: 'Sun flurries' },
  Blizzard: { code: 'snow', label: 'Blizzard' },
  BlowingSnow: { code: 'snow', label: 'Blowing snow' },
  Sleet: { code: 'sleet', label: 'Sleet' },
  FreezingRain: { code: 'sleet', label: 'Freezing rain' },
  WintryMix: { code: 'sleet', label: 'Wintry mix' },
  Hail: { code: 'hail', label: 'Hail' },
  TropicalStorm: { code: 'heavy-rain', label: 'Tropical storm' },
  Hurricane: { code: 'heavy-rain', label: 'Hurricane' },
};

export function conditionFromWeatherKit(value: unknown) {
  const raw = String(value || '').trim();
  return CONDITION_MAP[raw] ?? { code: 'cloudy' as const, label: humanizeCondition(raw) };
}

function humanizeCondition(raw: string) {
  if (!raw) return 'Cloudy';
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
}

function temperature(value: unknown, unit: TemperatureUnit) {
  const celsius = Number(value);
  if (!Number.isFinite(celsius)) return Number.NaN;
  return unit === 'fahrenheit' ? (celsius * 9) / 5 + 32 : celsius;
}

function windSpeed(value: unknown, unit: TemperatureUnit) {
  const kilometersPerHour = Number(value);
  if (!Number.isFinite(kilometersPerHour)) return undefined;
  return unit === 'fahrenheit' ? kilometersPerHour * 0.621371 : kilometersPerHour;
}

function localIso(value: unknown, timezone: string) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return String(value || '');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function dayLabel(forecastStart: unknown, index: number, timezone: string) {
  if (index === 0) return 'Today';
  const date = new Date(String(forecastStart || ''));
  if (Number.isNaN(date.getTime())) return String(forecastStart || '');
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(date);
}

export function normalizeWeatherKitResponse(
  payload: any,
  input: {
    place: GeocodedPlace;
    timezone: string;
    unit: TemperatureUnit;
  },
): BriefWeather {
  const current = payload?.currentWeather ?? {};
  const currentCondition = conditionFromWeatherKit(current.conditionCode);
  const hourlyRows = Array.isArray(payload?.forecastHourly?.hours) ? payload.forecastHourly.hours : [];
  const dayRows = Array.isArray(payload?.forecastDaily?.days) ? payload.forecastDaily.days : [];
  const hourly: HourlyPoint[] = hourlyRows
    .map((row: any) => ({
      timeIso: localIso(row.forecastStart, input.timezone),
      temperature: temperature(row.temperature, input.unit),
      conditionCode: conditionFromWeatherKit(row.conditionCode).code,
    }))
    .filter((row: HourlyPoint) => Number.isFinite(row.temperature))
    .slice(0, 12);
  const daily: DailyPoint[] = dayRows
    .map((row: any, index: number) => ({
      dateIso: localIso(row.forecastStart, input.timezone).slice(0, 10),
      label: dayLabel(row.forecastStart, index, input.timezone),
      conditionCode: conditionFromWeatherKit(row.conditionCode).code,
      tempMin: temperature(row.temperatureMin, input.unit),
      tempMax: temperature(row.temperatureMax, input.unit),
      precipitationChance: Number.isFinite(Number(row.precipitationChance))
        ? Number(row.precipitationChance) * 100
        : undefined,
    }))
    .filter((row: DailyPoint) => Number.isFinite(row.tempMin) && Number.isFinite(row.tempMax))
    .slice(0, 7);
  const currentTemperature = temperature(current.temperature, input.unit);
  const today = daily[0];
  const normalizedCurrent: NormalizedForecast['current'] = {
    timeIso: localIso(current.asOf, input.timezone),
    temperature: currentTemperature,
    conditionCode: currentCondition.code,
    conditionLabel: currentCondition.label,
    windSpeed: windSpeed(current.windSpeed, input.unit),
    humidity: Number.isFinite(Number(current.humidity))
      ? Math.round(Number(current.humidity) * 100)
      : undefined,
    precipitation: Number.isFinite(Number(current.precipitationIntensity))
      ? Number(current.precipitationIntensity)
      : undefined,
    isDay: current.daylight === undefined ? undefined : Boolean(current.daylight),
  };
  return {
    locationName: input.place.admin1 ? `${input.place.name}, ${input.place.admin1}` : input.place.name,
    latitude: input.place.latitude,
    longitude: input.place.longitude,
    timezone: input.timezone,
    unit: input.unit,
    source: 'Apple Weather',
    attributionURL: 'https://weatherkit.apple.com/legal-attribution.html',
    current: {
      ...normalizedCurrent,
      tempMin: Math.round(today?.tempMin ?? currentTemperature),
      tempMax: Math.round(today?.tempMax ?? currentTemperature),
    },
    hourly,
    daily,
  };
}

export async function fetchWeatherKitBrief(
  input: {
    place: GeocodedPlace;
    timezone: string;
    unit: TemperatureUnit;
  },
  options: {
    fetchImpl?: WeatherKitFetchLike;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const config = weatherKitConfiguration(options.environment);
  if (!config) throw new Error('WeatherKit is not configured.');
  const params = new URLSearchParams({
    dataSets: 'currentWeather,forecastHourly,forecastDaily',
    timezone: input.timezone,
  });
  const url =
    `https://weatherkit.apple.com/api/v1/weather/en-US/${input.place.latitude}/${input.place.longitude}` +
    `?${params.toString()}`;
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as WeatherKitFetchLike);
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${weatherKitProviderToken(config)}` },
  });
  if (!response.ok) {
    throw new Error(`WeatherKit forecast failed (${response.status}).`);
  }
  return normalizeWeatherKitResponse(await response.json(), input);
}
