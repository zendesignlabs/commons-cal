import React, { useEffect, useRef, useState } from 'react';
import { CalendarDays, ArrowUpRight, Plus, ArrowLeft, Copy, Check, CircleCheck } from 'lucide-react';
import { Button } from './ui.jsx';

export function OrganizerWorkspace({ path }) {
  const [calendars, setCalendars] = useState(null), [error, setError] = useState(''), [creationEnabled, setCreationEnabled] = useState(false), [creating, setCreating] = useState(false);
  const createButton = useRef();
  const load = () => { setError(''); fetch(`${path}/api/calendars`).then(async r => { if (!r.ok) throw new Error('This organizer link is unavailable. Ask the person hosting Commons for your current link.'); const result = await r.json(); setCalendars(result.calendars); setCreationEnabled(result.creationEnabled); }).catch(e => setError(e.message)); };
  useEffect(load, [path]);
  const close = () => { setCreating(false); requestAnimationFrame(() => createButton.current?.focus()); };
  const created = () => { load(); window.dispatchEvent(new Event('commons-calendars-changed')); };
  return <section className="content-page workspace"><p className="eyebrow">ORGANIZER WORKSPACE</p><div className="intro-row"><div className="content-intro"><h1>Your calendars.</h1><p className="muted">Make plans, add events, and share a calendar with your community.</p></div>{creationEnabled && <Button ref={createButton} primary icon={Plus} onClick={() => setCreating(true)} aria-expanded={creating} aria-controls="add-workspace-calendar">Create calendar</Button>}</div>{error && <div className="notice warning" role="alert">{error}<Button onClick={load}>Try again</Button></div>}{!calendars && !error && <p role="status">Loading calendars…</p>}{creating && <section id="add-workspace-calendar" className="workspace-create-panel"><CreateWorkspace workspacePath={path} onCreated={created} onCancel={close} /></section>}<div className="workspace-calendars">{calendars?.map(c => <article key={c.id} className="workspace-calendar"><CalendarDays size={28} className="accent" /><div><h2><a href={`${c.path}/`}>{c.name}</a></h2><p className="muted">{c.description}</p></div><div className="actions"><a className="button primary" href={`${c.path}/new`}><Plus size={18} />Add event</a><a className="button" href={`${c.path}/`}>Manage calendar</a><a className="text-link" href={c.viewPath}>View calendar <ArrowUpRight size={16} /></a></div></article>)}</div><p className="muted small">Keep this organizer link private. It manages every calendar in this workspace. Share each calendar’s public view with your community.</p>{calendars && !creationEnabled && <p className="muted small">New calendar creation is disabled on this instance. Contact the person hosting Commons to add a calendar.</p>}</section>;
}

const draftKey = 'commons-workspace-draft';
const newKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
const initialDraft = (key = draftKey) => {
  try { const saved = JSON.parse(sessionStorage.getItem(key)); if (/^[a-f0-9]{64}$/.test(saved?.requestKey)) return saved; } catch {}
  return { requestKey: newKey(), name: '', id: '', description: '' };
};
const slugify = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');

export function OrganizerLanding() {
  const [site, setSite] = useState(null), [siteError, setSiteError] = useState('');
  const [expanded, setExpanded] = useState(false), [openedNew, setOpenedNew] = useState(false);
  const createButton = useRef();
  const load = () => { setSiteError(''); fetch('/api/site').then(async r => { if (!r.ok) throw new Error(); setSite(await r.json()); }).catch(() => setSiteError('We couldn’t load calendar creation. Please try again.')); };
  useEffect(load, []);
  useEffect(() => { if (expanded) document.getElementById('organizer-new')?.focus(); }, [expanded]);
  const toggle = () => { setOpenedNew(true); setExpanded(!expanded); if (expanded) createButton.current?.focus(); };
  return <section className="landing onboarding"><CalendarDays size={42} /><p className="eyebrow">A LITTLE INFRASTRUCTURE FOR BEING TOGETHER</p><h1>Space for your community’s plans.</h1><p>Start a shared calendar for your community. Make plans, add events, and bring people together.</p>
    <Button ref={createButton} primary={!expanded} icon={expanded ? ArrowLeft : Plus} aria-expanded={expanded} aria-controls="organizer-new" onClick={toggle}>{expanded ? 'Back' : 'Create a workspace'}</Button>
    <section id="organizer-new" className="organizer-step" hidden={!expanded} tabIndex={-1} aria-label="Create a workspace">{!site && !siteError && <p role="status">Loading…</p>}{siteError && <div role="alert" className="notice warning">{siteError}<Button onClick={load}>Try again</Button></div>}{site?.creationEnabled ? openedNew && <CreateWorkspace /> : site && <p className="notice">New calendars aren’t available on this instance right now. Contact the person hosting Commons to create one.</p>}</section>
    <p className="muted small">Looking for your group’s events? Open the public calendar link your organizer shared.</p>
  </section>;
}

