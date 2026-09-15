import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

const derive = promisify(scrypt);
const options = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const format = /^scrypt:131072:8:1:([a-f0-9]{32}):([a-f0-9]{128})$/;
export async function hashAdminPassword(password) {
  if (typeof password !== 'string' || password.length < 16 || Buffer.byteLength(password) > 1024) throw new Error('Use an admin password of at least 16 characters and at most 1024 bytes.');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, Buffer.from(salt, 'hex'), 64, options);
  return `scrypt:131072:8:1:${salt}:${key.toString('hex')}`;
}
export class AdminAuth {
  constructor({ passwordHash = '', production = false, now = Date.now, lifetimeMs = 2 * 60 * 60 * 1000 } = {}) {
    this.hash = passwordHash ? format.exec(passwordHash) : null;
    if (passwordHash && !this.hash) throw new Error('Invalid ADMIN_PASSWORD_HASH. Generate it with scripts/hash-admin-password.mjs.');
    this.cookieName = production ? '__Host-commons-admin' : 'commons-admin-dev';
    this.cookieOptions = { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
    this.sessions = new Map(); this.now = now; this.lifetimeMs = lifetimeMs; this.verifying = false;
  }
  get enabled() { return !!this.hash; }
  token(req) {
    const matches = (req.headers.cookie || '').split(';').map(c => c.trim()).filter(c => c.startsWith(this.cookieName + '='));
    if (matches.length !== 1) return '';
    const token = matches[0].slice(this.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
  }
  key(token) { return createHash('sha256').update(token).digest('hex'); }
  prune() { for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(key); }
  session(req) { this.prune(); return this.enabled && this.sessions.get(this.key(this.token(req))); }
  revoke(req) { this.sessions.delete(this.key(this.token(req))); }
  async verify(password) {
    if (!this.hash || typeof password !== 'string' || Buffer.byteLength(password) > 1024 || password.length === 0) return false;
    const key = await derive(password, Buffer.from(this.hash[1], 'hex'), 64, options);
    return timingSafeEqual(key, Buffer.from(this.hash[2], 'hex'));
  }
  login(req, res) {
    this.prune(); this.revoke(req);
    // Bound memory and expire the oldest session if an admin opens many devices.
    if (this.sessions.size >= 16) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url'), session = { expiresAt: this.now() + this.lifetimeMs };
    this.sessions.set(this.key(token), session);
    res.cookie(this.cookieName, token, { ...this.cookieOptions, maxAge: this.lifetimeMs });
    return session;
  }
}

export function mountAdmin(app, { calendars, workspaces, auth, sameOriginJson }) {
  const requireAdmin = (req, res, next) => {
    if (!auth.session(req)) return res.status(401).json({ error: 'Sign in as the server administrator to continue.' });
    next();
  };
  app.get('/admin/api/session', (req, res) => {
    const session = auth.session(req);
    res.json({ enabled: auth.enabled, authenticated: !!session, ...(session ? { expiresAt: session.expiresAt } : {}) });
  });
  // One instance-wide budget is deliberate: it works behind a proxy without trusting spoofable forwarded IPs.
  const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: () => 'admin-login', message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' } });
  app.post('/admin/api/login', sameOriginJson, loginLimit, express.json({ limit: '2kb' }), async (req, res, next) => {
    if (!auth.enabled) return res.status(503).json({ error: 'Server admin sign-in has not been configured.' });
    if (auth.verifying) return res.status(429).json({ error: 'A sign-in is already being checked. Try again shortly.' });
    auth.verifying = true;
    try {
      if (!await auth.verify(req.body?.password)) return res.status(401).json({ error: 'The admin password is incorrect.' });
      const session = auth.login(req, res);
      res.json({ enabled: true, authenticated: true, expiresAt: session.expiresAt });
    } catch (e) { next(e); } finally { auth.verifying = false; }
  });
  app.post('/admin/api/logout', sameOriginJson, (req, res) => {
    auth.revoke(req); res.clearCookie(auth.cookieName, auth.cookieOptions); res.status(204).end();
  });
  app.get('/admin/api/calendars', requireAdmin, (req, res) => {
    res.json({ calendars: calendars.map(c => ({ id: c.id, name: c.name, viewPath: `/c/${c.id}/`, scopeCount: calendars.filter(other => other.organizerToken === c.organizerToken).length })) });
  });
  app.get('/admin/api/calendars/:id/access', requireAdmin, (req, res) => {
    const c = calendars.find(c => c.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'This calendar is no longer available.' });
    res.json({ id: c.id, name: c.name, viewPath: `/c/${c.id}/`, workspacePath: `/o/${c.organizerToken}/`, scope: calendars.filter(other => other.organizerToken === c.organizerToken).map(({ id, name }) => ({ id, name })) });
  });
  app.get('/admin/api/settings', requireAdmin, (req, res) => {
    res.json({ creationEnabled: !!workspaces?.enabled, calendarCount: calendars.length, calendarLimit: workspaces?.maxCalendars ?? null, sessionHours: auth.lifetimeMs / 3600000 });
  });
  app.use('/admin/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
}
