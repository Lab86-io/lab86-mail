import { describe, expect, test } from 'bun:test';
import {
  briefWeather,
  cityFromTimezone,
  conditionFromWmoCode,
  defaultUnitForTimezone,
  fetchForecast,
  geocodePlace,
  localTimeOfDayFromIso,
  precipitationLevelFromMm,
  resolveWeatherPlace,
  toWeatherWidgetPayload,
  weatherSummaryLine,
} from '../lib/weather/open-meteo';

// ---------------------------------------------------------------------------
// Fake fetch — no network, ever.
// ---------------------------------------------------------------------------

const GEOCODE_HIT = {
  results: [
    {
      name: 'Rochester',
      latitude: 43.15,
      longitude: -77.62,
      timezone: 'America/New_York',
      country: 'United States',
      admin1: 'New York',
    },
  ],
};

const FORECAST = {
  timezone: 'America/New_York',
  current: {
    time: '2026-07-07T09:30',
    temperature_2m: 71.4,
    weather_code: 61,
    wind_speed_10m: 8.2,
    precipitation: 0.5,
    relative_humidity_2m: 64,
    is_day: 1,
  },
  hourly: {
    time: ['2026-07-07T08:00', '2026-07-07T09:00', '2026-07-07T10:00', '2026-07-07T11:00'],
    temperature_2m: [68, 70, 72, 74],
    weather_code: [2, 61, 61, 3],
  },
  daily: {
    time: ['2026-07-07', '2026-07-08', '2026-07-09'],
    weather_code: [61, 0, 3],
    temperature_2m_max: [78.2, 81.5, 75.1],
    temperature_2m_min: [61.3, 63.9, 58.8],
    precipitation_probability_max: [65, 10, 20],
  },
};

function fakeFetch(byUrl: (url: string) => { ok?: boolean; status?: number; body?: any }) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const res = byUrl(url);
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      json: async () => res.body ?? {},
    };
  };
  return { fetchImpl, calls };
}

const happyFetch = () =>
  fakeFetch((url) => (url.includes('geocoding-api') ? { body: GEOCODE_HIT } : { body: FORECAST }));

// ---------------------------------------------------------------------------

describe('WMO condition mapping', () => {
  test('maps representative codes', () => {
    expect(conditionFromWmoCode(0)).toEqual({ condition: 'clear', label: 'Clear' });
    expect(conditionFromWmoCode(2).condition).toBe('partly-cloudy');
    expect(conditionFromWmoCode(3).condition).toBe('overcast');
    expect(conditionFromWmoCode(45).condition).toBe('fog');
    expect(conditionFromWmoCode(55).condition).toBe('drizzle');
    expect(conditionFromWmoCode(61).condition).toBe('rain');
    expect(conditionFromWmoCode(65).condition).toBe('heavy-rain');
    expect(conditionFromWmoCode(66).condition).toBe('sleet');
    expect(conditionFromWmoCode(75).condition).toBe('snow');
    expect(conditionFromWmoCode(95).condition).toBe('thunderstorm');
    expect(conditionFromWmoCode(99).condition).toBe('hail');
  });

  test('unknown codes fall back to cloudy', () => {
    expect(conditionFromWmoCode(42).condition).toBe('cloudy');
    expect(conditionFromWmoCode(-1).condition).toBe('cloudy');
  });
});

describe('precipitation level', () => {
  test('buckets millimetres', () => {
    expect(precipitationLevelFromMm(undefined)).toBeUndefined();
    expect(precipitationLevelFromMm(0)).toBe('none');
    expect(precipitationLevelFromMm(0.4)).toBe('light');
    expect(precipitationLevelFromMm(2)).toBe('moderate');
    expect(precipitationLevelFromMm(9)).toBe('heavy');
  });
});

