function instant(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatTimestamp(value, {local = false} = {}) {
  const date = instant(value);
  return date ? date.toLocaleString('en-GB', {
    ...(local ? {} : {timeZone: 'UTC'}),
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }) : 'Unavailable';
}

export function renderTimestamp(value, {pending = false, compact = false} = {}) {
  const date = instant(value);
  if (!date) return `<span class="tx-unavailable">${pending ? 'Pending inclusion' : 'Unavailable'}</span>`;
  const time = `<time datetime="${date.toISOString()}" data-tx-time="${Number(value)}">${formatTimestamp(value)}</time>`;
  if (compact) return `<span class="record-timestamp" title="Inclusion block timestamp">${time} UTC</span>`;
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(value));
  const relative = seconds < 60 ? `${seconds} seconds ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} minutes ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} hours ago` : `${Math.floor(seconds / 86400)} days ago`;
  return `<div class="timestamp-value">${time}<select data-tx-timezone aria-label="Timestamp timezone"><option value="utc">UTC</option><option value="local">Local time</option></select><span class="tx-muted">${relative}</span></div>`;
}
