import { googleCalendarAdapter } from './calendar';
import { googleContactsAdapter } from './contacts';
import { googleMailAdapter } from './mail';
import { type AdapterResource, type GoogleNylasAdapter, ROUTED_RESOURCES } from './types';

function merge(...parts: GoogleNylasAdapter[]): GoogleNylasAdapter {
  const out: GoogleNylasAdapter = {};
  for (const resource of ROUTED_RESOURCES) {
    const methods: AdapterResource = {};
    for (const part of parts) Object.assign(methods, part[resource] || {});
    if (Object.keys(methods).length) out[resource] = methods;
  }
  return out;
}

export const googleNylasAdapter: GoogleNylasAdapter = merge(
  googleMailAdapter,
  googleCalendarAdapter,
  googleContactsAdapter,
);
