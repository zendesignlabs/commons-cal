import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { MemoryStore } from '../server/store.mjs';
import { validateCalendars, loadCalendars } from '../server/registry.mjs';
import { attachMetadata } from '../server/metadata.mjs';
const origin = 'https://commons.example.org';
const entry = (id, organizerToken = `secret-${id}`) => ({ id, name: id, organizerToken, demo: true, store: new MemoryStore() });
const setup = () => { const calendars = attachMetadata([entry('one'), entry('two')]); return { calendars, app: createApp({ calendars, publicOrigin: origin }) }; };
const event = () => ({ requestId: randomUUID(), title: 'Only calendar one', startDate: '2026-10-15', endDate: '2026-10-15', startTime: '18:00', endTime: '19:00', timezone: 'UTC' });
const range = '?from=2026-10-01&to=2026-11-01';

test('public slug and legacy alias are read only, even with a valid Origin', async () => {
  const c = entry('one'); c.viewToken = 'old-shared-link';
  const app = createApp({ calendars: [c], publicOrigin: origin });
  for (const slug of ['one', 'old-shared-link']) {
    await request(app).get(`/c/${slug}/api/events`).expect(200);
    await request(app).get(`/c/${slug}/feed.ics`).expect(200);
    await request(app).get(`/c/${slug}/new`).expect(403);
    await request(app).post(`/c/${slug}/api/events`).set('Origin', origin).send(event()).expect(403);
    await request(app).put(`/c/${slug}/api/config`).set('Origin', origin).send({}).expect(403);
  }
  assert.equal(c.store.items.size, 0);
});

test('organizer permissions, lists, writes, caches and feeds are isolated by calendar', async () => {
  const { app } = setup();
  await request(app).get('/c/two/api/events' + range).expect(200);
  const list = await request(app).get('/o/secret-one/api/calendars').expect(200);
  assert.deepEqual(list.body.calendars.map(c => c.id), ['one']);
  assert.doesNotMatch(list.text, /secret-two/);
  await request(app).get('/o/secret-one/c/two/api/config').expect(404);
  await request(app).post('/o/secret-one/c/two/api/events').set('Origin', origin).send(event()).expect(404);
  await request(app).post('/o/secret-one/c/one/api/events').set('Origin', origin).send(event()).expect(201);
  const one = await request(app).get('/c/one/api/events' + range).expect(200);
  assert.equal(one.body.events.length, 1);
  const two = await request(app).get('/c/two/api/events' + range).expect(200);
  assert.equal(two.body.events.length, 0);
  assert.doesNotMatch((await request(app).get('/c/two/feed.ics')).text, /Only calendar one/);
  assert.match((await request(app).get('/c/one/feed.ics')).text, /Only calendar one/);
});

test('one organizer can deliberately manage multiple calendars', async () => {
  const app = createApp({ calendars: [entry('one', 'shared-organizer'), entry('two', 'shared-organizer')] });
  const list = await request(app).get('/o/shared-organizer/api/calendars').expect(200);
  assert.deepEqual(list.body.calendars.map(c => c.id), ['one', 'two']);
});

test('FAQ and calendar identity persist across restart and stay scoped to their calendar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'commons-metadata-'));
  try {
    const make = () => createApp({ calendars: attachMetadata([entry('one'), entry('two')], dir), publicOrigin: origin });
    const app = make(), metadata = { name: 'Garden gatherings', description: 'A place to grow.', faq: [{ question: 'Where do we meet?', answer: 'At the community garden.' }] };
    await request(app).put('/o/secret-one/c/one/api/config').set('Origin', 'https://evil.example').send(metadata).expect(403);
    await request(app).put('/o/secret-one/c/one/api/config').set('Origin', origin).send({ ...metadata, organizerToken: 'stolen' }).expect(400);
    await request(app).put('/o/secret-one/c/one/api/config').set('Origin', origin).send(metadata).expect(200);
    const rebooted = make();
    const result = await request(rebooted).get('/c/one/api/config').expect(200);
    assert.equal(result.body.name, metadata.name); assert.deepEqual(result.body.faq, metadata.faq);
    const other = await request(rebooted).get('/c/two/api/config').expect(200);
    assert.deepEqual(other.body.faq, []); assert.equal(other.body.name, 'two');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registry fails closed for unsafe or ambiguous configuration', () => {
  assert.throws(() => validateCalendars([entry('../escape')]));
  assert.throws(() => validateCalendars([entry('one'), entry('one')]));
  assert.throws(() => validateCalendars([entry('one', 'one')]));
  assert.throws(() => validateCalendars([entry('one')], true));
  assert.throws(() => validateCalendars([{ ...entry('one'), collectionKey: 'same' }, { ...entry('two'), collectionKey: 'same' }]));
  assert.throws(() => loadCalendars({ NODE_ENV: 'production', RADICALE_URL: 'http://localhost/', RADICALE_USERNAME: 'user', RADICALE_PASSWORD: 'pass', CALENDAR_TOKEN: 'legacy' }));
});


test('calendar names are escaped in subscription metadata', async () => {
  const c = entry('one'); c.name = 'Hello\r\nATTENDEE:mailto:test@example.com';
  const response = await request(createApp({ calendars: [c] })).get('/c/one/feed.ics').expect(200);
  assert.doesNotMatch(response.text, /\r?\nATTENDEE:/);
  assert.match(response.text, /X-WR-CALNAME/);
});
