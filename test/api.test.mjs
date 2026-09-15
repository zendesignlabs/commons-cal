import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { MemoryStore } from '../server/store.mjs';
const payload = () => ({ requestId: randomUUID(), title: 'Test community meeting', startDate: '2026-10-15', endDate: '2026-10-15', startTime: '18:00', endTime: '19:00', timezone: 'America/New_York' });
const make = store => createApp({ calendars: [{ id: 'community', name: 'Community Calendar', viewToken: 'test-link', organizerToken: 'organizer-link', store: store || new MemoryStore() }], production: true, publicOrigin: 'https://commons.example.org' });
const post = (app, data) => request(app).post('/o/organizer-link/c/community/api/events').set('Origin', 'https://commons.example.org').send(data);

test('unknown calendars and organizer tokens fail; public config exposes no credentials', async () => {
  const app = make();
  for (const path of ['/c/wrong/api/events', '/c/wrong/feed.ics', '/c/wrong/new']) await request(app).get(path).expect(404);
  await request(app).post('/c/wrong/api/events').send(payload()).expect(404);
  const result = await request(app).get('/c/test-link/api/config').expect(200);
  assert.equal(result.body.name, 'Community Calendar'); assert.equal(result.body.canWrite, false); assert.equal(result.body.viewPath, '/c/community/'); assert.doesNotMatch(result.text, /organizer-link|workspacePath|password/);
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
});
test('create persists to list and sanitized feed; retry is idempotent; conflict preserves original', async () => {
  const app = make(), data = payload();
  const first = await post(app, data).expect(201); await post(app, data).expect(201);
  await post(app, { ...data, title: 'Different content' }).expect(409);
  const list = await request(app).get('/c/test-link/api/events?from=2026-10-01&to=2026-11-01').expect(200);
  assert.equal(list.body.events.length, 1); assert.equal(list.body.events[0].uid, first.body.uid); assert.equal(list.body.events[0].title, data.title);
  const feed = await request(app).get('/c/test-link/feed.ics').expect(200);
  assert.match(feed.headers['content-type'], /text\/calendar/); assert.match(feed.text, /Test community meeting/); assert.doesNotMatch(feed.text, /ATTENDEE|ORGANIZER/);
});
test('writes reject cross-origin, absent-origin, malformed JSON and invalid fields', async () => {
  const app = make();
  await request(app).post('/o/organizer-link/c/community/api/events').send(payload()).expect(403);
  await request(app).post('/o/organizer-link/c/community/api/events').set('Origin', 'https://evil.example').send(payload()).expect(403);
  const bad = await post(app, { ...payload(), endTime: '17:00' }).expect(400); assert.ok(bad.body.fields.endTime);
  await request(app).post('/o/organizer-link/c/community/api/events').set('Origin', 'https://commons.example.org').set('Content-Type', 'application/json').send('{').expect(400);
  await request(app).get('/c/test-link/api/events?from=bad&to=bad').expect(400);
});
test('backend outage returns 503 instead of an empty successful calendar', async () => {
  const app = make({ read: async () => { throw new Error('secret backend address'); } });
  const response = await request(app).get('/c/test-link/feed.ics').expect(503);
  assert.doesNotMatch(response.text, /secret backend/);
  await request(app).get('/c/test-link/api/events').expect(503); await request(app).get('/readyz').expect(503);
});
