import Nylas from 'nylas';
import { googleNylasAdapter } from '@/lib/google/adapter';
import { type GoogleNylasAdapter, ROUTED_RESOURCES } from '@/lib/google/adapter/types';
import { GoogleApiError } from '@/lib/google/http';
import { isGoogleDirectGrant } from '@/lib/google/transport';
import { isNylasConfigured } from '@/lib/hosted/env';

let client: Nylas | null = null;
let routed: Nylas | null = null;

const routedResources = new Set<string>(ROUTED_RESOURCES);

function grantOf(args: any): unknown {
  return args?.identifier ?? args?.grantId;
}

/**
 * Wraps the Nylas client so that each call on a routed resource goes to the
 * direct Google adapter when its grant id is `google:<accountId>`, and to
 * Nylas otherwise. Callers keep one API for both transports.
 */
export function routeNylasClient<T extends object>(
  real: T,
  adapter: GoogleNylasAdapter = googleNylasAdapter,
): T {
  return new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !routedResources.has(prop) || !value || typeof value !== 'object') {
        return value;
      }
      const google = adapter[prop as keyof GoogleNylasAdapter];
      return new Proxy(value, {
        get(resource, method, resourceReceiver) {
          const original = Reflect.get(resource, method, resourceReceiver);
          if (typeof method !== 'string' || typeof original !== 'function') return original;
          return (args: any, ...rest: any[]) => {
            if (!isGoogleDirectGrant(grantOf(args))) return original.call(resource, args, ...rest);
            const handler = google?.[method];
            if (!handler) {
              return Promise.reject(
                new GoogleApiError(501, `${prop}.${method} is not available for a direct Google account.`),
              );
            }
            return handler(args, ...rest);
          };
        },
      });
    },
  });
}

export function requireNylas() {
  if (!isNylasConfigured()) {
    throw new Error('Nylas is not configured. Set NYLAS_API_KEY and NYLAS_CLIENT_ID.');
  }
  if (!client) {
    const timeoutSeconds = Number(process.env.NYLAS_TIMEOUT_SECONDS || 45);
    client = new Nylas({
      // isNylasConfigured() above guarantees the key is present.
      apiKey: process.env.NYLAS_API_KEY!,
      apiUri: process.env.NYLAS_API_URI || 'https://api.us.nylas.com',
      timeout: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 45,
    });
    routed = routeNylasClient(client);
  }
  return routed as Nylas;
}
