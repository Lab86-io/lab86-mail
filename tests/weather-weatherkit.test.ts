import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  conditionFromWeatherKit,
  fetchWeatherKitBrief,
  normalizeWeatherKitResponse,
  weatherKitConfiguration,
  weatherKitProviderToken,
} from '../lib/weather/weatherkit';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const environment = {
  WEATHERKIT_KEY_ID: '2QQ6GFX97Y',
  WEATHERKIT_TEAM_ID: '5JZV7V6Y4Z',
  WEATHERKIT_SERVICE_ID: 'io.lab86.mail',
  WEATHERKIT_PRIVATE_KEY: pem,
} as NodeJS.ProcessEnv;

const place = {
  name: 'Rochester',
  admin1: 'New York',
  latitude: 43.15,
  longitude: -77.62,
};

const payload = {
  currentWeather: {
    asOf: '2026-07-24T12:00:00Z',
    conditionCode: 'PartlyCloudy',
    temperature: 20,
    windSpeed: 16,
    humidity: 0.65,
    precipitationIntensity: 0,
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
};

describe('WeatherKit Daily Brief provider', () => {
  test('builds the Apple-required developer token claims without exposing the key', () => {
    const config = weatherKitConfiguration(environment)!;
    const token = weatherKitProviderToken(config, 1_800_000_000);
    const [headerPart, claimsPart, signature] = token.split('.');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString());

    expect(header).toEqual({
      alg: 'ES256',
      kid: environment.WEATHERKIT_KEY_ID,
      id: `${environment.WEATHERKIT_TEAM_ID}.${environment.WEATHERKIT_SERVICE_ID}`,
    });
    expect(claims).toEqual({
      iss: environment.WEATHERKIT_TEAM_ID,
      iat: 1_800_000_000,
      exp: 1_800_002_700,
      sub: environment.WEATHERKIT_SERVICE_ID,
    });
    expect(signature.length).toBeGreaterThan(40);
  });

  test('normalizes WeatherKit Celsius/fractions into the existing brief contract', () => {
    const weather = normalizeWeatherKitResponse(payload, {
      place,
      timezone: 'America/New_York',
      unit: 'fahrenheit',
    });

    expect(weather.locationName).toBe('Rochester, New York');
    expect(weather.source).toBe('Apple Weather');
    expect(weather.attributionURL).toContain('weatherkit.apple.com');
    expect(weather.current.temperature).toBeCloseTo(68);
    expect(weather.current.tempMin).toBe(59);
    expect(weather.current.tempMax).toBe(77);
    expect(weather.current.humidity).toBe(65);
    expect(weather.daily[0].precipitationChance).toBe(40);
    expect(weather.hourly[0].conditionCode).toBe('rain');
  });

  test('authenticates the REST request and asks only for brief datasets', async () => {
    let requestURL = '';
    let authorization = '';
    const weather = await fetchWeatherKitBrief(
      { place, timezone: 'America/New_York', unit: 'celsius' },
      {
        environment,
        fetchImpl: async (url, init) => {
          requestURL = url;
          authorization = String((init?.headers as Record<string, string>)?.authorization || '');
          return { ok: true, status: 200, json: async () => payload };
        },
      },
    );

    expect(requestURL).toContain('weatherkit.apple.com/api/v1/weather/en-US/43.15/-77.62');
    expect(requestURL).toContain('currentWeather%2CforecastHourly%2CforecastDaily');
    expect(requestURL).toContain('timezone=America%2FNew_York');
    expect(authorization.startsWith('Bearer ')).toBe(true);
    expect(weather.source).toBe('Apple Weather');
  });

  test('maps hazardous and unknown conditions into supported visual codes', () => {
    expect(conditionFromWeatherKit('HeavySnow').code).toBe('snow');
    expect(conditionFromWeatherKit('StrongStorms').code).toBe('thunderstorm');
    expect(conditionFromWeatherKit('FutureCondition')).toEqual({
      code: 'cloudy',
      label: 'Future Condition',
    });
  });
});
