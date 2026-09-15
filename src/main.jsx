import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { DateTime } from 'luxon';
import { CalendarDays, Calendar, List, Plus, Rss, ArrowUpRight, ArrowLeft, ArrowRight, SunMoon, Sun, Moon, Monitor, Globe, Link as LinkIcon, X, Check, ChevronLeft, ChevronRight, RefreshCw, AlertTriangle, HeartHandshake } from 'lucide-react';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './style.css';
import { OrganizerWorkspace, OrganizerLanding } from './workspace.jsx';
import { WorkspaceShell, OrganizerNav } from './navigation.jsx';
const AdminApp = lazy(() => import('./admin.jsx'));
const Views = lazy(() => import('./views.jsx'));
import { registerCalendarTools } from './webmcp.js';
import { Context, useCalendar, safeRead, Button, Modal, ZoneSelect, formatTime, EventTime, eventDay, PrivacyNote } from './ui.jsx';

export default function App() {
  return /^\/admin(?:\/|$)/.test(location.pathname) ? <Suspense fallback={<p className="content-page" role="status">Loading admin…</p>}><AdminApp /></Suspense> : <CalendarApp />;
}

function CalendarApp() {
  const route = () => {
    const organizer = location.pathname.match(/^(\/o\/[^/]+)(?:\/c\/([^/]+)(?:\/(.*))?)?\/?$/);
    if (organizer) return { base: organizer[2] ? `${organizer[1]}/c/${organizer[2]}` : '', view: organizer[3] || 'calendar', workspace: organizer[1], organizing: true };
    const match = location.pathname.match(/^\/c\/([^/]+)(?:\/(.*))?$/);
    return { base: match ? `/c/${match[1]}` : '', view: match?.[2] || 'calendar', workspace: '', organizing: false };
  };
  const [locationState, setLocationState] = useState(route), { base, view, workspace, organizing } = locationState;
  const readOnly = !!base && !organizing;
  const [zone, setZone] = useState(() => { const z = safeRead('commons-zone', Intl.DateTimeFormat().resolvedOptions().timeZone); return DateTime.now().setZone(z).isValid ? z : 'UTC'; });
  const [theme, setTheme] = useState(() => safeRead('commons-theme', 'system'));
  const [dialog, setDialog] = useState(null), [draftZone, setDraftZone] = useState(zone);
  const [data, setData] = useState({ events: [], stale: false }), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [config, setConfig] = useState({}), [month, setMonth] = useState(DateTime.now().setZone(zone).startOf('month'));
  const [calendarView, setCalendarView] = useState(() => route().organizing ? 'upcoming' : 'month');
  const requestCounter = useRef(0), heading = useRef(), hasLoaded = useRef(false);
  const go = (path = 'calendar', query = '') => { history.pushState({}, '', `${base}/${path === 'calendar' ? '' : path}${query}`); setLocationState(route()); window.scrollTo(0, 0); setTimeout(() => heading.current?.focus(), 0); };
  useEffect(() => { const pop = () => setLocationState(route()); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; };
    apply(); media.addEventListener('change', apply); try { localStorage.setItem('commons-theme', theme); } catch {}
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { try { localStorage.setItem('commons-zone', zone); } catch {} }, [zone]);
  const refresh = async () => {
    if (!base) { setLoading(false); return; }
    const request = ++requestCounter.current; setError(''); setLoading(true);
    const now = DateTime.now().setZone(zone);
    const from = (calendarView === 'month' ? month.setZone(zone).startOf('month').startOf('week') : now.startOf('day')).toUTC();
    const to = calendarView === 'month' ? month.setZone(zone).endOf('month').endOf('week').toUTC() : now.plus({ months: 4 }).endOf('day').toUTC();
    try {
      const response = await fetch(`${base}/api/events?${new URLSearchParams({ from: from.toISO(), to: to.toISO() })}`);
      if (!response.ok) throw new Error('We can’t refresh the calendar right now. Please try again.');
      const result = await response.json(); if (request !== requestCounter.current) return;
      setData(result); hasLoaded.current = true;
    } catch (e) { if (request === requestCounter.current) { setError(e.message); if (hasLoaded.current) setData(d => ({ ...d, stale: true })); } }
    finally { if (request === requestCounter.current) setLoading(false); }
  };
  useEffect(() => { refresh(); }, [base, zone, month.toISODate(), calendarView]);
  useEffect(() => { if (base) fetch(`${base}/api/config`).then(r => r.ok ? r.json() : {}).then(setConfig).catch(() => {}); }, [base]);
  useEffect(() => { const onVisible = () => { if (document.visibilityState === 'visible' && view === 'calendar' && !navigator.connection?.saveData && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) refresh(); }; document.addEventListener('visibilitychange', onVisible); const timer = setInterval(onVisible, 60000); return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); }; }, [base, zone, month.toISODate(), calendarView, view]);
  useEffect(() => { document.title = base ? `${config.name || 'Calendar'}${organizing ? ' · Organize' : ''} · Commons` : 'Commons · Organizer workspace'; }, [base, config.name, organizing]);
  const context = { base, view, go, zone, setZone, config, setConfig, data, refresh, heading, setDialog, setDraftZone };
  const current = useRef(); current.current = { zone, events: data.events };
  useEffect(() => {
    if (!base) return;
    return registerCalendarTools({ context: document.modelContext, events: () => current.current.events, getZone: () => current.current.zone, validZone: z => DateTime.now().setZone(z).isValid, setZone: z => new Promise(resolve => { setZone(z); requestAnimationFrame(() => requestAnimationFrame(resolve)); }) });
  }, [base]);
  const content = <>{!organizing && <><a className="skip-link" href="#main">Skip to content</a><header className={`site-header ${readOnly ? 'viewer-header' : ''}`}>
    <div className="header-identity"><a className="brand" href={base ? `${base}/` : workspace || '/'} onClick={e => { if (base) { e.preventDefault(); go(); } }}><CalendarDays size={readOnly ? 22 : 27} aria-hidden="true" /><span>{readOnly ? config.name || 'Calendar' : 'commons'}</span></a>{readOnly && <span className="view-only-badge">View only</span>}</div>
    <div className="header-actions">{readOnly ? <><a className="text-link open-commons" href="/">Open in Commons <ArrowUpRight size={16} /></a><Button primary icon={Rss} onClick={() => go('subscribe')}>Subscribe</Button></> : base && <nav aria-label="Main navigation"><a href={workspace}>All calendars</a>{[['calendar', 'Events'], ['share', 'Share'], ['settings', 'Settings'], ['help', 'Help']].map(([path, name]) => <a key={path} href={`${base}/${path === 'calendar' ? '' : path}`} aria-current={view === path ? 'page' : undefined} onClick={e => { e.preventDefault(); go(path); }}>{name}</a>)}</nav>}<Button icon={SunMoon} onClick={() => setDialog('theme')} className="theme-button" aria-label="Appearance"><span>Appearance</span></Button></div></header></>}
    {config.demo && <div className="demo-banner">Local preview · Example events. Changes reset when the preview restarts.</div>}
    <main id="main" ref={heading} tabIndex={-1}>{!base ? workspace ? <OrganizerWorkspace path={workspace} /> : <OrganizerLanding /> : view === 'calendar' ? <>{!readOnly && <section className="page-intro"><p className="eyebrow">ORGANIZE / {config.name || 'CALENDAR'}</p><div className="intro-row"><div><h1>{config.name}</h1><p>{config.description}</p></div>{config.canWrite && <Button primary icon={Plus} onClick={() => go('new')}>Create event</Button>}</div></section>}<div className={`calendar-layout ${calendarView === 'month' ? 'wide' : ''} ${readOnly ? 'viewer-calendar' : ''}`}><section aria-label="Events">{readOnly && <h1 className="sr-only">{config.name || 'Calendar'}</h1>}<div className="calendar-controls"><div className="segmented" aria-label="Calendar view">{[['upcoming', List, 'Upcoming'], ['month', Calendar, 'Month']].map(([value, Icon, text]) => <button key={value} aria-pressed={calendarView === value} onClick={() => setCalendarView(value)}><Icon size={17} aria-hidden="true" />{text}</button>)}</div><span className="muted">{calendarView === 'upcoming' ? 'Next four months' : ''}</span>{readOnly && <div className="viewer-links"><button className="text-link" onClick={() => go('faq')}>FAQ</button><button className="text-link" onClick={() => go('help')}>Help</button></div>}</div><div className="timezone"><Globe size={17} aria-hidden="true" /><span>Times in {zone.replaceAll('_', ' ')}</span><button className="text-link" onClick={() => { setDraftZone(zone); setDialog('zone'); }}>Change</button></div>
    {(error || data.stale) && <div className="notice warning" role="status"><AlertTriangle size={20} /><div><strong>{error || 'We can’t refresh right now.'}</strong>{data.updatedAt && <p>Showing events last updated {DateTime.fromISO(data.updatedAt).setZone(zone).toLocaleString(DateTime.DATETIME_SHORT)}. Details may have changed.</p>}<Button icon={RefreshCw} onClick={refresh} disabled={loading}>Try again</Button></div></div>}
    {loading && !hasLoaded.current ? <div className="loading" role="status"><p>Loading shared events…</p><div /><div /><div /></div> : calendarView === 'month' ? <MonthGrid events={data.events} month={month} setMonth={setMonth} /> : data.events.length ? <EventList events={data.events} /> : !error ? <div className="empty"><CalendarDays size={36} /><h2>A little room to gather.</h2><p>There are no upcoming events in the next four months. {config.canWrite ? 'Add something when you’re ready.' : 'Check back for new plans from your organizers.'}</p>{config.canWrite && <Button primary icon={Plus} onClick={() => go('new')}>Create an event</Button>}</div> : null}
    </section>{calendarView === 'upcoming' && !readOnly && <aside className="calendar-sidebar"><PrivacyNote /><section className="subscribe-invite"><h2>Your calendar,<br />your choice.</h2><p>Use this page whenever you like, or subscribe in the calendar app you already use.</p><Button icon={Rss} onClick={() => go('subscribe')}>Subscribe to calendar</Button><small>Apple · Google · Thunderbird · more</small></section></aside>}</div></> : <Suspense fallback={<section className="content-page" role="status">Loading page…</section>}><Views key={`${base}/${view}`} view={view} /></Suspense>}</main>
    <footer><span>{readOnly ? 'Calendar powered by Commons' : 'A little infrastructure for being together.'}</span>{base && <button className="text-link" onClick={() => go('help')}>No account needed. · Help & privacy</button>}</footer>
