import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import ICAL from 'ical.js';
import { validateEvent, createIcs, sanitizeIcs, expandEvents, fingerprint } from '../server/calendar.mjs';

export const input = (overrides = {}) => ({ requestId: randomUUID(), title: 'Community gathering', startDate: '2026-10-29', endDate: '2026-10-29', startTime: '18:00', endTime: '19:00', timezone: 'America/New_York', meetingUrl: 'https://meet.example.org/room', agendaUrl: 'https://example.org/agenda', description: 'Check in together.', repeat: 'biweekly', repeatUntil: '2026-12-10', ...overrides });
const expand = (ics, from = '2026-01-01', to = '2027-01-01') => expandEvents(ics, Date.parse(from), Date.parse(to));

test('biweekly events retain wall time across daylight-saving change', () => {
  const ics = createIcs(validateEvent(input()));
  const events = expand(ics);
  assert.equal(events.length, 4);
  assert.equal(events[0].start, '2026-10-29T22:00:00.000Z');
  assert.equal(events[1].start, '2026-11-12T23:00:00.000Z');
  assert.ok(events.every(e => DateTime.fromISO(e.start).setZone('America/New_York').hour === 18));
  assert.equal(events[0].agendaUrl, 'https://example.org/agenda');
  assert.equal(events[0].description, 'Check in together.');
});
test('monthly recurrence skips nonexistent month dates', () => {
  const events = expand(createIcs(validateEvent(input({ startDate: '2026-01-31', endDate: '2026-01-31', repeat: 'monthly', repeatUntil: '2026-05-31' }))));
  assert.deepEqual(events.map(e => e.start.slice(0, 10)), ['2026-01-31', '2026-03-31', '2026-05-31']);
});
// The user:pass URL below is a synthetic negative test, never a real credential.
test('rejects invalid times, DST gaps, ambiguous times, unsafe URLs and attendee inputs', () => {
  for (const data of [input({ endTime: '17:00' }), input({ startDate: '2026-03-08', endDate: '2026-03-08', startTime: '02:30' }), input({ startDate: '2026-11-01', endDate: '2026-11-01', startTime: '01:30' }), input({ meetingUrl: 'javascript:alert(1)' }), input({ agendaUrl: 'https://user:pass@example.org' }), input({ attendees: ['private@example.org'] }), input({ timezone: '../../etc/passwd' }), input({ startTime: '25:00' }), input({ repeatUntil: '2026-01-01' })]) assert.throws(() => validateEvent(data));
});
test('feed removes private properties, custom parameters, alarms and calendar metadata', () => {
  const raw = createIcs(validateEvent(input())).replace('BEGIN:VEVENT', 'X-PRIVATE:backend-secret\r\nBEGIN:VEVENT\r\nATTENDEE;CN=Private Person:mailto:private@example.org\r\nORGANIZER:mailto:organizer@example.org\r\nX-BACKEND:secret').replace('SUMMARY:Community', 'SUMMARY;ALTREP="https://private.example.org";X-EMAIL="secret@example.org":Community').replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:EMAIL\r\nATTENDEE:mailto:alarm@example.org\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT');
  const clean = sanitizeIcs(raw);
  assert.doesNotMatch(clean, /ATTENDEE|ORGANIZER|VALARM|ALTREP|X-EMAIL|X-BACKEND|X-PRIVATE|TZURL|private@example|backend-secret/);
  assert.match(clean, /SUMMARY:Community gathering/); assert.match(clean, /RRULE:/); assert.match(clean, /BEGIN:VTIMEZONE/);
});
test('text is escaped so newline injection does not create attendee metadata', () => {
  const ics = createIcs(validateEvent(input({ title: 'Meeting\r\nATTENDEE:mailto:test@example.org' })));
  const comp = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent');
  assert.equal(comp.getAllProperties('attendee').length, 0);
});
test('canceled and moved recurrence exceptions replace the original occurrence', () => {
  const base = createIcs(validateEvent(input({ requestId: '9f1bd4ab-82a3-4f5a-bcb8-6433e01fe6ea' })));
  const exception = `BEGIN:VEVENT\r\nUID:9f1bd4ab-82a3-4f5a-bcb8-6433e01fe6ea@commons-calendar\r\nRECURRENCE-ID;TZID=America/New_York:20261112T180000\r\nDTSTART;TZID=America/New_York:20261113T180000\r\nDTEND;TZID=America/New_York:20261113T190000\r\nSUMMARY:Moved gathering\r\nSTATUS:CANCELLED\r\nSEQUENCE:1\r\nEND:VEVENT\r\n`;
  const events = expand(base.replace('END:VCALENDAR', exception + 'END:VCALENDAR'));
  assert.equal(events.length, 4); const changed = events.find(e => e.title === 'Moved gathering');
  assert.equal(changed.start, '2026-11-13T23:00:00.000Z'); assert.equal(changed.status, 'CANCELLED'); assert.equal(changed.updated, true);
  const narrow = expand(base.replace('END:VCALENDAR', exception + 'END:VCALENDAR'), '2026-11-13', '2026-11-14'); assert.equal(narrow.length, 1);
});
test('all-day dates are preserved and EXDATE removes an occurrence', () => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:all-day\r\nDTSTART;VALUE=DATE:20260917\r\nDTEND;VALUE=DATE:20260918\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;VALUE=DATE:20260918\r\nSUMMARY:Rest day\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const events = expand(ics); assert.equal(events.length, 2); assert.ok(events[0].allDay); assert.equal(events[0].startDate, '2026-09-17');
});

test('idempotency survives Radicale reordering event properties and timezone components', () => {
  const source = createIcs(validateEvent(input()));
  const root = new ICAL.Component(ICAL.parse(source));
  const reorder = component => { component[1].reverse(); component[2].reverse(); component[2].forEach(reorder); };
  const jcal = structuredClone(root.toJSON()); reorder(jcal);
  const saved = new ICAL.Component(jcal).toString();
  assert.equal(fingerprint(source), fingerprint(saved));
  assert.notEqual(fingerprint(source), fingerprint(saved.replace('Community gathering', 'Changed title')));
});
