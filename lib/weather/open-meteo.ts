// Open-Meteo weather client — free, no API key.
//
// Two endpoints:
//   - Geocoding: https://geocoding-api.open-meteo.com/v1/search
//   - Forecast:  https://api.open-meteo.com/v1/forecast
//
// Every function takes an injectable fetch so tests never hit the network.
// Output is shaped for the tool-ui weather widget payload
// (components/tool-ui/weather-widget/schema-runtime.ts) plus a compact
// `brief` shape the Daily Brief prompt can lay out as a designed module.

import type {
  ForecastDay,
  PrecipitationLevel,
  TemperatureUnit,
  WeatherConditionCode,
  WeatherWidgetPayload,
} from '@/components/tool-ui/weather-widget/schema-runtime';

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface GeocodedPlace {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country?: string;
  admin1?: string;
}

export interface HourlyPoint {
  timeIso: string;
  temperature: number;
  conditionCode: WeatherConditionCode;
}

export interface DailyPoint {
  dateIso: string;
  label: string;
  conditionCode: WeatherConditionCode;
  tempMin: number;
  tempMax: number;
  precipitationChance?: number;
}

export interface NormalizedForecast {
  timezone: string;
  unit: TemperatureUnit;
  current: {
    timeIso: string;
    temperature: number;
    conditionCode: WeatherConditionCode;
    conditionLabel: string;
    windSpeed?: number;
    humidity?: number;
    precipitation?: number;
    isDay?: boolean;
  };
  hourly: HourlyPoint[];
  daily: DailyPoint[];
}

export interface BriefWeather {
  locationName: string;
  latitude: number;
  longitude: number;
  timezone: string;
  unit: TemperatureUnit;
  current: NormalizedForecast['current'] & { tempMin: number; tempMax: number };
  hourly: HourlyPoint[];
  daily: DailyPoint[];
}

// ---------------------------------------------------------------------------
// WMO weather interpretation codes → tool-ui condition codes + labels
// ---------------------------------------------------------------------------

const WMO_CONDITIONS: Array<[codes: number[], condition: WeatherConditionCode, label: string]> = [
  [[0], 'clear', 'Clear'],
  [[1], 'partly-cloudy', 'Mostly clear'],
  [[2], 'partly-cloudy', 'Partly cloudy'],
  [[3], 'overcast', 'Overcast'],
  [[45, 48], 'fog', 'Fog'],
  [[51, 53, 55, 56, 57], 'drizzle', 'Drizzle'],
  [[61, 63, 80, 81], 'rain', 'Rain'],
  [[65, 82], 'heavy-rain', 'Heavy rain'],
  [[66, 67], 'sleet', 'Freezing rain'],
  [[71, 73, 75, 77, 85, 86], 'snow', 'Snow'],
  [[95], 'thunderstorm', 'Thunderstorm'],
  [[96, 99], 'hail', 'Thunderstorm with hail'],
];

export function conditionFromWmoCode(code: number): {
  condition: WeatherConditionCode;
  label: string;
} {
  for (const [codes, condition, label] of WMO_CONDITIONS) {
    if (codes.includes(code)) return { condition, label };
  }
  return { condition: 'cloudy', label: 'Cloudy' };
}

export function precipitationLevelFromMm(mm: number | undefined): PrecipitationLevel | undefined {
  if (mm === undefined || !Number.isFinite(mm)) return undefined;
  if (mm <= 0) return 'none';
  if (mm < 1) return 'light';
  if (mm < 4) return 'moderate';
  return 'heavy';
}

// America/* plus a few holdouts default to Fahrenheit; everywhere else Celsius.
export function defaultUnitForTimezone(timezone: string | undefined): TemperatureUnit {
  const tz = String(timezone || '');
  if (
    /^America\//.test(tz) &&
    !/America\/(Argentina|Sao_Paulo|Bogota|Lima|Santiago|Mexico_City|Montevideo|Caracas|La_Paz|Guayaquil)/.test(
      tz,
    )
  ) {
    return 'fahrenheit';
  }
  if (/^Pacific\/(Honolulu|Guam|Pago_Pago)/.test(tz)) return 'fahrenheit';
  return 'celsius';
}

// "America/New_York" → "New York" — a graceful geocoding fallback when we know
// the user's timezone but have no explicit location on file.
export function cityFromTimezone(timezone: string | undefined): string | null {
  const tz = String(timezone || '').trim();
  const city = tz.split('/').pop()?.replace(/_/g, ' ').trim();
  if (!city || city === tz || /^(UTC|GMT|Etc)/i.test(tz)) return null;
  return city;
}

// ---------------------------------------------------------------------------
// API calls (fetch injected for tests)
// ---------------------------------------------------------------------------

