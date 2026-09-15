import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { createIcs, validateEvent, validateEventDetails } from './calendar.mjs';

export const eventError = (message, status = 409) => Object.assign(new Error(message), { status });
export function eventRoot(ics, uid) {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const zone of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(zone);
  const masters = root.getAllSubcomponents('vevent').filter(c => !c.hasProperty('recurrence-id'));
  if (masters.length !== 1 || masters[0].getFirstPropertyValue('uid') !== uid) throw eventError('This calendar item cannot be edited here.', 400);
  return { root, master: masters[0] };
}
export function editableEvent(ics, uid, revision) {
  const { root, master } = eventRoot(ics, uid), e = new ICAL.Event(master);
  const rule = master.getFirstPropertyValue('rrule');
  const timezone = e.startDate.zone?.tzid === 'Z' ? 'UTC' : e.startDate.zone?.tzid || 'UTC';
  const recurring = e.isRecurring();
  const plainRule = !rule || ['WEEKLY', 'MONTHLY'].includes(rule.freq) && [1,2].includes(rule.interval || 1) && !(rule.freq === 'MONTHLY' && rule.interval === 2) && rule.until && !rule.count && Object.keys(rule.parts).length === 0;
  const scheduleEditable = !e.startDate.isDate && timezone !== 'floating' && plainRule && !master.hasProperty('rdate') && !master.hasProperty('exdate') && root.getAllSubcomponents('vevent').length === 1;
  const description = e.description || '';
  return { uid, revision, recurring, scheduleEditable: !!scheduleEditable, values: {
    requestId: uid.match(/^([0-9a-f-]{36})@commons-calendar$/i)?.[1] || randomUUID(),
    title: e.summary || '', description: description.replace(/^(Meeting|Agenda): .+$/gm, '').trim(),
    meetingUrl: master.getFirstPropertyValue('url') || description.match(/^Meeting: (.+)$/m)?.[1] || '', agendaUrl: description.match(/^Agenda: (.+)$/m)?.[1] || '',
    startDate: e.startDate.toString().slice(0,10), endDate: e.endDate.toString().slice(0,10),
    startTime: e.startDate.toString().slice(11,16) || '00:00', endTime: e.endDate.toString().slice(11,16) || '00:00', timezone,
    repeat: rule?.freq === 'MONTHLY' ? 'monthly' : rule?.freq === 'WEEKLY' ? rule.interval === 2 ? 'biweekly' : 'weekly' : 'none',
    repeatUntil: rule?.until ? DateTime.fromJSDate(rule.until.toJSDate()).setZone(timezone === 'floating' ? 'UTC' : timezone).toISODate() : '',
  } };
}
const scheduleKeys = ['startDate','endDate','startTime','endTime','timezone','repeat','repeatUntil'];
export function updateEventIcs(ics, uid, values) {
  const before = editableEvent(ics, uid, ''), { root, master } = eventRoot(ics, uid);
  const scheduleChanged = scheduleKeys.some(k => values[k] !== before.values[k]);
  if (scheduleChanged && !before.scheduleEditable) throw eventError('This event has a calendar-client schedule or exceptions. You can edit its title, description and links here; change its dates or recurrence in your calendar client.', 400);
  let generated;
  if (scheduleChanged) generated = new ICAL.Component(ICAL.parse(createIcs(validateEvent(values))));
  else {
    const details = validateEventDetails(values);
    const c = new ICAL.Component('vevent');
    c.updatePropertyWithValue('summary', details.title);
    const description = [details.description, details.meetingUrl && `Meeting: ${details.meetingUrl}`, details.agendaUrl && `Agenda: ${details.agendaUrl}`].filter(Boolean).join('\n\n');
    if (description) c.updatePropertyWithValue('description', description);
    if (details.meetingUrl) c.updatePropertyWithValue('url', details.meetingUrl);
    generated = new ICAL.Component('vcalendar'); generated.addSubcomponent(c);
  }
  const source = generated.getFirstSubcomponent('vevent');
  const changed = [];
  if (values.title !== before.values.title) changed.push('summary');
  if (['description','meetingUrl','agendaUrl'].some(k => values[k] !== before.values[k])) changed.push('description');
  if (values.meetingUrl !== before.values.meetingUrl) changed.push('url');
  for (const item of root.getAllSubcomponents('vevent')) {
    for (const name of changed) { item.removeAllProperties(name); const prop = source.getFirstProperty(name); if (prop) item.addProperty(new ICAL.Property(structuredClone(prop.toJSON()))); }
    if (item === master && scheduleChanged) {
      for (const name of ['dtstart','dtend','duration','rrule']) { item.removeAllProperties(name); const prop = source.getFirstProperty(name); if (prop) item.addProperty(new ICAL.Property(structuredClone(prop.toJSON()))); }
    }
    item.updatePropertyWithValue('sequence', Number(item.getFirstPropertyValue('sequence') || 0) + 1);
    for (const name of ['dtstamp','last-modified']) item.updatePropertyWithValue(name, ICAL.Time.fromJSDate(new Date(), true));
  }
  if (scheduleChanged) { root.removeAllSubcomponents('vtimezone'); for (const z of generated.getAllSubcomponents('vtimezone')) root.addSubcomponent(z); }
  return root.toString() + '\r\n';
}
export function checkRevision(revision) {
  if (typeof revision !== 'string' || !revision || revision.length > 300 || /[\r\n]/.test(revision)) throw eventError('Reload the event before making changes.', 400);
}