describe('timezone heuristics', () => {
  test('US-style timezones default to fahrenheit', () => {
    expect(defaultUnitForTimezone('America/New_York')).toBe('fahrenheit');
    expect(defaultUnitForTimezone('Pacific/Honolulu')).toBe('fahrenheit');
  });
  test('everywhere else defaults to celsius', () => {
    expect(defaultUnitForTimezone('Europe/Paris')).toBe('celsius');
    expect(defaultUnitForTimezone('America/Sao_Paulo')).toBe('celsius');
    expect(defaultUnitForTimezone(undefined)).toBe('celsius');
  });
  test('cityFromTimezone extracts a geocodable city', () => {
    expect(cityFromTimezone('America/New_York')).toBe('New York');
    expect(cityFromTimezone('Europe/Paris')).toBe('Paris');
    expect(cityFromTimezone('UTC')).toBeNull();
    expect(cityFromTimezone('')).toBeNull();
  });
});

describe('localTimeOfDayFromIso', () => {
  test('parses fractional hours and rejects garbage', () => {
    expect(localTimeOfDayFromIso('2026-07-07T09:30')).toBeCloseTo(9.5);
    expect(localTimeOfDayFromIso('2026-07-07T00:00')).toBe(0);
    expect(localTimeOfDayFromIso('nope')).toBeUndefined();
    expect(localTimeOfDayFromIso(undefined)).toBeUndefined();
  });
});

describe('geocodePlace', () => {
  test('returns the first hit', async () => {
    const { fetchImpl, calls } = happyFetch();
    const place = await geocodePlace('Rochester NY', { fetchImpl });
    expect(place?.name).toBe('Rochester');
    expect(place?.latitude).toBeCloseTo(43.15);
    expect(place?.admin1).toBe('New York');
    expect(calls[0]).toContain('name=Rochester%20NY');
  });

  test('returns null on empty input and no results', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { results: [] } }));
    expect(await geocodePlace('', { fetchImpl })).toBeNull();
    expect(await geocodePlace('Nowhereville', { fetchImpl })).toBeNull();
  });

  test('throws on persistent HTTP failure (after the retry)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ ok: false, status: 500 }));
    await expect(geocodePlace('Rochester', { fetchImpl, retryDelayMs: 1 })).rejects.toThrow('500');
    expect(calls).toHaveLength(2);
  });
});

describe('fetchForecast', () => {
  test('normalizes current, hourly, and daily', async () => {
    const { fetchImpl, calls } = happyFetch();
    const forecast = await fetchForecast(
      { latitude: 43.15, longitude: -77.62, unit: 'fahrenheit' },
      { fetchImpl },
    );
    expect(calls[0]).toContain('temperature_unit=fahrenheit');
    expect(calls[0]).toContain('wind_speed_unit=mph');
    expect(forecast.timezone).toBe('America/New_York');
    expect(forecast.current.temperature).toBeCloseTo(71.4);
    expect(forecast.current.conditionCode).toBe('rain');
    expect(forecast.current.conditionLabel).toBe('Rain');
    expect(forecast.current.humidity).toBe(64);
    // Hourly starts at the current hour (08:00 is in the past).
    expect(forecast.hourly[0].timeIso).toBe('2026-07-07T09:00');
    expect(forecast.daily).toHaveLength(3);
    expect(forecast.daily[0].label).toBe('Today');
    expect(forecast.daily[1].label).toBe('Wed');
    expect(forecast.daily[0].precipitationChance).toBe(65);
  });

  test('throws on persistent HTTP failure (after the retry)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ ok: false, status: 429 }));
    await expect(
      fetchForecast({ latitude: 0, longitude: 0 }, { fetchImpl, retryDelayMs: 1 }),
    ).rejects.toThrow('429');
    expect(calls).toHaveLength(2);
  });
});