</>;
  return <Context.Provider value={context}>{organizing ? <WorkspaceShell title={config.name || "Organizer workspace"} brandHref={workspace} sidebar={<OrganizerNav workspace={workspace} base={base} view={view} config={config} go={go} onAppearance={() => setDialog("theme")} />}>{content}</WorkspaceShell> : content}
    {dialog === 'theme' && <Modal title="Appearance" onClose={() => setDialog(null)}><p className="muted">Choose what feels comfortable.</p><div className="choices">{[['system', Monitor, 'Use device setting'], ['light', Sun, 'Light'], ['dark', Moon, 'Dark']].map(([value, Icon, label]) => <button className={theme === value ? 'selected' : ''} key={value} onClick={() => setTheme(value)} aria-pressed={theme === value}><Icon size={20} /><span>{label}</span>{theme === value && <Check size={20} />}</button>)}</div><p className="muted">Your choice is remembered on this device.</p></Modal>}
    {dialog === 'zone' && <Modal title="Your timezone" onClose={() => setDialog(null)}><ZoneSelect value={draftZone} onChange={setDraftZone} /><p className="muted">The event time stays the same; only its display changes. Offsets follow the date of each event.</p><div className="actions"><Button primary disabled={!DateTime.now().setZone(draftZone).isValid} onClick={() => { setZone(draftZone); setMonth(DateTime.now().setZone(draftZone).startOf('month')); setDialog(null); }}>Use timezone</Button><Button onClick={() => setDraftZone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use device timezone</Button></div></Modal>}
  </Context.Provider>;
}

