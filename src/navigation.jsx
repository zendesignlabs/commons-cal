import React, { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, Menu, X, SunMoon, CircleHelp, PanelsTopLeft, Share2, Settings, Rss } from 'lucide-react';
import { Button } from './ui.jsx';

export function NavLink({ href, active, icon: Icon, children, onClick }) {
  return <a href={href} className="workspace-nav-link" aria-current={active ? 'page' : undefined} onClick={onClick}><Icon size={20} aria-hidden="true" /><span>{children}</span></a>;
}
export function WorkspaceShell({ sidebar, children, title = 'Commons workspace', brandHref = '/' }) {
  const [open, setOpen] = useState(false), dialog = useRef(), trigger = useRef();
  useEffect(() => {
    if (!open) return;
    dialog.current.showModal();
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const media = matchMedia('(min-width: 1101px)'); const changed = () => { if (media.matches) setOpen(false); };
    media.addEventListener('change', changed);
    return () => { document.body.style.overflow = previous; media.removeEventListener('change', changed); trigger.current?.focus(); };
  }, [open]);
  const brand = <a className="brand" href={brandHref}><CalendarDays size={26} aria-hidden="true" /><span>commons</span></a>;
  const content = <>{brand}{sidebar}</>;
  return <div className="workspace-shell"><a className="skip-link" href="#main">Skip to content</a><aside className="workspace-sidebar" aria-label="Workspace navigation">{content}</aside><header className="workspace-mobile-header"><Button ref={trigger} icon={Menu} aria-expanded={open} aria-controls="workspace-drawer" onClick={() => setOpen(true)}>Menu</Button><span>{title}</span></header><div className="workspace-body">{children}</div>{open && <dialog ref={dialog} id="workspace-drawer" className="workspace-drawer" aria-label="Workspace navigation" onCancel={e => { e.preventDefault(); setOpen(false); }} onClick={e => { if (e.target === dialog.current || e.target.closest('a,[data-close-nav]')) setOpen(false); }}><div className="drawer-heading">{brand}<Button icon={X} aria-label="Close navigation" onClick={() => setOpen(false)} /></div>{sidebar}</dialog>}</div>;
}
export function OrganizerNav({ workspace, base, view, config, onAppearance, go }) {
  const [calendars, setCalendars] = useState([]), [error, setError] = useState(false), id = useId();
  useEffect(() => { let alive = true; const load = () => fetch(`${workspace}/api/calendars`).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => { if (alive) { setCalendars(d.calendars); setError(false); } }).catch(() => { if (alive) setError(true); }); load(); window.addEventListener('commons-calendars-changed', load); return () => { alive = false; window.removeEventListener('commons-calendars-changed', load); }; }, [workspace]);
  const links = [['calendar','Events',CalendarDays],['share','Share calendar',Share2],['faq','Calendar FAQ',CircleHelp],['settings','Calendar settings',Settings],['subscribe','Subscribe',Rss]];
  return <><div className="sidebar-context"><p className="eyebrow">ORGANIZER WORKSPACE</p>{base ? <div className="field"><label htmlFor={id}>Calendar</label><select id={id} value={base} onChange={e => location.assign(e.target.value + '/')}><option value={base}>{config.name || 'Current calendar'}</option>{calendars.filter(c => c.path !== base).map(c => <option value={c.path} key={c.id}>{c.name}</option>)}</select></div> : <h2>Your calendars</h2>}{error && <p className="small muted">Calendar switching is unavailable. <a href={workspace}>Reload workspace</a></p>}</div><nav className="workspace-nav" aria-label="Calendar navigation">{base ? links.map(([path,label,Icon]) => <NavLink key={path} icon={Icon} href={`${base}/${path === 'calendar' ? '' : path}`} active={view === path || path === 'calendar' && ['event','edit','new'].includes(view)} onClick={e => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); go(path); } }}>{label}</NavLink>) : <NavLink href={workspace} icon={PanelsTopLeft} active>All calendars</NavLink>}</nav><div className="sidebar-bottom">{base && <NavLink href={workspace} icon={PanelsTopLeft}>All calendars</NavLink>}{base && <NavLink href={`${base}/help`} icon={CircleHelp} active={view.startsWith('help')} onClick={e => { e.preventDefault(); go('help'); }}>Help</NavLink>}<button className="workspace-nav-link" data-close-nav onClick={onAppearance}><SunMoon size={20} aria-hidden="true" />Appearance</button><p className="small muted">A little infrastructure<br />for being together.</p></div></>;
}
