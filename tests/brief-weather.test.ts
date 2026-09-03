import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import './tools/harness';
import {
  gatherBriefWeather,
  toBriefWeather,
  weatherLocationCandidates,
  weatherSentence,
} from '../lib/mail/brief-weather';
import type { DailyReport, DailyReportCalendarItem } from '../lib/shared/types';
import type { BriefWeather } from '../lib/weather/open-meteo';
import { withToolContext } from './tools/harness';

function reportFixture(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    _id: 'rep_1',
    kind: 'daily',
    generatedAt: Date.parse('2026-07-07T13:00:00Z'),
    status: 'ready',
    accounts: [],
    stats: { scanned: 0 },
    sections: {},
    ...overrides,
  } as unknown as DailyReport;
}

const WEATHER: BriefWeather = {
  locationName: 'Rochester, New York',
  latitude: 43.15,
  longitude: -77.62,
  timezone: 'America/New_York',
  unit: 'fahrenheit',
  current: {
    timeIso: '2026-07-07T09:30',
    temperature: 71.4,
    conditionCode: 'rain',
    conditionLabel: 'Rain',
    windSpeed: 8.2,
    humidity: 64,
    precipitation: 0.5,
    isDay: true,
    tempMin: 61,
    tempMax: 78,
  },
  hourly: [
    { timeIso: '2026-07-07T09:00', temperature: 70.2, conditionCode: 'rain' },
    { timeIso: '2026-07-07T13:00', temperature: 75.6, conditionCode: 'partly-cloudy' },
    { timeIso: '2026-07-08T00:00', temperature: 63.1, conditionCode: 'clear' },
  ],
  daily: [
    {
      dateIso: '2026-07-07',
      label: 'Today',
      conditionCode: 'rain',
      tempMin: 61.3,
      tempMax: 78.2,
      precipitationChance: 65,
    },
    { dateIso: '2026-07-08', label: 'Wed', conditionCode: 'clear', tempMin: 63.9, tempMax: 81.5 },
  ],
};

function openMeteoForecastJSON() {
  return {
    timezone: 'America/New_York',
    current: { time: '2026-07-24T09:30', temperature_2m: 72, weather_code: 1 },
    hourly: { time: ['2026-07-24T10:00'], temperature_2m: [74], weather_code: [1] },
    daily: {
      time: ['2026-07-24'],
      weather_code: [1],
      temperature_2m_max: [79],
      temperature_2m_min: [62],
      precipitation_probability_max: [10],
    },
  };
}

describe('toBriefWeather', () => {
  test('produces the compact prompt pack', () => {
    const pack = toBriefWeather(WEATHER);
    expect(pack.location).toBe('Rochester, New York');
    expect(pack.latitude).toBe(43.15);
    expect(pack.longitude).toBe(-77.62);
    expect(pack.timezone).toBe('America/New_York');
    expect(pack.unit).toBe('°F');
    expect(pack.temperatureUnit).toBe('fahrenheit');
    expect(pack.current).toEqual({
      temp: 71,
      condition: 'Rain',
      conditionCode: 'rain',
      high: 78,
      low: 61,
      windSpeed: 8,
      humidity: 64,
    });
    expect(pack.hourly).toEqual([
      { hour: '9 AM', temp: 70, condition: 'rain' },
      { hour: '1 PM', temp: 76, condition: 'partly-cloudy' },
      { hour: '12 AM', temp: 63, condition: 'clear' },
    ]);
    expect(pack.daily[0]).toEqual({ day: 'Today', condition: 'rain', high: 78, low: 61, precipChance: 65 });
    expect(pack.daily[1].precipChance).toBeUndefined();
  });

  test('weatherSentence is one plain sentence with rainy days named', () => {
    expect(weatherSentence(toBriefWeather(WEATHER))).toBe(
      'Rochester, New York: rain, 71°F now, high 78°F, low 61°F. Rain likely Today.',
    );
    expect(weatherSentence(null)).toBeNull();
  });
});

describe('weatherLocationCandidates', () => {
  const event = (location?: string): DailyReportCalendarItem =>
    ({
      account: 'a',
      eventId: 'e',
      title: 'Event',
      startAt: 1,
      endAt: 2,
      location,
    }) as unknown as DailyReportCalendarItem;

  test('keeps address-like locations, skips links and rooms', () => {
    const candidates = weatherLocationCandidates([
      event('https://zoom.us/j/123'),
      event('Conference Room B'),
      event('Lunch'),
      event('250 Main St, Rochester, NY'),
      event('250 Main St, Rochester, NY'), // deduped
      event('Paris, France'),
    ]);
    expect(candidates).toEqual(['250 Main St, Rochester, NY', 'Paris, France']);
  });

  test('handles missing calendars', () => {
    expect(weatherLocationCandidates(undefined)).toEqual([]);
    expect(weatherLocationCandidates([event(undefined)])).toEqual([]);
  });
});

