import { createIcs, fingerprint, sanitizeIcs, validateEvent } from './calendar.mjs';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { editableEvent, updateEventIcs, checkRevision, eventError } from './event-editing.mjs';

export class RadicaleStore {
  constructor({ url, username, password }) {
    this.url = new URL(url.endsWith('/') ? url : url + '/');
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  async request(path = '', options = {}, allowed = [412]) {
    const response = await fetch(new URL(path, this.url), { ...options, redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Authorization: this.authorization, ...options.headers } });
    if (!response.ok && !allowed.includes(response.status)) throw new Error(`Calendar service returned ${response.status}`);
    return response;
  }
  async provision() {
    const response = await fetch(this.url, { method: 'MKCALENDAR', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Authorization: this.authorization, 'Content-Type': 'application/xml; charset=utf-8' }, body: '<?xml version="1.0" encoding="utf-8"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Commons Calendar</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>' });
    // A reserved, randomly named collection can already exist after a lost response.
    // The caller always verifies it with read() before completing registration.
    if (![201, 405].includes(response.status)) throw new Error(`Calendar provisioning returned ${response.status}`);
  }
  async read() {
    const response = await this.request();
    if (Number(response.headers.get('content-length')) > 2_000_000) throw new Error('Calendar too large');
    let result = '', size = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) { size += chunk.length; if (size > 2_000_000) throw new Error('Calendar too large'); result += decoder.decode(chunk, { stream: true }); }
    return sanitizeIcs(result + decoder.decode());
  }
  async find(uid) {
    const common = uid.match(/^([0-9a-f-]{36})@commons-calendar$/i);
    let path;
    if (common) path = `${common[1]}.ics`;
    else {
      const escaped = uid.replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' })[c]);
      const response = await this.request('', { method: 'REPORT', headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:prop-filter name="UID"><C:text-match collation="i;octet">${escaped}</C:text-match></C:prop-filter></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>` });
      const xml = await response.text(); if (xml.length > 2_000_000 || /<!DOCTYPE/i.test(xml)) throw new Error('Invalid calendar lookup');
      const parsed = new XMLParser({ removeNSPrefix: true }).parse(xml);
      const matches = parsed.multistatus?.response;
      const rows = matches ? Array.isArray(matches) ? matches : [matches] : [];
      if (rows.length !== 1) throw eventError('This event is no longer available.', 404);
      const target = new URL(rows[0].href, this.url);
      const suffix = target.pathname.slice(this.url.pathname.length);
      if (target.origin !== this.url.origin || !target.pathname.startsWith(this.url.pathname) || !suffix || decodeURIComponent(suffix).includes('/') || ['.', '..'].includes(decodeURIComponent(suffix)) || target.search || target.hash) throw new Error('Invalid calendar resource');
      path = suffix;
    }
    const response = await this.request(path, {}, [404]);
    if (response.status === 404) throw eventError('This event is no longer available.', 404);
    const ics = await response.text(); if (ics.length > 2_000_000) throw new Error('Event too large');
    const revision = response.headers.get('etag'); if (!revision) throw new Error('Calendar does not support safe updates');
    editableEvent(ics, uid, revision);
    return { path, ics, revision };
  }
  async get(uid) { const item = await this.find(uid); return editableEvent(item.ics, uid, item.revision); }
  async update(uid, values, revision) {
    checkRevision(revision);
    const item = await this.find(uid);
    if (revision !== item.revision) throw eventError('This event changed since you opened it. Reload the event before saving your changes.');
    const ics = updateEventIcs(item.ics, uid, values);
    const r = await this.request(item.path, { method: 'PUT', headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-Match': revision }, body: ics });
    if (r.status === 412) throw eventError('Another organizer changed this event. Reload it before saving.');
    return { uid };
  }
  async delete(uid, revision) {
    checkRevision(revision);
    let item; try { item = await this.find(uid); } catch (e) { if (e.status === 404) return; throw e; }
    if (revision !== item.revision) throw eventError('This event changed since you opened it. Reload it before deleting.');
    const r = await this.request(item.path, { method: 'DELETE', headers: { 'If-Match': revision } }, [404,412]);
    if (r.status === 412) throw eventError('Another organizer changed this event. Reload it before deleting.');
  }
  async create(data) {
    const ics = createIcs(data), path = `${data.requestId}.ics`;
    const response = await this.request(path, { method: 'PUT', headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' }, body: ics });
    if (response.status === 412) {
      const previous = await (await this.request(path)).text();
      if (fingerprint(previous) !== fingerprint(ics)) { const error = new Error('This save ID belongs to another event. Reload the form to create a new event.'); error.status = 409; throw error; }
    }
    return { uid: `${data.requestId}@commons-calendar` };
  }
}

export class MemoryStore {
  constructor(seed = false) {
    this.items = new Map();
    if (seed) {
      const date = DateTime.now().setZone('America/New_York').plus({ days: 2 });
      for (const [i, title] of ['Community gathering', 'Community co-working', 'Autumn check-in'].entries()) {
        const day = date.plus({ days: i * 5 }).toISODate();
        const data = validateEvent({ requestId: randomUUID(), title, startDate: day, endDate: day, startTime: '18:00', endTime: '19:00', timezone: 'America/New_York', description: 'A space to check in, share what’s on our minds, and make plans together.', repeat: i === 0 ? 'biweekly' : 'none', repeatUntil: date.plus({ months: 3 }).toISODate() });
        this.items.set(data.requestId, createIcs(data));
      }
    }
  }
  async read() {
    const root = new ICAL.Component('vcalendar'); root.updatePropertyWithValue('version', '2.0');
    const zones = new Set();
    for (const value of this.items.values()) {
      const c = new ICAL.Component(ICAL.parse(value));
      for (const z of c.getAllSubcomponents('vtimezone')) { const id = z.getFirstPropertyValue('tzid'); if (!zones.has(id)) { root.addSubcomponent(z); zones.add(id); } }
      for (const e of c.getAllSubcomponents('vevent')) root.addSubcomponent(e);
    }
    return sanitizeIcs(root.toString());
  }
  find(uid) {
    for (const [key, ics] of this.items) {
      const root = new ICAL.Component(ICAL.parse(ics));
      if (root.getAllSubcomponents('vevent').some(e => e.getFirstPropertyValue('uid') === uid)) return { key, ics, revision: '"' + createHash('sha256').update(ics).digest('hex') + '"' };
    }
    throw eventError('This event is no longer available.', 404);
  }
  async get(uid) { const item = this.find(uid); return editableEvent(item.ics, uid, item.revision); }
  async update(uid, values, revision) {
    checkRevision(revision); const item = this.find(uid);
    if (revision !== item.revision) throw eventError('This event changed since you opened it. Reload the event before saving your changes.');
    this.items.set(item.key, updateEventIcs(item.ics, uid, values)); return { uid };
  }
  async delete(uid, revision) {
    checkRevision(revision); let item; try { item = this.find(uid); } catch (e) { if (e.status === 404) return; throw e; }
    if (revision !== item.revision) throw eventError('This event changed since you opened it. Reload it before deleting.');
    this.items.delete(item.key);
  }
  async create(data) {
    const value = createIcs(data), previous = this.items.get(data.requestId);
    if (previous && fingerprint(previous) !== fingerprint(value)) { const e = new Error('This save ID belongs to another event.'); e.status = 409; throw e; }
    this.items.set(data.requestId, value); return { uid: `${data.requestId}@commons-calendar` };
  }
}
