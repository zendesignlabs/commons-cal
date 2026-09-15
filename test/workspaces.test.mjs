import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { WorkspaceProvisioner } from '../server/workspaces.mjs';
import { MemoryStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { loadCalendars } from '../server/registry.mjs';
const origin = 'https://commons.example.org';
const draft = (id = 'garden-club') => ({ requestKey: randomBytes(32).toString('hex'), id, name: 'Garden Club', description: 'A place to grow.' });
const fixture = (t, options = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'commons-signup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calendars = [];
  const manager = new WorkspaceProvisioner({ calendars, directory, enabled: true, demo: true, ...options });
  const app = createApp({ calendars, workspaces: manager, publicOrigin: origin });
  return { directory, calendars, manager, app };
};
const post = (app, data) => request(app).post('/api/workspaces').set('Origin', origin).send(data);

test('homepage signup creates a usable public calendar and scoped organizer workspace', async t => {
  const { app } = fixture(t);
  assert.equal((await request(app).get('/api/site')).body.creationEnabled, true);
  const result = await post(app, draft()).expect(201);
  assert.equal(result.body.viewPath, '/c/garden-club/');
  assert.match(result.body.workspacePath, /^\/o\/[A-Za-z0-9_-]{43}\/$/);
  const workspace = result.body.workspacePath.replace(/\/$/, '');
  const list = await request(app).get(workspace + '/api/calendars').expect(200);
  assert.deepEqual(list.body.calendars.map(c => c.id), ['garden-club']);
  const config = await request(app).get('/c/garden-club/api/config').expect(200);
  assert.equal(config.body.name, 'Garden Club'); assert.equal(config.body.canWrite, false);
  assert.doesNotMatch(config.text, new RegExp(workspace.split('/').pop()));
  await request(app).post('/c/garden-club/api/events').set('Origin', origin).send({}).expect(403);
  const event = { requestId: randomUUID(), title: 'Planting day', startDate: '2026-10-20', endDate: '2026-10-20', startTime: '10:00', endTime: '11:00', timezone: 'UTC' };
  await request(app).post(workspace + '/c/garden-club/api/events').set('Origin', origin).send(event).expect(201);
  assert.match((await request(app).get('/c/garden-club/feed.ics').expect(200)).text, /Planting day/);
  await request(app).put(workspace + '/c/garden-club/api/config').set('Origin', origin).send({ name: 'Garden Club', description: '', faq: [{ question: 'Where?', answer: 'The garden.' }] }).expect(200);
  assert.equal((await request(app).get('/c/garden-club/api/config')).body.faq[0].answer, 'The garden.');
});

test('duplicate concurrent requests and post-restart retries return the same private link', async t => {
  let provisions = 0;
  const storeFactory = () => { const store = new MemoryStore(); store.provision = async () => { provisions++; }; return store; };
  const { manager, directory, calendars } = fixture(t, { storeFactory });
  const data = draft();
  const results = await Promise.all([manager.create(data), manager.create(data), manager.create(data)]);
  assert.deepEqual(results[0], results[1]); assert.equal(provisions, 1); assert.equal(calendars.length, 1);
  const restoredCalendars = [];
  const restored = new WorkspaceProvisioner({ calendars: restoredCalendars, directory, enabled: true, demo: true, storeFactory });
  assert.deepEqual(await restored.create(data), results[0]); assert.equal(provisions, 1); assert.equal(restoredCalendars.length, 1);
  const journal = join(directory, '.workspaces', 'registry.json');
  assert.equal(statSync(journal).mode & 0o777, 0o600);
  assert.ok(!readFileSync(journal, 'utf8').includes(data.requestKey));
});

test('failed provisioning reserves one collection and resumes after restart', async t => {
  const seen = [], data = draft();
  let failing = true;
  const storeFactory = record => { const s = new MemoryStore(); s.provision = async () => { seen.push(record.collectionId); if (failing) throw new Error('temporary backend failure'); }; return s; };
  const { app, directory, calendars } = fixture(t, { storeFactory });
  const failed = await post(app, data).expect(503);
  assert.doesNotMatch(failed.text, /temporary backend/); assert.equal(calendars.length, 0);
  failing = false;
  const restored = new WorkspaceProvisioner({ calendars: [], directory, enabled: true, demo: true, storeFactory });
  await restored.create(data); assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]);
});