const GEOCODE_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';

export async function geocodePlace(
  name: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<GeocodedPlace | null> {
  const query = String(name || '').trim();
  if (!query) return null;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = `${GEOCODE_BASE}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Open-Meteo geocoding failed (${res.status})`);
  const data = await res.json();
  const hit = Array.isArray(data?.results) ? data.results[0] : null;
  if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) return null;
  return {
    name: String(hit.name || query),
    latitude: Number(hit.latitude),
    longitude: Number(hit.longitude),
    timezone: typeof hit.timezone === 'string' ? hit.timezone : undefined,
    country: typeof hit.country === 'string' ? hit.country : undefined,
    admin1: typeof hit.admin1 === 'string' ? hit.admin1 : undefined,
  };
}

export async function fetchForecast(
  input: { latitude: number; longitude: number; unit?: TemperatureUnit; days?: number },
  opts: { fetchImpl?: FetchLike } = {},
): Promise<NormalizedForecast> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const unit: TemperatureUnit = input.unit ?? 'celsius';
  const days = Math.min(Math.max(input.days ?? 7, 1), 7);
  const params = [
    `latitude=${input.latitude}`,
    `longitude=${input.longitude}`,
    'current=temperature_2m,weather_code,wind_speed_10m,precipitation,relative_humidity_2m,is_day',
    'hourly=temperature_2m,weather_code',
    'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    `forecast_days=${days}`,
    'timezone=auto',
    `temperature_unit=${unit}`,
    `wind_speed_unit=${unit === 'fahrenheit' ? 'mph' : 'kmh'}`,
  ].join('&');
  const res = await fetchImpl(`${FORECAST_BASE}?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo forecast failed (${res.status})`);
  const data = await res.json();

  const current = data?.current ?? {};
  const { condition, label } = conditionFromWmoCode(Number(current.weather_code ?? -1));

  // Hourly: from the current hour forward only.
  const hourlyTimes: string[] = Array.isArray(data?.hourly?.time) ? data.hourly.time : [];
  const nowIso = typeof current.time === 'string' ? current.time : '';
  const hourly: HourlyPoint[] = [];
  for (let i = 0; i < hourlyTimes.length; i++) {
    if (nowIso && hourlyTimes[i] < nowIso.slice(0, 13)) continue;
    const temperature = Number(data.hourly.temperature_2m?.[i]);
    if (!Number.isFinite(temperature)) continue;
    hourly.push({
      timeIso: hourlyTimes[i],
      temperature,
      conditionCode: conditionFromWmoCode(Number(data.hourly.weather_code?.[i] ?? -1)).condition,
    });
    if (hourly.length >= 24) break;
  }

  const dailyTimes: string[] = Array.isArray(data?.daily?.time) ? data.daily.time : [];
  const daily: DailyPoint[] = dailyTimes
    .map((dateIso: string, i: number) => {
      const tempMax = Number(data.daily.temperature_2m_max?.[i]);
      const tempMin = Number(data.daily.temperature_2m_min?.[i]);
      const chance = Number(data.daily.precipitation_probability_max?.[i]);
      return {
        dateIso,
        label: dayLabel(dateIso, i),
        conditionCode: conditionFromWmoCode(Number(data.daily.weather_code?.[i] ?? -1)).condition,
        tempMin,
        tempMax,
        precipitationChance: Number.isFinite(chance) ? chance : undefined,
      };
    })
    .filter((d: DailyPoint) => Number.isFinite(d.tempMin) && Number.isFinite(d.tempMax));

  return {
    timezone: typeof data?.timezone === 'string' ? data.timezone : 'UTC',
    unit,
    current: {
      timeIso: nowIso,
      temperature: Number(current.temperature_2m ?? Number.NaN),
      conditionCode: condition,
      conditionLabel: label,
      windSpeed: Number.isFinite(Number(current.wind_speed_10m)) ? Number(current.wind_speed_10m) : undefined,
      humidity: Number.isFinite(Number(current.relative_humidity_2m))
        ? Number(current.relative_humidity_2m)
        : undefined,
      precipitation: Number.isFinite(Number(current.precipitation))
        ? Number(current.precipitation)
        : undefined,
      isDay: current.is_day === undefined ? undefined : Boolean(Number(current.is_day)),
    },
    hourly,
    daily,
  };
}

