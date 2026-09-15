import ICAL from 'ical.js';
import timezones from '@touch4it/ical-timezones';
import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import { createHash } from 'node:crypto';

export class InputError extends Error {
  constructor(fields) { super('Check the highlighted details.'); this.fields = fields; this.status = 400; }
}

const url = z.string().trim().max(2048).default('').refine(value => {
  if (!value) return true;
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}, 'Enter a full https:// or http:// URL without a username or password.');
const schema = z.object({
  requestId: z.uuid(), title: z.string().trim().min(1, 'Add an event title.').max(160),
  startDate: z.iso.date(), endDate: z.iso.date(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().max(100).refine(v => IANAZone.isValidZone(v) && !!timezones.getVtimezoneComponent(v), 'Choose a supported IANA timezone, such as America/New_York or Etc/UTC.'),
  meetingUrl: url, agendaUrl: url, description: z.string().trim().max(4000).default(''),
  repeat: z.enum(['none', 'weekly', 'biweekly', 'monthly']).default('none'),
  repeatUntil: z.union([z.iso.date(), z.literal('')]).default(''),
}).strict();

export function validateEvent(input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new InputError(Object.fromEntries(result.error.issues.map(i => [i.path[0] || 'form', i.message])));
  const data = result.data, fields = {};
  for (const part of ['start', 'end']) {
    const wall = `${data[`${part}Date`]}T${data[`${part}Time`]}`;
    const dt = DateTime.fromISO(wall, { zone: data.timezone });
    if (!dt.isValid || dt.toFormat("yyyy-MM-dd'T'HH:mm") !== wall) fields[`${part}Time`] = 'This local time does not exist. Choose another time.';
    else if (dt.getPossibleOffsets().length > 1) fields[`${part}Time`] = 'This time occurs twice when clocks change. Choose an unambiguous time.';
    data[part] = dt;
  }
  if (data.end <= data.start) fields.endTime = 'End time must be after the start time.';
  if (data.end.diff(data.start, 'days').days > 14) fields.endDate = 'An event can last up to 14 days.';
  if (data.start.year < 2020 || data.start.year > 2100) fields.startDate = 'Choose a year between 2020 and 2100.';
  if (data.repeat !== 'none' && (!data.repeatUntil || data.repeatUntil < data.startDate)) fields.repeatUntil = 'Choose a last date on or after the first event.';
  if (data.repeat !== 'none' && data.repeatUntil > data.start.plus({ years: 2 }).toISODate()) fields.repeatUntil = 'Repeat for up to two years at a time.';
  if (Object.keys(fields).length) throw new InputError(fields);
  return data;
}

export function validateEventDetails(input) {
  const result = schema.pick({ title: true, description: true, meetingUrl: true, agendaUrl: true }).safeParse({ title: input.title, description: input.description, meetingUrl: input.meetingUrl, agendaUrl: input.agendaUrl });
  if (!result.success) throw new InputError(Object.fromEntries(result.error.issues.map(i => [i.path[0] || 'form', i.message])));
  return result.data;
}

function calendar() {
  const c = new ICAL.Component('vcalendar');
  c.updatePropertyWithValue('version', '2.0');
  c.updatePropertyWithValue('prodid', '-//Commons Calendar//Community calendar//EN');
  c.updatePropertyWithValue('calscale', 'GREGORIAN');
  c.updatePropertyWithValue('x-wr-calname', 'Commons Calendar');
  return c;
}

export function createIcs(data, now = DateTime.utc()) {
  const root = calendar(), event = new ICAL.Component('vevent');
  const zone = new ICAL.Component(ICAL.parse(timezones.getVtimezoneComponent(data.timezone)));
  // Only standardized timezone properties are exported below.
  root.addSubcomponent(zone);
  for (const part of ['start', 'end']) {
    const prop = new ICAL.Property(part === 'start' ? 'dtstart' : 'dtend');
    prop.setParameter('tzid', data.timezone);
    prop.setValue(ICAL.Time.fromString(data[part].toFormat("yyyy-MM-dd'T'HH:mm:ss")));
    event.addProperty(prop);
  }
  event.updatePropertyWithValue('uid', `${data.requestId}@commons-calendar`);
  event.updatePropertyWithValue('summary', data.title);
  event.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(now.toJSDate(), true));
  event.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(now.toJSDate(), true));
  event.updatePropertyWithValue('sequence', 0);
  event.updatePropertyWithValue('status', 'CONFIRMED');
  const description = [data.description, data.meetingUrl && `Meeting: ${data.meetingUrl}`, data.agendaUrl && `Agenda: ${data.agendaUrl}`].filter(Boolean).join('\n\n');
  if (description) event.updatePropertyWithValue('description', description);
  if (data.meetingUrl) event.updatePropertyWithValue('url', data.meetingUrl);
  if (data.repeat !== 'none') {
    const until = DateTime.fromISO(data.repeatUntil, { zone: data.timezone }).endOf('day').toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
    event.updatePropertyWithValue('rrule', ICAL.Recur.fromString(`FREQ=${data.repeat === 'monthly' ? 'MONTHLY' : 'WEEKLY'};INTERVAL=${data.repeat === 'biweekly' ? 2 : 1};UNTIL=${until}`));
  }
  root.addSubcomponent(event);
  return sanitizeIcs(root.toString());
}

