import { getAiRequestContext } from '../ai/context';
import { api, convexQuery } from '../hosted/convex';
import { withDeadline } from '../shared/deadline';
import type { DailyReport, DailyReportCalendarItem } from '../shared/types';
import {
  type BriefWeather,
  briefWeather,
  cityFromTimezone,
  defaultUnitForTimezone,
  type FetchLike,
  resolveWeatherPlace,
} from '../weather/open-meteo';
import {
  fetchWeatherKitBrief,
  type WeatherKitFetchLike,
  weatherKitConfiguration,
} from '../weather/weatherkit';

// Real local weather for the brief. Since 2026-09-03 the weather is context
// for the prose only: one sentence the model may weave into the lede or the
// week ahead. It is never a node in the document.

const WEATHER_DEADLINE_MS = 12_000;

// The compact, prompt-ready weather shape.
export interface BriefWeatherPack {
  location: string;
  latitude: number;
  longitude: number;
  timezone: string;
  unit: '°F' | '°C';
  temperatureUnit: 'fahrenheit' | 'celsius';
  source?: string;
  attributionURL?: string;
  current: {
    temp: number;
    condition: string;
    conditionCode: string;
    high: number;
    low: number;
    windSpeed?: number;
    humidity?: number;
  };
  hourly: Array<{ hour: string; temp: number; condition: string }>;
  daily: Array<{ day: string; condition: string; high: number; low: number; precipChance?: number }>;
}

function hourLabel(timeIso: string): string {
  const match = /T(\d{2})/.exec(timeIso);
  if (!match) return timeIso;
  const hour = Number(match[1]);
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

// BriefWeather → the compact pack. Pure and exported so the shape is tested.
export function toBriefWeather(weather: BriefWeather): BriefWeatherPack {
  return {
    location: weather.locationName,
    latitude: weather.latitude,
    longitude: weather.longitude,
    timezone: weather.timezone,
    unit: weather.unit === 'fahrenheit' ? '°F' : '°C',
    temperatureUnit: weather.unit,
    source: weather.source,
    attributionURL: weather.attributionURL,
    current: {
      temp: Math.round(weather.current.temperature),
      condition: weather.current.conditionLabel,
      conditionCode: weather.current.conditionCode,
      high: weather.current.tempMax,
      low: weather.current.tempMin,
      windSpeed: weather.current.windSpeed !== undefined ? Math.round(weather.current.windSpeed) : undefined,
      humidity: weather.current.humidity,
    },
    hourly: weather.hourly.slice(0, 12).map((point) => ({
      hour: hourLabel(point.timeIso),
      temp: Math.round(point.temperature),
      condition: point.conditionCode,
    })),
    daily: weather.daily.slice(0, 7).map((day) => ({
      day: day.label,
      condition: day.conditionCode,
      high: Math.round(day.tempMax),
      low: Math.round(day.tempMin),
      precipChance: day.precipitationChance !== undefined ? Math.round(day.precipitationChance) : undefined,
    })),
  };
}

// One plain sentence for the prose prompt.
export function weatherSentence(pack: BriefWeatherPack | null | undefined): string | null {
  if (!pack) return null;
  const rainy = pack.daily
    .filter((day) => typeof day.precipChance === 'number' && day.precipChance >= 50)
    .map((day) => day.day)
    .slice(0, 3);
  const base = `${pack.location}: ${pack.current.condition.toLowerCase()}, ${pack.current.temp}${pack.unit} now, high ${Math.round(pack.current.high)}${pack.unit}, low ${Math.round(pack.current.low)}${pack.unit}.`;
  return rainy.length ? `${base} Rain likely ${rainy.join(', ')}.` : base;
}

// Calendar locations that plausibly geocode (skip meeting links and rooms).
const NON_PLACE_LOCATION = /https?:\/\/|zoom|meet\.|teams|webex|conference room|room \d|call|dial/i;

export function weatherLocationCandidates(calendar: DailyReportCalendarItem[] | undefined): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const event of calendar ?? []) {
    const location = String(event.location || '').trim();
    if (!location || location.length < 4 || NON_PLACE_LOCATION.test(location)) continue;
    // Favor address-like strings: a comma ("Rochester, NY") or a digit+word mix.
    if (!/,|\d/.test(location)) continue;
    const key = location.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(location);
    if (candidates.length >= 3) break;
  }
  return candidates;
}