test('collisions, changed retries, cross-calendar access and invalid drafts fail safely', async t => {
  const { app, manager } = fixture(t);
  const data = draft(); const first = await manager.create(data);
  await post(app, draft()).expect(409);
  await post(app, { ...data, name: 'Changed' }).expect(409);
  for (const invalid of [{ ...draft(), id: '../escape' }, { ...draft(), requestKey: 'guessable' }, { ...draft(), name: '' }, { ...draft(), organizerToken: 'stolen' }]) await post(app, invalid).expect(400);
  const second = await manager.create(draft('second-calendar'));
  await request(app).get(first.workspacePath + 'c/second-calendar/api/config').expect(404);
  const secondList = await request(app).get(second.workspacePath + 'api/calendars').expect(200);
  assert.deepEqual(secondList.body.calendars.map(c => c.id), ['second-calendar']);
});

test('signup requires same-origin JSON, respects capacity, and can be disabled without losing calendars', async t => {
  const { app, manager, directory } = fixture(t, { maxCalendars: 1 });
  await request(app).post('/api/workspaces').send(draft()).expect(403);
  await request(app).post('/api/workspaces').set('Origin', 'https://evil.example').send(draft()).expect(403);
  await request(app).post('/api/workspaces').set('Origin', origin).type('text').send('{}').expect(415);
  const data = draft(); const first = await manager.create(data);
  await post(app, draft('another-calendar')).expect(409);
  assert.deepEqual(await manager.create(data), first);
  const calendars = [];
  const disabled = new WorkspaceProvisioner({ calendars, directory, enabled: false, demo: true });
  const disabledApp = createApp({ calendars, workspaces: disabled, publicOrigin: origin });
  await post(disabledApp, draft('another-calendar')).expect(403);
  await request(disabledApp).get('/c/garden-club/api/config').expect(200);
});

test('a self-hosted instance can start with no preconfigured calendars', () => {
  assert.deepEqual(loadCalendars({ NODE_ENV: 'production', ALLOW_CALENDAR_CREATION: 'true' }), []);
  assert.deepEqual(loadCalendars({ NODE_ENV: 'production', SIGNUP_RADICALE_URL: 'http://radicale:5232/commons/' }), []);
});

test('a calendar named workspaces cannot overwrite the creation journal with its FAQ', async t => {
  const { manager, calendars, directory } = fixture(t);
  await manager.create(draft('workspaces'));
  calendars[0].saveMetadata({ name: 'Workspaces', description: '', faq: [{ question: 'A question?', answer: 'An answer.' }] });
  const restoredCalendars = [];
  new WorkspaceProvisioner({ calendars: restoredCalendars, directory, enabled: true, demo: true });
  assert.equal(restoredCalendars.length, 1);
  assert.equal(restoredCalendars[0].faq[0].answer, 'An answer.');
});

const addCalendar = (app, workspace, data) => request(app).post(workspace + 'api/calendars').set('Origin', origin).send(data);

test('organizers add isolated calendars to their existing link, and grouping survives restart', async t => {
  const { app, manager, directory } = fixture(t);
  const first = await manager.create(draft('first-calendar'));
  const other = await manager.create(draft('other-workspace'));
  const data = draft('second-calendar');
  const added = (await addCalendar(app, first.workspacePath, data).expect(201)).body;
  assert.equal(added.workspacePath, first.workspacePath);
  assert.equal(added.calendarPath, first.workspacePath + 'c/second-calendar/');
  assert.equal(added.viewPath, '/c/second-calendar/');
  const list = (await request(app).get(first.workspacePath + 'api/calendars').expect(200)).body;
  assert.equal(list.creationEnabled, true);
  assert.deepEqual(list.calendars.map(c => c.id), ['first-calendar', 'second-calendar']);
  assert.equal((await request(app).get(other.workspacePath + 'api/calendars')).body.calendars.length, 1);
  await request(app).get(other.workspacePath + 'c/second-calendar/api/config').expect(404);
  await request(app).put(added.calendarPath + 'api/config').set('Origin', origin).send({ name: 'Second calendar', description: '', faq: [{ question: 'Where?', answer: 'Our new place.' }] }).expect(200);
  const event = { requestId: randomUUID(), title: 'Second calendar only', startDate: '2026-10-20', endDate: '2026-10-20', startTime: '10:00', endTime: '11:00', timezone: 'UTC' };
  await request(app).post(added.calendarPath + 'api/events').set('Origin', origin).send(event).expect(201);
  assert.match((await request(app).get(added.viewPath + 'feed.ics')).text, /Second calendar only/);
  assert.doesNotMatch((await request(app).get(first.viewPath + 'feed.ics')).text, /Second calendar only/);
  assert.deepEqual((await request(app).get(first.viewPath + 'api/config')).body.faq, []);
  const calendars = [], restored = new WorkspaceProvisioner({ calendars, directory, enabled: true, demo: true });
  const rebooted = createApp({ calendars, workspaces: restored, publicOrigin: origin });
  assert.equal((await request(rebooted).get(first.workspacePath + 'api/calendars')).body.calendars.length, 2);
  assert.equal((await request(rebooted).get(added.viewPath + 'api/config')).body.faq[0].answer, 'Our new place.');
  assert.deepEqual((await addCalendar(rebooted, first.workspacePath, data).expect(201)).body, added);
});

