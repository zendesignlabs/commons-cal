import express from 'express';
import { AdminAuth, mountAdmin } from './admin.mjs';
import ICAL from 'ical.js';
import helmet from 'helmet';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import { matchesToken, validateCalendars } from './registry.mjs';
import { DateTime } from 'luxon';
import { expandEvents, validateEvent } from './calendar.mjs';

export function createApp({ calendars, workspaces, production = false, publicOrigin = '', adminAuth, adminPasswordHash = '' }) {
  validateCalendars(calendars, false, true);
  const caches = new Map();
  const app = express();
  app.disable('x-powered-by');
  app.use(compression());
  app.use(helmet({ contentSecurityPolicy: production ? { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], fontSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null } } : false, referrerPolicy: { policy: 'no-referrer' }, strictTransportSecurity: false }));
  app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); res.set('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/readyz', async (req, res) => { try { await Promise.all(calendars.map(c => c.store.read())); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  const unavailable = (res) => res.status(404).type('html').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Link unavailable · Commons</title><h1>This calendar link is unavailable.</h1><p>Ask your organizer for the current link.</p></html>');
  app.use('/c/:token', (req, res, next) => {
    req.calendar = calendars.find(c => req.params.token === c.id || matchesToken(req.params.token, c.viewToken));
    if (!req.calendar) return unavailable(res);
    req.canWrite = false;
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(403).json({ error: 'This link is view only. Use your organizer link to add events.' });
    if (/^\/new(?:\/|$)/.test(req.path)) return res.status(403).type('text/plain').send('This calendar is view only. Use your organizer link to add events.');
    next();
  });
  app.use('/o/:token', (req, res, next) => {
    req.allowedCalendars = calendars.filter(c => matchesToken(req.params.token, c.organizerToken));
    if (!req.allowedCalendars.length) return unavailable(res);
    req.organizerBase = `/o/${req.params.token}`;
    next();
  });
  app.get('/o/:token/api/calendars', (req, res) => res.json({ creationEnabled: !!workspaces?.enabled, calendars: req.allowedCalendars.map(c => ({ id: c.id, name: c.name, description: c.description || '', path: `${req.organizerBase}/c/${c.id}`, viewPath: `/c/${c.id}/` })) }));
  app.use('/o/:token/c/:id', (req, res, next) => {
    req.calendar = req.allowedCalendars.find(c => c.id === req.params.id);
    if (!req.calendar) return unavailable(res);
    req.canWrite = true;
    next();
  });
  const base = ['/c/:token', '/o/:token/c/:id'];
  const paths = suffix => base.map(b => b + suffix);
  app.get(paths('/api/config'), (req, res) => {
    const c = req.calendar;
    res.json({ demo: !!c.demo, contactName: c.contactName || 'your organizer', name: c.name, description: c.description || '', faq: c.faq || [], canWrite: req.canWrite, viewPath: `/c/${c.id}/`, ...(req.canWrite ? { workspacePath: req.organizerBase } : {}) });
  });
  const load = async c => {
    const cache = caches.get(c.id);
    if (cache && Date.now() - cache.time < 15000) return { ...cache, stale: false };
    try { const ics = await c.store.read(); const fresh = { ics, time: Date.now() }; caches.set(c.id, fresh); return { ...fresh, stale: false }; }
    catch (e) { if (cache) return { ...cache, stale: true }; throw e; }
  };
  app.get(paths('/api/events'), async (req, res, next) => {
    try {
      const from = req.query.from ? DateTime.fromISO(req.query.from, { zone: 'UTC' }) : DateTime.utc().startOf('day');
      const to = req.query.to ? DateTime.fromISO(req.query.to, { zone: 'UTC' }) : from.plus({ months: 4 });
      if (!from.isValid || !to.isValid || to <= from || to.diff(from, 'days').days > 400 || from.year < 2020 || to.year > 2102) return res.status(400).json({ error: 'Choose a date range of up to 400 days.' });
      const result = await load(req.calendar);
      res.json({ events: expandEvents(result.ics, from.toMillis(), to.toMillis()), stale: result.stale, updatedAt: new Date(result.time).toISOString() });
    } catch (e) { next(e); }
  });
  app.get(paths('/feed.ics'), async (req, res, next) => {
    try { const result = await load(req.calendar); if (result.stale) return res.status(503).type('text/plain').send('Calendar temporarily unavailable. Please retry later.'); const feed = new ICAL.Component(ICAL.parse(result.ics)); const name = new ICAL.Property('x-wr-calname'); name.resetType('text'); name.setValue(req.calendar.name); feed.addProperty(name); res.type('text/calendar; charset=utf-8').set('Content-Disposition', `inline; filename="${req.calendar.id}.ics"`).send(feed.toString()); } catch (e) { next(e); }
  });
  const limit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: req => req.calendar.id, message: { error: 'The calendar has received many saves. Please try again in an hour.' } });
  app.get('/api/site', (req, res) => res.json({ creationEnabled: !!workspaces?.enabled }));
  const sameOriginJson = (req, res, next) => {
    const origin = req.get('origin');
    try {
      const expected = publicOrigin ? new URL(publicOrigin).origin : `${req.protocol}://${req.get('host')}`;
      // TLS commonly terminates at a reverse proxy. Match the host when no canonical origin is configured.
      if (!origin || (publicOrigin ? new URL(origin).origin !== expected : new URL(origin).host !== req.get('host'))) return res.status(403).json({ error: 'Please submit this form from the Commons website.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send details as JSON.' });
      next();
    } catch { res.status(403).json({ error: 'Please submit this form from the Commons website.' }); }
  };
  mountAdmin(app, { calendars, workspaces, auth: adminAuth || new AdminAuth({ passwordHash: adminPasswordHash, production }), sameOriginJson });
  const creationLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: () => 'instance', message: { error: 'Many calendars have been requested. Please try again in an hour.' } });
  app.post('/api/workspaces', creationLimit, sameOriginJson, express.json({ limit: '8kb' }), async (req, res, next) => {
    try {
      if (!workspaces?.enabled) return res.status(403).json({ error: 'New calendar creation is disabled on this instance.' });
      res.status(201).json(await workspaces.create(req.body));
    } catch (e) { next(e); }
  });
  app.post('/o/:token/api/calendars', creationLimit, sameOriginJson, express.json({ limit: '8kb' }), async (req, res, next) => {
    try {
      if (!workspaces?.enabled) return res.status(403).json({ error: 'New calendar creation is disabled on this instance.' });
      // Scope comes only from the authenticated organizer URL, never from the request body.
      res.status(201).json(await workspaces.create(req.body, req.allowedCalendars[0].organizerToken));
    } catch (e) { next(e); }
  });
  const writeGuard = (req, res, next) => {
    if (!req.canWrite) return res.status(403).json({ error: 'Organizer access required.' });
    return sameOriginJson(req, res, next);
  };
  app.put(paths('/api/config'), limit, writeGuard, express.json({ limit: '128kb' }), (req, res, next) => {
    try { req.calendar.saveMetadata(req.body); res.json({ ok: true }); } catch (e) { next(e); }
  });
  app.post(paths('/api/events'), limit, writeGuard, express.json({ limit: '24kb' }), async (req, res, next) => {
    try { const data = validateEvent(req.body); const event = await req.calendar.store.create(data); caches.delete(req.calendar.id); res.status(201).json(event); } catch (e) { next(e); }
  });
  const eventAccess = (req, res, next) => {
    if (!req.canWrite) return res.status(403).json({ error: 'Organizer access required.' });
    if (!req.params.uid || req.params.uid.length > 512 || /[\r\n]/.test(req.params.uid)) return res.status(400).json({ error: 'Invalid event identity.' });
    next();
  };
  app.get(paths('/api/events/:uid'), eventAccess, async (req, res, next) => {
    try { res.json(await req.calendar.store.get(req.params.uid)); } catch (e) { next(e); }
  });
  app.put(paths('/api/events/:uid'), eventAccess, limit, writeGuard, express.json({ limit: '24kb' }), async (req, res, next) => {
    try {
      if (!req.body?.values || typeof req.body.values !== 'object') return res.status(400).json({ error: 'Event details are required.' });
      const result = await req.calendar.store.update(req.params.uid, req.body.values, req.body.revision); caches.delete(req.calendar.id); res.json(result);
    } catch (e) { next(e); }
  });
  app.delete(paths('/api/events/:uid'), eventAccess, limit, writeGuard, express.json({ limit: '1kb' }), async (req, res, next) => {
    try { await req.calendar.store.delete(req.params.uid, req.body?.revision); caches.delete(req.calendar.id); res.status(204).end(); } catch (e) { next(e); }
  });
  app.use(paths('/api'), (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (error.fields) return res.status(400).json({ error: error.message, fields: error.fields });
    if ([400, 403, 404, 409].includes(error.status)) return res.status(error.status).json({ error: error.message });
    if (error.status === 413) return res.status(413).json({ error: 'The event is too large. Shorten its description.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'The event details could not be read.' });
    console.error('Calendar request failed:', error.name);
    res.status(503).json({ error: req.path === '/api/workspaces' ? 'We couldn’t finish creating your workspace. Your details are still here; retrying is safe.' : 'We can’t reach the calendar right now. Please try again. Your entered details are still here.' });
  });
  return app;
}