export interface GatherBriefWeatherOptions {
  weatherFetch?: FetchLike;
  weatherKitFetch?: WeatherKitFetchLike;
  weatherEnvironment?: NodeJS.ProcessEnv;
  storedLocation?: {
    latitude: number;
    longitude: number;
    label?: string;
    timezone?: string;
  } | null;
  mobilePreferencesQuery?: (userId: string) => Promise<any>;
}

export async function gatherBriefWeather(
  report: Pick<DailyReport, 'sections'>,
  userId?: string | null,
  opts: GatherBriefWeatherOptions = {},
): Promise<BriefWeatherPack | null> {
  const contextTimezone = getAiRequestContext().userTimezone;
  try {
    let storedLocation = opts.storedLocation;
    if (storedLocation === undefined && userId) {
      const preference = await (opts.mobilePreferencesQuery
        ? opts.mobilePreferencesQuery(userId)
        : convexQuery<any>((api as any).albatrossNotifications.mobilePreferences, { userId })
      ).catch(() => null);
      storedLocation =
        preference?.briefLocationEnabled === true &&
        Number.isFinite(preference?.briefLatitude) &&
        Number.isFinite(preference?.briefLongitude)
          ? {
              latitude: Number(preference.briefLatitude),
              longitude: Number(preference.briefLongitude),
              label: String(preference.briefLocationLabel || '').trim() || undefined,
              timezone: String(preference.timezone || '').trim() || undefined,
            }
          : null;
    }
    const timezone = storedLocation?.timezone || contextTimezone || 'UTC';
    const weatherInput = {
      latitude: storedLocation?.latitude,
      longitude: storedLocation?.longitude,
      place:
        storedLocation?.label ||
        (storedLocation ? cityFromTimezone(timezone) || 'Current location' : undefined),
      timezone,
      candidates: weatherLocationCandidates(report.sections?.calendar),
    };
    const resolved = await withDeadline(
      resolveWeatherPlace(weatherInput, opts.weatherFetch ? { fetchImpl: opts.weatherFetch } : {}),
      WEATHER_DEADLINE_MS,
      'Brief weather location',
    );
    if (!resolved) return null;
    const unit = defaultUnitForTimezone(timezone || resolved.timezone);
    let weather: BriefWeather | null = null;
    if (weatherKitConfiguration(opts.weatherEnvironment)) {
      try {
        weather = await withDeadline(
          fetchWeatherKitBrief(
            { place: resolved, timezone, unit },
            {
              fetchImpl: opts.weatherKitFetch,
              environment: opts.weatherEnvironment,
            },
          ),
          WEATHER_DEADLINE_MS,
          'WeatherKit forecast',
        );
      } catch (error) {
        console.warn(
          '[brief-weather] WeatherKit failed; using the forecast fallback:',
          error instanceof Error ? error.message : error,
        );
      }
    }
    weather ??= await withDeadline(
      briefWeather(
        {
          latitude: resolved.latitude,
          longitude: resolved.longitude,
          place: resolved.admin1 ? `${resolved.name}, ${resolved.admin1}` : resolved.name,
          timezone,
          unit,
        },
        opts.weatherFetch ? { fetchImpl: opts.weatherFetch } : {},
      ),
      WEATHER_DEADLINE_MS,
      'Brief weather fallback',
    );
    return weather ? toBriefWeather(weather) : null;
  } catch (err) {
    console.warn('[brief-weather] weather gathering failed (brief continues without it):', err);
    return null;
  }
}
