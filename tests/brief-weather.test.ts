import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import './tools/harness';
import {
  buildDataPrompt,
  gatherBriefExtras,
  HTML_ARTIFACT_BRIEF,
  toBriefWeather,
  weatherLocationCandidates,
} from '../lib/mail/agent-report';
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

describe('toBriefWeather', () => {
  test('produces the compact prompt pack', () => {
    const pack = toBriefWeather(WEATHER);
    expect(pack.location).toBe('Rochester, New York');
    expect(pack.unit).toBe('°F');
    expect(pack.current).toEqual({
      temp: 71,
      condition: 'Rain',
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

describe('brief weather in the data pack', () => {
  test('gatherBriefExtras fetches weather from the timezone city (injected fetch)', async () => {
    const extras = await withToolContext(async () =>
      gatherBriefExtras(reportFixture(), null, {
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
    expect(extras.weather?.location).toBe('New York');
    expect(extras.weather?.unit).toBe('°F');
    expect(extras.weather?.current.temp).toBe(71);
  });

  test('gatherBriefExtras uses WeatherKit for an explicitly shared iPhone location', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const extras = await withToolContext(async () =>
      gatherBriefExtras(reportFixture(), null, {
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

    expect(extras.weather).toMatchObject({
      location: 'Rochester, New York',
      source: 'Apple Weather',
      attributionURL: 'https://weatherkit.apple.com/legal-attribution.html',
    });
  });

  test('buildDataPrompt carries weather (and null when unresolved)', async () => {
    await withToolContext(async () => {
      const withWeather = buildDataPrompt(reportFixture(), {
        digests: [],
        voiceSamples: [],
        services: ['gmail'],
        weather: toBriefWeather(WEATHER),
      } as any);
      expect(withWeather).toContain('"weather"');
      expect(withWeather).toContain('Rochester, New York');

      const without = buildDataPrompt(reportFixture(), {
        digests: [],
        voiceSamples: [],
        services: ['gmail'],
        weather: null,
      } as any);
      expect(without).toContain('"weather": null');
    });
  });

  test('buildDataPrompt carries daily alignment and prioritizes matching handoffs', async () => {
    await withToolContext(async () => {
      const handoff = (id: string, situation: string) =>
        ({
          version: 1,
          id,
          source: 'test',
          sourceKey: id,
          kind: 'work',
          lane: 'focus',
          status: 'open',
          priority: 'normal',
          protected: false,
          situation,
          background: [],
          assessment: situation,
          recommendation: situation,
          evidence: [],
          primaryRef: { kind: 'work', id },
          relatedRefs: [],
          items: [
            {
              sourceKey: id,
              ref: { kind: 'work', id },
              situation,
              assessment: situation,
              recommendation: situation,
            },
          ],
          actions: [],
          generatedAt: 1,
        }) as any;
      const prompt = buildDataPrompt(
        reportFixture({
          handoffs: [
            handoff('billing', 'Review the billing launch'),
            handoff('passport', 'Renew the passport before the trip'),
          ],
          sections: {
            albatross: {
              dailyAlignment: {
                localDate: '2026-07-06',
                reflection: 'Shipped the migration.',
                tomorrowIntent: 'Finish passport renewal.',
              },
            },
          } as any,
        }),
        {
          digests: [],
          voiceSamples: [],
          services: ['gmail'],
          weather: null,
        } as any,
      );
      expect(prompt).toContain('"tomorrowIntent": "Finish passport renewal."');
      expect(prompt.indexOf('"id": "passport"')).toBeLessThan(prompt.indexOf('"id": "billing"'));
      expect(prompt).toContain('authoritative attention signal');
    });
  });
});

describe('artifact brief prompt', () => {
  test('specifies the weather module with its visual anatomy', () => {
    expect(HTML_ARTIFACT_BRIEF).toContain('WEATHER MODULE');
    expect(HTML_ARTIFACT_BRIEF).toContain('data.weather.current.temp');
    expect(HTML_ARTIFACT_BRIEF).toContain('data.weather.hourly');
    expect(HTML_ARTIFACT_BRIEF).toContain('data.weather.daily');
    expect(HTML_ARTIFACT_BRIEF).toContain('near the masthead/lede');
    expect(HTML_ARTIFACT_BRIEF).toContain('never invent weather');
    expect(HTML_ARTIFACT_BRIEF).toContain('Weather data by Apple Weather');
  });

  test('uses the second accent for headers and rules, with a safe fallback', () => {
    expect(HTML_ARTIFACT_BRIEF).toContain('--brief-accent-2');
    expect(HTML_ARTIFACT_BRIEF).toContain('var(--brief-accent-2, var(--brief-accent))');
    expect(HTML_ARTIFACT_BRIEF).toContain('section header');
  });

  test('carries the chart standard (clean axes, token strokes)', () => {
    expect(HTML_ARTIFACT_BRIEF).toContain('CHART STANDARD');
    expect(HTML_ARTIFACT_BRIEF).toContain('var(--brief-hairline)');
  });

  test('bans ALL-CAPS letter-spaced labels and demands sentence case', () => {
    expect(HTML_ARTIFACT_BRIEF).toContain('Do NOT set text in ALL CAPS');
    expect(HTML_ARTIFACT_BRIEF).toContain('text-transform: uppercase');
    expect(HTML_ARTIFACT_BRIEF).toContain('Sentence case everywhere');
  });

  test('dateline honesty: no city derived from timezone; weather location is the only place name', () => {
    expect(HTML_ARTIFACT_BRIEF).toContain('Dateline honesty');
    expect(HTML_ARTIFACT_BRIEF).toContain('never derive or print a city');
    expect(HTML_ARTIFACT_BRIEF).toContain('data.weather.location');
    expect(HTML_ARTIFACT_BRIEF).toContain('no city');
  });

  test('buildDataPrompt datelines in sentence case, in the context timezone', async () => {
    await withToolContext(async () => {
      const prompt = buildDataPrompt(reportFixture(), {
        digests: [],
        voiceSamples: [],
        services: ['gmail'],
        weather: null,
      } as any);
      // 2026-07-07T13:00Z in America/New_York (harness context) is 9:00 AM.
      expect(prompt).toContain('"localDate": "Jul 07, 2026"');
      expect(prompt).not.toContain('JUL 07');
      expect(prompt).toContain('"localTime": "9:00 AM"');
      expect(prompt).toContain('"timezone": "America/New_York"');
    });
  });
});