const properties = new Set(['uid', 'summary', 'description', 'location', 'dtstart', 'dtend', 'duration', 'dtstamp', 'last-modified', 'sequence', 'status', 'rrule', 'rdate', 'exdate', 'recurrence-id', 'url', 'transp']);
const zoneProperties = new Set(['tzid', 'dtstart', 'tzoffsetfrom', 'tzoffsetto', 'tzname', 'rrule', 'rdate']);

function cleanComponent(source, allowed) {
  const target = new ICAL.Component(source.name);
  for (const prop of source.getAllProperties()) {
    if (!allowed.has(prop.name)) continue;
    const raw = structuredClone(prop.toJSON());
    // Do not leak organizer-like custom parameters, ALTREP, or backend metadata.
    raw[1] = Object.fromEntries(Object.entries(raw[1]).filter(([k]) => ['tzid', 'value', 'range'].includes(k)));
    target.addProperty(new ICAL.Property(raw));
  }
  return target;
}

export function sanitizeIcs(source) {
  const parsed = new ICAL.Component(ICAL.parse(source));
  if (parsed.name !== 'vcalendar') throw new Error('Invalid calendar response');
  const result = calendar();
  for (const zone of parsed.getAllSubcomponents('vtimezone')) {
    const clean = cleanComponent(zone, zoneProperties);
    for (const child of zone.getAllSubcomponents()) if (['standard', 'daylight'].includes(child.name)) clean.addSubcomponent(cleanComponent(child, zoneProperties));
    result.addSubcomponent(clean);
  }
  for (const event of parsed.getAllSubcomponents('vevent')) result.addSubcomponent(cleanComponent(event, properties));
  return result.toString() + '\r\n';
}

export function fingerprint(ics) {
  const c = new ICAL.Component(ICAL.parse(sanitizeIcs(ics)));
  for (const e of c.getAllSubcomponents('vevent')) for (const p of ['dtstamp', 'last-modified']) e.removeAllProperties(p);
  // CalDAV servers may reorder properties and timezone observances on save.
  // Compare normalized jCal rather than the wire serialization.
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])])) : value;
  const order = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const component = ([name, props, children]) => [name, order(props.map(normalize)), order(children.map(component))];
  return createHash('sha256').update(JSON.stringify(component(c.toJSON()))).digest('hex');
}

function safeUrl(value) { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } }

export function expandEvents(ics, from, to) {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const zone of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(zone);
  const components = root.getAllSubcomponents('vevent'), events = [], seen = new Set();
  const add = (item, start, end, recurrenceId, recurring) => {
    const startMs = start.toJSDate().getTime(), endMs = end.toJSDate().getTime();
    if (endMs <= from || startMs >= to) return;
    const id = `${item.uid}::${recurrenceId || start.toString()}`;
    if (seen.has(id)) return; seen.add(id);
    const description = item.description || '';
    const meetingUrl = safeUrl(item.component.getFirstPropertyValue('url') || description.match(/^Meeting: (.+)$/m)?.[1]);
    const agendaUrl = safeUrl(description.match(/^Agenda: (.+)$/m)?.[1]);
    const rule = item.component.getFirstPropertyValue('rrule');
    events.push({ id, uid: item.uid, title: item.summary || 'Community gathering',
      start: start.toJSDate().toISOString(), end: end.toJSDate().toISOString(),
      allDay: start.isDate, startDate: start.toString().slice(0, 10), endDate: end.toString().slice(0, 10),
      timezone: start.zone?.tzid || 'UTC', meetingUrl, agendaUrl, location: item.location || '',
      description: description.replace(/^(Meeting|Agenda): .+$/gm, '').trim(),
      recurring, recurrence: rule ? rule.toString() : '',
      status: item.component.getFirstPropertyValue('status') || 'CONFIRMED',
      updated: item.sequence > 0 || !!item.recurrenceId,
    });
  };
  for (const comp of components) {
    const e = new ICAL.Event(comp);
    if (e.isRecurrenceException()) continue;
    if (!e.isRecurring()) { add(e, e.startDate, e.endDate, '', false); continue; }
    const types = Object.keys(e.getRecurrenceTypes());
    if (types.some(t => ['SECONDLY', 'MINUTELY', 'HOURLY'].includes(t))) throw new Error('Unsupported recurrence frequency');
    const iter = e.iterator();
    let count = 0, next;
    while ((next = iter.next())) {
      if (++count > 25000) throw new Error('Calendar recurrence limit exceeded');
      // Exceptions moved into the visible window are also considered independently below.
      if (next.toJSDate().getTime() >= to) break;
      const details = e.getOccurrenceDetails(next);
      add(details.item, details.startDate, details.endDate, next.toString(), true);
    }
  }
  for (const c of components.filter(c => c.hasProperty('recurrence-id'))) {
    const e = new ICAL.Event(c); add(e, e.startDate, e.endDate, e.recurrenceId.toString(), true);
  }
  return events.sort((a, b) => a.start.localeCompare(b.start));
}