// Open-Meteo is keyless and rate-limits per IP; on shared egress (Railway) a
// transient 429 used to silently cost the brief its weather module. One retry
// rides out the burst; hard client errors (404) still fail immediately.
describe('rate-limit retry', () => {
  const flakyFetch = (failStatus: number, body: any) => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      const failing = calls.length === 1;
      return {
        ok: !failing,
        status: failing ? failStatus : 200,
        json: async () => body,
      };
    };
    return { fetchImpl, calls };
  };

  test('geocodePlace retries a 429 once and succeeds', async () => {
    const { fetchImpl, calls } = flakyFetch(429, GEOCODE_HIT);
    const place = await geocodePlace('Rochester', { fetchImpl, retryDelayMs: 1 });
    expect(place?.name).toBe('Rochester');
    expect(calls).toHaveLength(2);
  });

  test('fetchForecast retries a 5xx once and succeeds', async () => {
    const { fetchImpl, calls } = flakyFetch(503, FORECAST);
    const forecast = await fetchForecast(
      { latitude: 43.15, longitude: -77.62 },
      { fetchImpl, retryDelayMs: 1 },
    );
    expect(forecast.timezone).toBe('America/New_York');
    expect(calls).toHaveLength(2);
  });

  test('does not retry a hard client error', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ ok: false, status: 404 }));
    await expect(geocodePlace('Rochester', { fetchImpl, retryDelayMs: 1 })).rejects.toThrow('404');
    expect(calls).toHaveLength(1);
  });
});

describe('resolveWeatherPlace', () => {
  test('explicit coordinates win without any network call', async () => {
    const { fetchImpl, calls } = happyFetch();
    const place = await resolveWeatherPlace({ latitude: 1, longitude: 2, place: 'Here' }, { fetchImpl });
    expect(place).toEqual({ name: 'Here', latitude: 1, longitude: 2 });
    expect(calls).toHaveLength(0);
  });

  test('falls through failed candidates to the timezone city', async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.includes('name=Conference') ? { body: { results: [] } } : { body: GEOCODE_HIT },
    );
    const place = await resolveWeatherPlace(
      { candidates: ['Conference Room B'], timezone: 'America/New_York' },
      { fetchImpl },
    );
    expect(place?.name).toBe('Rochester');
    expect(calls.length).toBe(2);
  });

  test('returns null when nothing resolves', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { results: [] } }));
    expect(await resolveWeatherPlace({ timezone: 'UTC' }, { fetchImpl })).toBeNull();
  });
});

describe('briefWeather + widget payload', () => {
  test('end-to-end shape', async () => {
    const { fetchImpl } = happyFetch();
    const weather = await briefWeather(
      { place: 'Rochester NY', timezone: 'America/New_York' },
      { fetchImpl },
    );
    expect(weather).not.toBeNull();
    expect(weather!.locationName).toBe('Rochester, New York');
    expect(weather!.unit).toBe('fahrenheit');
    expect(weather!.current.tempMax).toBe(78);
    expect(weather!.current.tempMin).toBe(61);
    expect(weather!.hourly.length).toBeLessThanOrEqual(12);

    const payload = toWeatherWidgetPayload({
      id: 'weather-test',
      locationName: weather!.locationName,
      forecast: {
        timezone: weather!.timezone,
        unit: weather!.unit,
        current: weather!.current,
        hourly: weather!.hourly,
        daily: weather!.daily,
      },
    });
    expect(payload.version).toBe('3.1');
    expect(payload.location.name).toBe('Rochester, New York');
    expect(payload.units.temperature).toBe('fahrenheit');
    expect(payload.current.temperature).toBe(71);
    expect(payload.current.conditionCode).toBe('rain');
    expect(payload.current.precipitationLevel).toBe('light');
    expect(payload.forecast).toHaveLength(3);
    expect(payload.forecast[0]).toEqual({ label: 'Today', conditionCode: 'rain', tempMin: 61, tempMax: 78 });
    expect(payload.time.localTimeOfDay).toBeCloseTo(9.5);
  });

  test('returns null when no place resolves', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { results: [] } }));
    expect(await briefWeather({ timezone: 'UTC' }, { fetchImpl })).toBeNull();
  });

  test('weatherSummaryLine reads naturally and includes rain chance', async () => {
    const { fetchImpl } = happyFetch();
    const weather = await briefWeather({ place: 'Rochester' }, { fetchImpl });
    const line = weatherSummaryLine(weather!);
    expect(line).toContain('Rochester, New York');
    expect(line).toContain('°F, Rain');
    expect(line).toContain('high 78°F / low 61°F');
    expect(line).toContain('65% chance of precipitation');
  });
});
