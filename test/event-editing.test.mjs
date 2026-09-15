import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { createApp } from '../server/app.mjs';
import { MemoryStore, RadicaleStore } from '../server/store.mjs';
import { createIcs, validateEvent } from '../server/calendar.mjs';
import { editableEvent, updateEventIcs } from '../server/event-editing.mjs';
const origin = 'https://commons.example.org', base = '/o/secret-one/c/one/api/events';
const payload = () => ({ requestId: randomUUID(), title: 'Editable gathering', startDate: '2026-10-15', endDate: '2026-10-15', startTime: '18:00', endTime: '19:00', timezone: 'America/New_York', description: 'Original details' });
const setup = () => { const store = new MemoryStore(); return { store, app: createApp({ calendars: [{ id: 'one', name: 'One', organizerToken: 'secret-one', store }, { id: 'two', name: 'Two', organizerToken: 'secret-two', store: new MemoryStore() }], publicOrigin: origin }) }; };

test('organizers edit existing events, preserve identity, refresh public reads and delete with revision checks', async () => {
  const { app } = setup();
  const created = await request(app).post(base).set('Origin', origin).send(payload()).expect(201);
  const path = base + '/' + encodeURIComponent(created.body.uid);
  const before = (await request(app).get(path).expect(200)).body;
  assert.equal(before.scheduleEditable, true);
  await request(app).get('/c/one/feed.ics').expect(200); // prime cache
  const values = { ...before.values, title: 'Updated gathering', meetingUrl: 'https://example.org/join', agendaUrl: 'https://example.org/agenda', startTime: '17:00' };
  const updated = await request(app).put(path).set('Origin', origin).send({ values, revision: before.revision }).expect(200);
  assert.equal(updated.body.uid, created.body.uid);
  const feed = await request(app).get('/c/one/feed.ics').expect(200);
  assert.match(feed.text, /Updated gathering/); assert.match(feed.text, /URL:https:\/\/example.org\/join/); assert.match(feed.text, /SEQUENCE:1/);
  const list = await request(app).get('/c/one/api/events?from=2026-10-01&to=2026-11-01').expect(200);
  assert.equal(list.body.events.length, 1); assert.equal(list.body.events[0].meetingUrl, values.meetingUrl); assert.equal(list.body.events[0].start, '2026-10-15T21:00:00.000Z');
  await request(app).put(path).set('Origin', origin).send({ values, revision: before.revision }).expect(409);
  await request(app).delete(path).set('Origin', origin).send({ revision: before.revision }).expect(409);
  const after = (await request(app).get(path).expect(200)).body;
  await request(app).delete(path).set('Origin', origin).send({ revision: after.revision }).expect(204);
  await request(app).delete(path).set('Origin', origin).send({ revision: after.revision }).expect(204);
  await request(app).get(path).expect(404);
  assert.doesNotMatch((await request(app).get('/c/one/feed.ics')).text, /Updated gathering/);
  assert.equal((await request(app).get('/c/one/api/events?from=2026-10-01&to=2026-11-01')).body.events.length, 0);
});

test('event mutations require organizer scope, same origin, valid links and a revision', async () => {
  const { app } = setup();
  const created = await request(app).post(base).set('Origin', origin).send(payload()).expect(201);
  const suffix = '/' + encodeURIComponent(created.body.uid), path = base + suffix;
  const before = (await request(app).get(path)).body;
  for (const method of ['get','put','delete']) {
    await request(app)[method]('/c/one/api/events' + suffix).set('Origin', origin).send({}).expect(403);
    await request(app)[method]('/o/secret-two/c/one/api/events' + suffix).set('Origin', origin).send({}).expect(404);
  }
  for (const method of ['put','delete']) {
    await request(app)[method](path).send({}).expect(403);
    await request(app)[method](path).set('Origin', 'https://evil.example').send({}).expect(403);
    await request(app)[method](path).set('Origin', origin).send({ values: before.values }).expect(400);
  }
  await request(app).put(path).set('Origin', origin).send({ revision: before.revision, values: { ...before.values, meetingUrl: 'javascript:alert(1)' } }).expect(400);
  assert.equal((await request(app).get(path)).body.revision, before.revision);
});

