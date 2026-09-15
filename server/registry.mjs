import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { MemoryStore, RadicaleStore } from './store.mjs';

const digest = value => createHash('sha256').update(value || '').digest();
export const matchesToken = (a, b) => !!a && !!b && timingSafeEqual(digest(a), digest(b));

export function validateCalendars(calendars, production = false, allowEmpty = false) {
  if (!Array.isArray(calendars) || (!calendars.length && !allowEmpty)) throw new Error('Configure at least one calendar.');
  const ids = new Set(), viewers = new Set(), collections = new Set();
  for (const c of calendars) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id) || ids.has(c.id)) throw new Error('Calendar IDs must be unique lowercase slugs.');
    if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 120) throw new Error('Calendar names must contain 1–120 characters.');
    if (typeof c.organizerToken !== 'string' || !/^[A-Za-z0-9_-]+$/.test(c.organizerToken) || c.organizerToken.length < (production ? 32 : 1)) throw new Error('Each calendar needs a strong organizer token.');
    if (calendars.some(other => matchesToken(c.id, other.organizerToken) || c.viewToken && (matchesToken(c.viewToken, other.organizerToken) || other !== c && matchesToken(c.viewToken, other.id))) || c.viewToken && viewers.has(c.viewToken)) throw new Error('Public slugs and legacy aliases must be unique and separate from organizer tokens.');
    if (c.collectionKey && collections.has(c.collectionKey)) throw new Error('Each calendar requires a separate storage collection.');
    if (c.description && (typeof c.description !== 'string' || c.description.length > 500)) throw new Error('Descriptions must be at most 500 characters.');
    ids.add(c.id); if (c.viewToken) viewers.add(c.viewToken); if (c.collectionKey) collections.add(c.collectionKey);
  }
  return calendars;
}

export function loadCalendars(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (production && env.DEMO_MODE === 'true') throw new Error('Demo mode is forbidden in production.');
  const demo = !production && (env.DEMO_MODE === 'true' || !env.RADICALE_URL && !env.CALENDARS_FILE);
  const entries = env.CALENDARS_FILE ? JSON.parse(readFileSync(env.CALENDARS_FILE, 'utf8')) : production && (env.ALLOW_CALENDAR_CREATION === 'true' || env.SIGNUP_RADICALE_URL) && !env.RADICALE_URL ? [] : [{
    id: env.CALENDAR_ID || 'community', name: env.CALENDAR_NAME || 'Community Calendar', description: env.CALENDAR_DESCRIPTION || 'Our meetings, shared plans, and space to connect.',
    viewToken: env.CALENDAR_TOKEN || (demo ? 'local-preview' : ''), organizerToken: env.ORGANIZER_TOKEN || (demo ? 'local-organizer' : ''),
    contactName: env.CONTACT_NAME || 'your organizer', radicale: { url: env.RADICALE_URL, username: env.RADICALE_USERNAME, password: env.RADICALE_PASSWORD },
  }];
  if (!Array.isArray(entries)) throw new Error('CALENDARS_FILE must contain an array.');
  const calendars = entries.map(c => {
    const backend = c.radicale || {};
    const password = backend.passwordEnv ? env[backend.passwordEnv] : backend.password;
    if (!demo && (!backend.url || !backend.username || !password)) throw new Error('Each calendar requires Radicale URL, username and password.');
    if (backend.url && !/^https?:$/.test(new URL(backend.url).protocol)) throw new Error('Radicale must use HTTP or HTTPS.');
    return { ...c, organizerToken: c.organizerTokenEnv ? env[c.organizerTokenEnv] : c.organizerToken, demo, collectionKey: !demo ? new URL(backend.url.endsWith('/') ? backend.url : backend.url + '/').href : undefined, store: demo ? new MemoryStore(true) : new RadicaleStore({ ...backend, password }) };
  });
  return validateCalendars(calendars, production, env.ALLOW_CALENDAR_CREATION === 'true' || !!env.SIGNUP_RADICALE_URL);
}