function EventList({ events }) {
  const { zone, go } = useCalendar(); let lastMonth = '';
  return <div className="event-list">{events.map((event, index) => { const d = eventDay(event, zone), label = d.toFormat('LLLL yyyy'), showMonth = label !== lastMonth; lastMonth = label; return <React.Fragment key={event.id}>{showMonth && <h2 className="month-label">{label}</h2>}<button className={`event-row ${event.status === 'CANCELLED' ? 'canceled' : ''}`} onClick={() => go('event', `?id=${encodeURIComponent(event.id)}`)}><span className="date-block"><span>{d.toFormat('ccc')}</span><strong>{d.day}</strong></span><span className="event-summary">{event.status === 'CANCELLED' ? <span className="badge error">Canceled</span> : event.updated ? <span className="badge">Updated</span> : index === 0 ? <span className="badge">Up next</span> : null}<strong className="event-title">{event.title}</strong><span><EventTime event={event} zone={zone} /> {!event.allDay && <small>{DateTime.fromISO(event.start).setZone(zone).offsetNameShort}</small>}</span><span className="event-meta">{event.status === 'CANCELLED' ? 'This event will not take place.' : `${event.meetingUrl ? 'Online' : event.location || 'Community gathering'}${event.recurring ? ' · Repeats' : ''}`}</span></span><ArrowUpRight size={21} className="accent" aria-hidden="true" /></button></React.Fragment>; })}</div>;
}

