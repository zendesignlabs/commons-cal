import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  faq: z.array(z.object({ question: z.string().trim().min(1).max(200), answer: z.string().trim().min(1).max(3000) }).strict()).max(30),
}).strict();
export function validateMetadata(data) {
  const result = schema.safeParse(data);
  if (!result.success) { const error = new Error('Check the calendar name, description, and FAQ entries. Each question needs an answer.'); error.fields = {}; throw error; }
  return result.data;
}
export function attachMetadata(calendars, directory) {
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const c of calendars) {
    const path = directory ? join(directory, `${c.id}.json`) : null;
    Object.assign(c, validateMetadata({ name: c.name, description: c.description || '', faq: c.faq || [] }));
    if (path && existsSync(path)) Object.assign(c, validateMetadata(JSON.parse(readFileSync(path, 'utf8'))));
    c.saveMetadata = data => {
      const next = validateMetadata(data);
      if (path) { writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); renameSync(`${path}.tmp`, path); }
      else if (!c.demo) throw new Error('Configure CALENDAR_DATA_DIR to save calendar settings.');
      Object.assign(c, next);
    };
  }
  return calendars;
}
