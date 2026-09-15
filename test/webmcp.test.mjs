import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCalendarTools } from '../src/webmcp.js';
test('optional WebMCP tools share application state, reject invalid input, and unregister', async () => {
  const tools = new Map(); let zone = 'UTC'; let signal;
  const cleanup = registerCalendarTools({ context: { registerTool(tool, options) { tools.set(tool.name, tool); signal = options.signal; } }, events: () => [{ title: 'Gathering' }], getZone: () => zone, setZone: async z => { zone = z; }, validZone: z => ['UTC', 'America/New_York'].includes(z) });
  assert.equal(tools.size, 2); assert.ok(tools.get('get_calendar_events').annotations.readOnlyHint);
  await tools.get('set_calendar_display_timezone').execute({ timezone: 'America/New_York' });
  assert.equal(tools.get('get_calendar_events').execute({}).timezone, 'America/New_York');
  await assert.rejects(tools.get('set_calendar_display_timezone').execute({ timezone: 'invalid' }));
  assert.equal(zone, 'America/New_York'); cleanup(); assert.ok(signal.aborted);
});