function MonthGrid({ events, month, setMonth }) {
  const { zone, go, config } = useCalendar();
  const first = month.startOf('month').startOf('week'), last = month.endOf('month').endOf('week'), days = Math.round(last.diff(first, 'days').days);
  const [selected, setSelected] = useState(() => DateTime.now().setZone(zone).hasSame(month, 'month') ? DateTime.now().setZone(zone).toISODate() : month.toISODate());
  useEffect(() => { setSelected(DateTime.now().setZone(zone).hasSame(month, 'month') ? DateTime.now().setZone(zone).toISODate() : month.toISODate()); }, [month.toISODate(), zone]);
  const onDay = day => events.filter(e => {
    const start = eventDay(e, zone), end = e.allDay ? DateTime.fromISO(e.endDate, { zone }).minus({ milliseconds: 1 }) : DateTime.fromISO(e.end).setZone(zone).minus({ milliseconds: 1 });
    return start.startOf('day') <= day && end.endOf('day') >= day;
  });
  const selectedEvents = onDay(DateTime.fromISO(selected, { zone }));
  return <><div className="month-navigation"><Button icon={ChevronLeft} aria-label="Previous month" className="month-step" onClick={() => setMonth(m => m.minus({ months: 1 }))}><span>Previous</span></Button><h2>{month.toFormat('LLLL yyyy')}</h2><Button icon={ChevronRight} aria-label="Next month" className="month-step" onClick={() => setMonth(m => m.plus({ months: 1 }))}><span>Next</span></Button><Button onClick={() => setMonth(DateTime.now().setZone(zone).startOf('month'))}>Today</Button></div><div className="month-scroll"><div className="month-grid">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} className="weekday">{d}</div>)}{Array.from({ length: days }, (_, i) => first.plus({ days: i })).map(day => {
    const dayEvents = onDay(day), today = day.hasSame(DateTime.now().setZone(zone), 'day');
    return <div key={day.toISODate()} className={`day ${day.month !== month.month ? 'outside' : ''} ${today ? 'today' : ''} ${selected === day.toISODate() ? 'selected-day' : ''}`}><span className="day-number desktop-day">{day.day}{today && <small>Today</small>}</span><button className="mobile-day" aria-pressed={selected === day.toISODate()} aria-label={`${day.toFormat('cccc, LLLL d')}${today ? ', today' : ''}, ${dayEvents.length} events`} onClick={() => setSelected(day.toISODate())}><span>{day.day}</span>{dayEvents.length > 0 && <span className="event-count">{dayEvents.length}<span className="sr-only"> events</span></span>}</button>{dayEvents.map(e => <button key={e.id} className={`calendar-chip desktop-day ${e.status === 'CANCELLED' ? 'cancelled' : ''}`} onClick={() => go('event', `?id=${encodeURIComponent(e.id)}`)}>{e.status === 'CANCELLED' ? 'Canceled · ' : !e.allDay ? `${formatTime(e.start, zone)} · ` : ''}{e.title}{e.updated && <small>Updated</small>}</button>)}</div>;
  })}</div></div><section className="mobile-day-events" aria-live="polite" aria-label="Events for selected day"><h2>{DateTime.fromISO(selected, { zone }).toFormat('cccc, LLLL d')}</h2>{selectedEvents.length ? <EventList events={selectedEvents} /> : <p className="muted">No events on this day.</p>}</section><p className="muted small">Canceled events stay visible so everyone can see what changed.</p></>;
}