test('weekly series edits preserve recurrence and UID, and deletion removes every occurrence', async () => {
  const { app, store } = setup();
  const data = payload();
  const created = await request(app).post(base).set('Origin', origin).send({ ...data, repeat: 'weekly', repeatUntil: '2026-12-15' }).expect(201);
  const uid = created.body.uid, path = base + '/' + encodeURIComponent(uid);
  const before = (await request(app).get(path)).body;
  assert.equal(before.recurring, true); assert.equal(before.scheduleEditable, true); assert.equal(before.values.repeatUntil, '2026-12-15');
  const originalRule = new ICAL.Component(ICAL.parse(store.find(uid).ics)).getFirstSubcomponent('vevent').getFirstPropertyValue('rrule').toString();
  await request(app).put(path).set('Origin', origin).send({ revision: before.revision, values: { ...before.values, meetingUrl: 'https://example.org/series' } }).expect(200);
  const root = new ICAL.Component(ICAL.parse(store.find(uid).ics)), event = root.getFirstSubcomponent('vevent');
  assert.equal(event.getFirstPropertyValue('rrule').toString(), originalRule); assert.equal(event.getFirstPropertyValue('uid'), uid);
  const list = (await request(app).get('/c/one/api/events?from=2026-10-01&to=2027-01-01')).body.events;
  assert.ok(list.length > 5); assert.ok(list.every(e => e.meetingUrl === 'https://example.org/series'));
  await request(app).delete(path).set('Origin', origin).send({ revision: (await request(app).get(path)).body.revision }).expect(204);
  assert.equal((await request(app).get('/c/one/api/events?from=2026-10-01&to=2027-01-01')).body.events.length, 0);
});

test('imported all-day recurrence and exceptions survive detail edits, with schedule changes rejected', () => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:imported-event\r\nDTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:20261016\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEXDATE;VALUE=DATE:20261016\r\nSUMMARY:Imported\r\nLOCATION:Community center\r\nORGANIZER:mailto:private@example.org\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:imported-event\r\nRECURRENCE-ID;VALUE=DATE:20261017\r\nDTSTART;VALUE=DATE:20261018\r\nDTEND;VALUE=DATE:20261019\r\nSUMMARY:Moved gathering\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const before = editableEvent(ics, 'imported-event', 'r1'); assert.equal(before.scheduleEditable, false);
  const changed = updateEventIcs(ics, 'imported-event', { ...before.values, meetingUrl: 'https://example.org/join' });
  const events = new ICAL.Component(ICAL.parse(changed)).getAllSubcomponents('vevent');
  assert.equal(events.length, 2); assert.equal(events[0].getFirstPropertyValue('rrule').toString(), 'FREQ=DAILY;COUNT=4');
  assert.equal(events[0].getFirstPropertyValue('exdate').toString(), '2026-10-16'); assert.equal(events[1].getFirstPropertyValue('recurrence-id').toString(), '2026-10-17');
  assert.equal(events[1].getFirstPropertyValue('summary'), 'Moved gathering'); assert.equal(events[0].getFirstPropertyValue('location'), 'Community center');
  assert.equal(events[0].getFirstPropertyValue('organizer'), 'mailto:private@example.org'); assert.ok(events.every(e => e.getFirstPropertyValue('url') === 'https://example.org/join'));
  assert.throws(() => updateEventIcs(ics, 'imported-event', { ...before.values, startDate: '2026-10-20' }), { status: 400 });
});

test('CalDAV mutations send If-Match and report races instead of overwriting changes', async () => {
  const data = payload(), uid = data.requestId + '@commons-calendar', ics = createIcs(validateEvent(data));
  const store = new RadicaleStore({ url: 'http://caldav.example/calendar/', username: 'test', password: 'test' });
  const calls = [];
  store.request = async (path, options = {}) => { calls.push({ path, ...options }); return options.method ? new Response(null, { status: 412 }) : new Response(ics, { headers: { ETag: '"v1"' } }); };
  const before = await store.get(uid);
  await assert.rejects(store.update(uid, { ...before.values, meetingUrl: 'https://example.org/join' }, before.revision), { status: 409 });
  await assert.rejects(store.delete(uid, before.revision), { status: 409 });
  assert.equal(calls.find(c => c.method === 'PUT').headers['If-Match'], '"v1"'); assert.equal(calls.find(c => c.method === 'DELETE').headers['If-Match'], '"v1"');
});
