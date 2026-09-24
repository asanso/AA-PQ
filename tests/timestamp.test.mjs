import test from 'node:test';
import assert from 'node:assert/strict';
import {formatTimestamp, renderTimestamp} from '../frontend/public/timestamp.js';

test('inclusion timestamps show the complete date and time in UTC', () => {
  assert.equal(formatTimestamp(1700000000), '14 Nov 2023, 22:13:20');
  const html = renderTimestamp(1700000000);
  assert.match(html, /datetime="2023-11-14T22:13:20.000Z"/);
  assert.match(html, /14 Nov 2023, 22:13:20/);
  assert.match(html, /Timestamp timezone/);
  assert.match(html, /value="utc">UTC/);
});

test('missing timestamps and pending inclusion remain distinct', () => {
  for (const value of [null, undefined, '', ' ', false, true, NaN, Infinity, -1, 1.5, 999999999999999, '<script>']) {
    assert.equal(formatTimestamp(value), 'Unavailable');
    assert.match(renderTimestamp(value), />Unavailable</);
    assert.doesNotMatch(renderTimestamp(value), /<time/);
  }
  assert.match(renderTimestamp(null, {pending: true}), /Pending inclusion/);
  assert.match(renderTimestamp(0), /1970-01-01T00:00:00.000Z/);
});

test('compact rows retain seconds and an explicit UTC label', () => {
  const html = renderTimestamp('1700000000', {compact: true});
  assert.match(html, /22:13:20<\/time> UTC/);
  assert.doesNotMatch(html, /<select/);
});

test('local time formatting uses the browser or process timezone explicitly', () => {
  const expected = new Date(1700000000000).toLocaleString('en-GB', {year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  assert.equal(formatTimestamp(1700000000, {local: true}), expected);
});
