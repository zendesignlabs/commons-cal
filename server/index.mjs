import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.mjs';
import { attachMetadata } from './metadata.mjs';
import { WorkspaceProvisioner } from './workspaces.mjs';
import { loadCalendars } from './registry.mjs';

const production = process.env.NODE_ENV === 'production';
const directory = process.env.CALENDAR_DATA_DIR || (!production ? '.local/calendar-data' : undefined);
const calendars = attachMetadata(loadCalendars(), directory);
const workspaces = new WorkspaceProvisioner({ calendars, directory, enabled: process.env.ALLOW_CALENDAR_CREATION === 'true' || !production && process.env.ALLOW_CALENDAR_CREATION !== 'false', demo: !production && !process.env.SIGNUP_RADICALE_URL, maxCalendars: Number(process.env.MAX_CALENDARS || 25), backend: { url: process.env.SIGNUP_RADICALE_URL, username: process.env.SIGNUP_RADICALE_USERNAME, password: process.env.SIGNUP_RADICALE_PASSWORD } });
const app = createApp({ calendars, workspaces, production, publicOrigin: process.env.PUBLIC_ORIGIN, adminPasswordHash: process.env.ADMIN_PASSWORD_HASH });
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (production) {
  // Hashed application assets contain no calendar data and can be cached safely.
  app.use('/assets', express.static(resolve(root, 'dist/assets'), { maxAge: '1y', immutable: true, setHeaders: res => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
  app.use(express.static(resolve(root, 'dist'), { index: false }));
  app.get(['/c/:token', '/c/:token/{*path}', '/o/:token', '/o/:token/{*path}'], (req, res) => res.sendFile(resolve(root, 'dist/index.html')));
  app.get(['/admin', '/admin/{*path}'], (req, res) => res.sendFile(resolve(root, 'dist/index.html')));
  app.get('/', (req, res) => res.sendFile(resolve(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(Number(process.env.PORT || 4010), process.env.HOST || '127.0.0.1', () => console.log(`Commons Calendar listening on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 4010}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
