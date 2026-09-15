import React, { useEffect, useRef, createContext, useContext } from 'react';
import { DateTime } from 'luxon';
import { ArrowUpRight, X, Link as LinkIcon } from 'lucide-react';

export const Context = createContext();
export const useCalendar = () => useContext(Context);
export const safeRead = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
export const zoneList = [...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC', ...Intl.supportedValuesOf('timeZone')])];
export const Button = ({ children, primary, icon: Icon, className = '', ...props }) => <button className={`button ${primary ? 'primary' : ''} ${className}`} {...props}>{Icon && <Icon size={18} aria-hidden="true" />}{children}</button>;
export const External = ({ href, children, primary, icon: Icon = ArrowUpRight }) => <a className={`button ${primary ? 'primary' : ''}`} href={href} target="_blank" rel="noopener noreferrer"><Icon size={18} aria-hidden="true" />{children}</a>;
export function Modal({ title, onClose, children }) {
  const ref = useRef();
  useEffect(() => { const before = document.activeElement; ref.current.showModal(); return () => { if (before instanceof HTMLElement) before.focus(); }; }, []);
  return <dialog ref={ref} onCancel={onClose} onClick={e => { if (e.target === ref.current) onClose(); }} aria-labelledby="dialog-title"><div className="modal-head"><h2 id="dialog-title">{title}</h2><Button icon={X} onClick={onClose} aria-label="Close" className="icon-button" /></div>{children}</dialog>;
}
export function ZoneSelect({ value, onChange, id = 'timezone', label = 'Timezone', error }) {
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} list={`${id}-zones`} value={value} onChange={e => onChange(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} /><datalist id={`${id}-zones`}>{zoneList.map(z => <option key={z} value={z} />)}</datalist>{error && <span className="field-error" id={`${id}-error`}>{error}</span>}</div>;
}
export const formatTime = (iso, zone) => DateTime.fromISO(iso).setZone(zone).toLocaleString(DateTime.TIME_SIMPLE);
export function EventTime({ event, zone }) {
  if (event.allDay) return <>All day</>;
  const start = DateTime.fromISO(event.start).setZone(zone), end = DateTime.fromISO(event.end).setZone(zone);
  return <>{start.toLocaleString(DateTime.TIME_SIMPLE)}–{end.hasSame(start, 'day') ? '' : `${end.toFormat('MMM d')}, `}{end.toLocaleString(DateTime.TIME_SIMPLE)}</>;
}
export const eventDay = (event, zone) => event.allDay ? DateTime.fromISO(event.startDate, { zone }) : DateTime.fromISO(event.start).setZone(zone);
export function PrivacyNote({ compact = false }) {
  const { go } = useCalendar();
  return <aside className="note"><LinkIcon size={24} aria-hidden="true" /><h2>{compact ? 'Public calendar. Share with care.' : <>Public plans.<br />A little shared care.</>}</h2><p>This calendar is public. Anyone can read its events, meeting links, and agenda links. Keep the details suitable for public sharing.</p><button className="text-link" onClick={() => go('help')}>How privacy works <ArrowUpRight size={16} aria-hidden="true" /></button></aside>;
}
