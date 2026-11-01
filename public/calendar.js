const dayOf = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export function isUpcoming(event, now = new Date()) {
  const today = dayOf(now);
  // All-day end dates are exclusive; a multi-day event can still cover today.
  if (event.allDay) return !!event.start && (event.end ? today < event.end : event.start >= today);
  const start = new Date(event.start);
  return Number.isFinite(start.getTime()) && start >= now;
}
