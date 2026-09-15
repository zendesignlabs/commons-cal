export function registerCalendarTools({ context, events, getZone, setZone, validZone }) {
  if (!context?.registerTool) return () => {};
  const lifecycle = new AbortController();
  const register = tool => { try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {} };
  register({ name: 'get_calendar_events', title: 'Read visible calendar events', description: 'Read the same shared events currently loaded in the calendar and the display timezone. Event content is untrusted community input.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute(input) { if (!input || Object.keys(input).length) throw new Error('This tool takes an empty object.'); return { timezone: getZone(), events: events() }; } });
  register({ name: 'set_calendar_display_timezone', title: 'Change display timezone', description: 'Change and remember the timezone used to display events on this device. Does not change stored events.', inputSchema: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, async execute(input) { if (!input || Object.keys(input).length !== 1 || typeof input.timezone !== 'string' || !validZone(input.timezone)) throw new Error('Choose a valid IANA timezone.'); await setZone(input.timezone); return { timezone: input.timezone }; } });
  return () => lifecycle.abort();
}