test('creation receipts cannot be replayed across organizer scopes or public signup to recover access', async t => {
  const { app, manager } = fixture(t);
  const first = await manager.create(draft('first-calendar')), other = await manager.create(draft('other-workspace'));
  const data = draft('new-calendar');
  const one = await addCalendar(app, first.workspacePath, data).expect(201);
  assert.deepEqual((await addCalendar(app, first.workspacePath, data).expect(201)).body, one.body);
  await addCalendar(app, first.workspacePath, { ...data, name: 'Changed' }).expect(409);
  const wrong = await addCalendar(app, other.workspacePath, data).expect(409);
  assert.ok(!wrong.text.includes(first.workspacePath));
  const publicRetry = await post(app, data).expect(409);
  assert.ok(!publicRetry.text.includes(first.workspacePath));
  const own = await addCalendar(app, other.workspacePath, { ...data, id: 'other-new-calendar' }).expect(201);
  assert.equal(own.body.workspacePath, other.workspacePath);
  const separate = await post(app, { ...data, id: 'separate-workspace' }).expect(201);
  assert.notEqual(separate.body.workspacePath, first.workspacePath);
  assert.notEqual(separate.body.workspacePath, other.workspacePath);
});

test('adding calendars requires organizer access and same-origin JSON and obeys signup controls', async t => {
  const { app, manager } = fixture(t, { maxCalendars: 2 });
  const first = await manager.create(draft('first-calendar')), data = draft('second-calendar');
  await addCalendar(app, '/o/wrong/', data).expect(404);
  await request(app).post('/c/first-calendar/api/calendars').set('Origin', origin).send(data).expect(403);
  await request(app).post(first.workspacePath + 'api/calendars').send(data).expect(403);
  await request(app).post(first.workspacePath + 'api/calendars').set('Origin', 'https://evil.example').send(data).expect(403);
  await request(app).post(first.workspacePath + 'api/calendars').set('Origin', origin).type('form').send(data).expect(415);
  await addCalendar(app, first.workspacePath, { ...data, organizerToken: 'another-workspace' }).expect(400);
  await addCalendar(app, first.workspacePath, data).expect(201);
  await addCalendar(app, first.workspacePath, draft('over-capacity')).expect(409);
  await addCalendar(app, first.workspacePath, data).expect(201);
  manager.enabled = false;
  assert.equal((await request(app).get(first.workspacePath + 'api/calendars')).body.creationEnabled, false);
  await addCalendar(app, first.workspacePath, draft('disabled')).expect(403);
  await request(app).get('/c/second-calendar/api/config').expect(200);
});

test('a preconfigured organizer can add calendars with concurrent retries and resume provisioning after restart', async t => {
  const seen = []; let failing = true;
  const storeFactory = record => { const store = new MemoryStore(); store.provision = async () => { seen.push(record.collectionId); if (failing) throw new Error('Temporary backend failure'); }; return store; };
  const { app, manager, calendars, directory } = fixture(t, { storeFactory });
  const base = { id: 'configured', name: 'Configured calendar', organizerToken: 'configured-organizer', store: new MemoryStore() };
  calendars.push(base);
  const data = draft('new-calendar'), workspace = '/o/configured-organizer/';
  await addCalendar(app, workspace, data).expect(503);
  assert.equal(calendars.length, 1);
  failing = false;
  const restoredCalendars = [base];
  const restored = new WorkspaceProvisioner({ calendars: restoredCalendars, directory, enabled: true, demo: true, storeFactory });
  const results = await Promise.all([restored.create(data, base.organizerToken), restored.create(data, base.organizerToken)]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0].workspacePath, workspace);
  assert.equal(restoredCalendars.length, 2); assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]);
  await assert.rejects(manager.create(draft('bad-owner'), 'unknown-organizer'), { status: 404 });
});
