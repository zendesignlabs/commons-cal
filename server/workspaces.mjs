import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { attachMetadata } from './metadata.mjs';
import { MemoryStore, RadicaleStore } from './store.mjs';
import { validateCalendars } from './registry.mjs';

const inputSchema = z.object({
  requestKey: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(120),
  id: z.string().min(3).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(500).default(''),
}).strict();
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (message, status) => Object.assign(new Error(message), { status });

// One process owns this journal. Persist the reservation before contacting CalDAV,
// so a lost response or process restart can resume the same collection safely.
export class WorkspaceProvisioner {
  constructor({ calendars, directory, enabled = false, demo = false, backend, maxCalendars = 25, storeFactory }) {
    this.calendars = calendars;
    this.directory = directory;
    this.enabled = enabled;
    this.demo = demo;
    this.maxCalendars = maxCalendars;
    if (!Number.isInteger(maxCalendars) || maxCalendars < 1) throw new Error('MAX_CALENDARS must be a positive integer.');
    if (enabled && !directory) throw new Error('Calendar creation requires CALENDAR_DATA_DIR.');
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (directory) mkdirSync(join(directory, '.workspaces'), { recursive: true, mode: 0o700 });
    this.file = directory ? join(directory, '.workspaces', 'registry.json') : null;
    this.records = this.file && existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(this.records)) throw new Error('Invalid workspace journal.');
    const needsBackend = !demo && (enabled || this.records.length);
    if (needsBackend && (!backend?.url || !backend?.username || !backend?.password)) throw new Error('Calendar creation requires dedicated SIGNUP_RADICALE_URL, SIGNUP_RADICALE_USERNAME and SIGNUP_RADICALE_PASSWORD.');
    if (needsBackend && !/^https?:$/.test(new URL(backend.url).protocol)) throw new Error('Signup CalDAV must use HTTP or HTTPS.');
    this.storeFactory = storeFactory || (record => {
      if (demo) { const store = new MemoryStore(); store.provision = async () => {}; return store; }
      return new RadicaleStore({ ...backend, url: new URL(`${record.collectionId}/`, backend.url.endsWith('/') ? backend.url : backend.url + '/').href });
    });
    for (const record of this.records) {
      if (!['pending', 'ready'].includes(record.state) || !z.string().uuid().safeParse(record.collectionId).success || !/^[a-f0-9]{64}$/.test(record.keyHash) || !/^[a-f0-9]{64}$/.test(record.inputHash)) throw new Error('Invalid workspace journal entry.');
    }
    validateCalendars([...calendars, ...this.records.map(r => ({ ...r, store: undefined }))], !demo, true);
    for (const record of this.records.filter(r => r.state === 'ready')) this.activate(record);
    this.queue = Promise.resolve();
  }
  persist() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.records, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
  activate(record) {
    const calendar = { id: record.id, name: record.name, description: record.description, organizerToken: record.organizerToken, demo: this.demo, store: this.storeFactory(record) };
    attachMetadata([calendar], this.directory);
    this.calendars.push(calendar);
    return calendar;
  }
  create(raw, organizerToken = null) {
    const operation = this.queue.then(() => this.createOne(raw, organizerToken));
    this.queue = operation.catch(() => {});
    return operation;
  }
  async createOne(raw, organizerToken) {
    if (organizerToken !== null && !this.calendars.some(c => c.organizerToken === organizerToken)) throw failure('This organizer workspace is unavailable.', 404);
    if (!this.enabled) throw failure('New calendar creation is disabled on this instance.', 403);
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) { const e = failure('Enter a calendar name and a URL using lowercase letters, numbers, and single hyphens (3–64 characters).', 400); e.fields = {}; throw e; }
    const { requestKey, ...details } = parsed.data;
    // Bind organizer creation receipts to their workspace; public signup receipts remain compatible.
    const keyHash = hash(organizerToken === null ? requestKey : `organizer\0${organizerToken}\0${requestKey}`), inputHash = hash(JSON.stringify(details));
    let record = this.records.find(r => r.keyHash === keyHash);
    if (record && record.inputHash !== inputHash) throw failure('This creation request already has different details. Restore the original details or start over.', 409);
    if (!record) {
      if (this.calendars.some(c => c.id === details.id || c.viewToken === details.id || c.organizerToken === details.id) || this.records.some(c => c.id === details.id || c.organizerToken === details.id) || existsSync(join(this.directory, `${details.id}.json`))) throw failure('That calendar URL is already in use. Choose another one.', 409);
      const total = this.calendars.length + this.records.filter(r => r.state === 'pending').length;
      if (total >= this.maxCalendars) throw failure('This instance has reached its calendar limit. Contact the person hosting Commons.', 409);
      record = { ...details, keyHash, inputHash, organizerToken: organizerToken ?? randomBytes(32).toString('base64url'), collectionId: randomUUID(), state: 'pending' };
      this.records.push(record);
      try { this.persist(); } catch (e) { this.records.pop(); throw e; }
    }
    if (record.state !== 'ready') {
      const store = this.storeFactory(record);
      await store.provision();
      // Confirm the new collection can actually be read before handing out links.
      await store.read();
      record.state = 'ready';
      try { this.persist(); } catch (e) { record.state = 'pending'; throw e; }
      this.activate(record);
    }
    return { name: record.name, workspacePath: `/o/${record.organizerToken}/`, viewPath: `/c/${record.id}/`, calendarPath: `/o/${record.organizerToken}/c/${record.id}/` };
  }
}