describe('brief weather gathering', () => {
  test('gatherBriefWeather fetches weather from the timezone city (injected fetch)', async () => {
    const weather = await withToolContext(async () =>
      gatherBriefWeather(reportFixture(), null, {
        weatherFetch: async (url: string) => ({
          ok: true,
          status: 200,
          json: async () =>
            url.includes('geocoding-api')
              ? {
                  results: [
                    { name: 'New York', latitude: 40.7, longitude: -74, timezone: 'America/New_York' },
                  ],
                }
              : {
                  timezone: 'America/New_York',
                  current: { time: '2026-07-07T09:30', temperature_2m: 71, weather_code: 0 },
                  hourly: { time: ['2026-07-07T10:00'], temperature_2m: [73], weather_code: [0] },
                  daily: {
                    time: ['2026-07-07'],
                    weather_code: [0],
                    temperature_2m_max: [78],
                    temperature_2m_min: [61],
                    precipitation_probability_max: [5],
                  },
                },
        }),
      }),
    );
    expect(weather?.location).toBe('New York');
    expect(weather?.unit).toBe('°F');
    expect(weather?.current.temp).toBe(71);
  });

  test('gatherBriefWeather uses WeatherKit for an explicitly shared iPhone location', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const weather = await withToolContext(async () =>
      gatherBriefWeather(reportFixture(), null, {
        storedLocation: {
          latitude: 43.15,
          longitude: -77.62,
          label: 'Rochester, New York',
          timezone: 'America/New_York',
        },
        weatherEnvironment: {
          WEATHERKIT_KEY_ID: 'test-key',
          WEATHERKIT_TEAM_ID: 'test-team',
          WEATHERKIT_SERVICE_ID: 'io.lab86.mail.test',
          WEATHERKIT_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        },
        weatherKitFetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            currentWeather: {
              asOf: '2026-07-24T12:00:00Z',
              conditionCode: 'PartlyCloudy',
              temperature: 20,
              windSpeed: 16,
              humidity: 0.65,
              daylight: true,
            },
            forecastHourly: {
              hours: [
                {
                  forecastStart: '2026-07-24T13:00:00Z',
                  conditionCode: 'Rain',
                  temperature: 21,
                },
              ],
            },
            forecastDaily: {
              days: [
                {
                  forecastStart: '2026-07-24T04:00:00Z',
                  conditionCode: 'PartlyCloudy',
                  temperatureMin: 15,
                  temperatureMax: 25,
                  precipitationChance: 0.4,
                },
              ],
            },
          }),
        }),
      }),
    );

    expect(weather).toMatchObject({
      location: 'Rochester, New York',
      source: 'Apple Weather',
      attributionURL: 'https://weatherkit.apple.com/legal-attribution.html',
    });
  });

  test('loads only an explicitly opted-in stored location through mobile preferences', async () => {
    const queriedUsers: string[] = [];
    const requestedURLs: string[] = [];
    const weather = await withToolContext(async () =>
      gatherBriefWeather(reportFixture(), 'weather_user', {
        mobilePreferencesQuery: async (userId) => {
          queriedUsers.push(userId);
          return {
            briefLocationEnabled: true,
            briefLatitude: 43.15,
            briefLongitude: -77.62,
            briefLocationLabel: 'Rochester, New York',
            timezone: 'America/New_York',
          };
        },
        weatherFetch: async (url: string) => {
          requestedURLs.push(url);
          return { ok: true, status: 200, json: async () => openMeteoForecastJSON() };
        },
      }),
    );

    expect(queriedUsers).toEqual(['weather_user']);
    expect(requestedURLs).toHaveLength(1);
    expect(requestedURLs[0]).toContain('api.open-meteo.com/v1/forecast');
    expect(weather?.location).toBe('Rochester, New York');
  });

  test('ignores stored coordinates when location consent is disabled', async () => {
    const requestedURLs: string[] = [];
    await withToolContext(async () =>
      gatherBriefWeather(reportFixture(), 'weather_user', {
        mobilePreferencesQuery: async () => ({
          briefLocationEnabled: false,
          briefLatitude: 43.15,
          briefLongitude: -77.62,
          briefLocationLabel: 'Private location',
          timezone: 'America/New_York',
        }),
        weatherFetch: async (url: string) => {
          requestedURLs.push(url);
          return {
            ok: true,
            status: 200,
            json: async () =>
              url.includes('geocoding-api')
                ? {
                    results: [
                      {
                        name: 'New York',
                        latitude: 40.7,
                        longitude: -74,
                        timezone: 'America/New_York',
                      },
                    ],
                  }
                : openMeteoForecastJSON(),
          };
        },
      }),
    );

    expect(requestedURLs.some((url) => url.includes('geocoding-api'))).toBe(true);
    expect(requestedURLs.join(' ')).not.toContain('43.15');
  });

  test('falls back to Open-Meteo without resolving the same location twice when WeatherKit fails', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const requestedURLs: string[] = [];
    const weather = await withToolContext(async () =>
      gatherBriefWeather(reportFixture(), null, {
        storedLocation: {
          latitude: 43.15,
          longitude: -77.62,
          label: 'Rochester, New York',
          timezone: 'America/New_York',
        },
        weatherEnvironment: {
          WEATHERKIT_KEY_ID: 'test-key',
          WEATHERKIT_TEAM_ID: 'test-team',
          WEATHERKIT_SERVICE_ID: 'io.lab86.mail.test',
          WEATHERKIT_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        },
        weatherKitFetch: async () => {
          throw new Error('WeatherKit unavailable');
        },
        weatherFetch: async (url: string) => {
          requestedURLs.push(url);
          return { ok: true, status: 200, json: async () => openMeteoForecastJSON() };
        },
      }),
    );

    expect(requestedURLs).toHaveLength(1);
    expect(requestedURLs[0]).toContain('api.open-meteo.com/v1/forecast');
    expect(weather).toMatchObject({ location: 'Rochester, New York', current: { temp: 72 } });
  });
});