function dayLabel(dateIso: string, index: number): string {
  if (index === 0) return 'Today';
  const date = new Date(`${dateIso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateIso;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(date);
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

// 0–24 fractional local hour from an Open-Meteo local ISO time ("2026-07-07T09:30").
export function localTimeOfDayFromIso(timeIso: string | undefined): number | undefined {
  const match = /T(\d{2}):(\d{2})/.exec(String(timeIso || ''));
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
  return Math.min(24, Math.max(0, hours + minutes / 60));
}

export function toWeatherWidgetPayload(input: {
  id: string;
  locationName: string;
  forecast: NormalizedForecast;
}): WeatherWidgetPayload {
  const { forecast } = input;
  const today = forecast.daily[0];
  const forecastDays: ForecastDay[] = forecast.daily.slice(0, 7).map((d) => ({
    label: d.label,
    conditionCode: d.conditionCode,
    tempMin: Math.round(d.tempMin),
    tempMax: Math.round(d.tempMax),
  }));
  return {
    version: '3.1',
    id: input.id,
    location: { name: input.locationName },
    units: { temperature: forecast.unit },
    current: {
      conditionCode: forecast.current.conditionCode,
      temperature: Math.round(forecast.current.temperature),
      tempMin: Math.round(today?.tempMin ?? forecast.current.temperature),
      tempMax: Math.round(today?.tempMax ?? forecast.current.temperature),
      windSpeed:
        forecast.current.windSpeed !== undefined ? Math.round(forecast.current.windSpeed) : undefined,
      precipitationLevel: precipitationLevelFromMm(forecast.current.precipitation),
    },
    forecast: forecastDays,
    time: { localTimeOfDay: localTimeOfDayFromIso(forecast.current.timeIso) },
    updatedAt: new Date().toISOString(),
  };
}

// Resolve a place from (in order): explicit coordinates, a place name, a list
// of candidate location strings (e.g. calendar event locations), or the
// timezone's city. Returns null when nothing resolves — callers skip weather
// gracefully.
export async function resolveWeatherPlace(
  input: {
    latitude?: number;
    longitude?: number;
    place?: string;
    candidates?: string[];
    timezone?: string;
  },
  opts: { fetchImpl?: FetchLike } = {},
): Promise<GeocodedPlace | null> {
  if (Number.isFinite(input.latitude) && Number.isFinite(input.longitude)) {
    return {
      name: input.place || `${input.latitude}, ${input.longitude}`,
      latitude: Number(input.latitude),
      longitude: Number(input.longitude),
    };
  }
  const tried = new Set<string>();
  const names = [input.place, ...(input.candidates ?? []), cityFromTimezone(input.timezone)]
    .map((value) => String(value || '').trim())
    .filter((value) => value.length > 1);
  for (const name of names) {
    const key = name.toLowerCase();
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      const hit = await geocodePlace(name, opts);
      if (hit) return hit;
    } catch {
      // A failed candidate is not fatal — try the next one.
    }
  }
  return null;
}

// One call for the Daily Brief and the show_weather tool: place resolution,
// forecast fetch, and shaping. Returns null when no location can be resolved.
export async function briefWeather(
  input: {
    latitude?: number;
    longitude?: number;
    place?: string;
    candidates?: string[];
    timezone?: string;
    unit?: TemperatureUnit;
  },
  opts: { fetchImpl?: FetchLike } = {},
): Promise<BriefWeather | null> {
  const resolved = await resolveWeatherPlace(input, opts);
  if (!resolved) return null;
  const unit = input.unit ?? defaultUnitForTimezone(input.timezone ?? resolved.timezone);
  const forecast = await fetchForecast(
    { latitude: resolved.latitude, longitude: resolved.longitude, unit },
    opts,
  );
  const today = forecast.daily[0];
  return {
    locationName: resolved.admin1 ? `${resolved.name}, ${resolved.admin1}` : resolved.name,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    timezone: forecast.timezone,
    unit,
    current: {
      ...forecast.current,
      tempMin: Math.round(today?.tempMin ?? forecast.current.temperature),
      tempMax: Math.round(today?.tempMax ?? forecast.current.temperature),
    },
    hourly: forecast.hourly.slice(0, 12),
    daily: forecast.daily,
  };
}

// A one-line text summary so the agent can reference the weather it just showed.
export function weatherSummaryLine(weather: BriefWeather): string {
  const unitSuffix = weather.unit === 'fahrenheit' ? '°F' : '°C';
  const parts = [
    `${weather.locationName}: ${Math.round(weather.current.temperature)}${unitSuffix}, ${weather.current.conditionLabel}`,
    `high ${weather.current.tempMax}${unitSuffix} / low ${weather.current.tempMin}${unitSuffix}`,
  ];
  const rainToday = weather.daily[0]?.precipitationChance;
  if (rainToday !== undefined && rainToday >= 20)
    parts.push(`${Math.round(rainToday)}% chance of precipitation`);
  return parts.join(' — ');
}