function CreateWorkspace({ workspacePath = '', onCreated, onCancel }) {
  const storageKey = workspacePath ? `commons-calendar-draft:${workspacePath}` : draftKey;
  const [values, setValues] = useState(() => initialDraft(storageKey)), [pending, setPending] = useState(false), [error, setError] = useState(''), [created, setCreated] = useState(null);
  const [customSlug, setCustomSlug] = useState(() => !!values.id);
  const submitLock = useRef(false), heading = useRef();
  useEffect(() => { try { if (created && workspacePath) sessionStorage.removeItem(storageKey); else sessionStorage.setItem(storageKey, JSON.stringify(values)); } catch {} }, [values, created, storageKey, workspacePath]);
  useEffect(() => { if (workspacePath) heading.current?.focus(); }, [workspacePath]);
  const update = (key, value) => { setError(''); setValues(v => ({ ...v, [key]: value, ...(key === 'name' && !customSlug ? { id: slugify(value) } : {}) })); };
  const create = async e => {
    e.preventDefault(); if (submitLock.current) return; submitLock.current = true; setPending(true); setError('');
    try {
      const r = await fetch(workspacePath ? `${workspacePath}/api/calendars` : '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || 'Could not create your workspace. Please try again.');
      setCreated(result); onCreated?.(result); requestAnimationFrame(() => heading.current?.focus());
    } catch (e) { setError(e.message === 'Failed to fetch' ? 'We couldn’t confirm creation. Your details are still here; retrying is safe.' : e.message); }
    finally { setPending(false); submitLock.current = false; }
  };
  const startOver = () => { setValues({ requestKey: newKey(), name: '', id: '', description: '' }); setCustomSlug(false); setCreated(null); setError(''); };
  if (created) return <section className="stack workspace-created"><CircleCheck size={32} className="accent" /><h2 ref={heading} tabIndex={-1}>Your calendar is ready.</h2><p><strong>{created.name}</strong> {workspacePath ? 'has been added to this workspace. Your existing organizer link manages it, too.' : 'has its own public calendar and private organizer workspace.'}</p>{!workspacePath && <LinkToKeep label="Private organizer link" path={created.workspacePath} explanation="Save this link somewhere safe. It lets you add events and edit settings. Share it only with other organizers." />}<LinkToKeep label="Public calendar link" path={created.viewPath} explanation="Share this link with your community. Everyone can view events and subscribe; it doesn’t allow changes." /><a className="button primary" href={workspacePath ? created.calendarPath : created.workspacePath}>{workspacePath ? 'Open calendar' : 'Open your workspace'} <ArrowUpRight size={18} /></a><p className="muted small">Add your first event or fill in this calendar’s FAQ.</p><div className="actions"><Button type="button" onClick={startOver}>{workspacePath ? 'Create another calendar' : 'Create another workspace'}</Button>{onCancel && <Button type="button" onClick={onCancel}>Done</Button>}</div></section>;
  return <form className="stack create-workspace" onSubmit={create}><h2 ref={heading} tabIndex={-1}>{workspacePath ? 'Create a calendar' : 'Create your calendar workspace'}</h2><fieldset className="stack" disabled={pending}><div className="field"><label htmlFor="new-calendar-name">Calendar name</label><input id="new-calendar-name" value={values.name} onChange={e => update('name', e.target.value)} placeholder="Community gatherings" required maxLength={120} autoComplete="off" /></div><div className="field"><label htmlFor="new-calendar-id">Public calendar URL</label><div className="slug-field"><span aria-hidden="true">/c/</span><input id="new-calendar-id" value={values.id} onChange={e => { setCustomSlug(true); update('id', e.target.value); }} placeholder="community-gatherings" required minLength={3} maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" title="Use lowercase letters, numbers, and single hyphens, with 3–64 characters." autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="calendar-url-preview" /></div><small id="calendar-url-preview" className="muted">{location.origin}/c/{values.id || 'your-calendar'}/</small></div><div className="field"><label htmlFor="new-calendar-description">Description · optional</label><textarea id="new-calendar-description" value={values.description} onChange={e => update('description', e.target.value)} placeholder="What brings your community together?" maxLength={500} rows={3} /></div><p className="muted small">{workspacePath ? 'This calendar and its FAQ will be public. Everyone with your existing organizer link will be able to manage it.' : 'Your calendar and FAQ will be public. You’ll get a separate private link for organizing.'}</p><div className="actions"><Button primary icon={Plus} type="submit">{pending ? 'Creating calendar…' : workspacePath ? 'Create calendar' : 'Create calendar workspace'}</Button>{onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}</div></fieldset>{error && <div className="stack"><p className="notice error-notice" role="alert">{error}</p><Button type="button" onClick={startOver}>Start over</Button></div>}<span className="sr-only" role="status">{pending ? 'Creating your calendar. Please wait.' : ''}</span></form>;
}

function LinkToKeep({ label, path, explanation }) {
  const [copied, setCopied] = useState(false), [message, setMessage] = useState('');
  const ref = useRef(), id = label.startsWith('Private') ? 'new-private-link' : 'new-public-link';
  const value = location.origin + path;
  const copy = async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setMessage('Link copied.'); } catch { ref.current.select(); setMessage('Select and copy the link manually.'); } };
  return <div className="stack created-link"><label htmlFor={id}>{label}</label><div className="copy-row"><input id={id} ref={ref} value={value} readOnly onFocus={e => e.target.select()} /><Button type="button" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button></div><p className="muted small">{explanation}</p><span className="small" role="status">{message}</span></div>;
}
