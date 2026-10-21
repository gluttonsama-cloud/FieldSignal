import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { esc } from '../src/display.ts';
import { defaultRecordFilters, recordFiltersActive, recordFilterError, filterVerifications, recordFilterDescription } from '../src/record-filters.ts';

const parcels = [
  { id: 'parcel-full-A', name: 'North <field>', season: '2025-2026', data_origin: 'user' },
  { id: 'parcel-full-B', name: 'North <field>', season: '2026-2027', data_origin: 'fixture' },
];
function localNoon(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, 12).toISOString();
}
const report = (id, changes = {}) => ({
  id, visit_id: `visit-full-${id}`, parcel_id: 'parcel-full-A',
  observed_at: localNoon('2026-10-17'), created_at: '2026-10-20T12:00:00Z',
  label: 'normal', note: 'Literal field note', photo_ids: [], ...changes,
});
// Already in the caller's save-history order, intentionally not observed order.
const rows = [
  report('backfill', { observed_at: localNoon('2026-10-15'), note: 'Water by gate' }),
  report('latest', { observed_at: localNoon('2026-10-18'), label: 'waterlogging', note: 'WATER by gate' }),
  report('middle', { observed_at: localNoon('2026-10-16'), label: 'waterlogging', note: 'Water by gate' }),
  report('other-parcel', { parcel_id: 'parcel-full-B', label: 'waterlogging', note: 'Water by gate' }),
  report('unknown-time', { observed_at: '', label: 'uncertain' }),
];
const filters = changes => ({ ...defaultRecordFilters(), ...changes });
const ids = (changes, source = rows, catalog = parcels) => filterVerifications(source, catalog, filters(changes)).map(row => row.id);
const frontend = new URL('../', import.meta.url);
function inZone(zone, values, changes) {
  const source = `
    import { defaultRecordFilters, filterVerifications, recordFilterDescription } from './src/record-filters.ts';
    const records = ${JSON.stringify(values)}.map((observed_at, id) => ({ id: String(id), observed_at }));
    const filters = { ...defaultRecordFilters(), ...${JSON.stringify(changes)} };
    console.log(JSON.stringify({ ids: filterVerifications(records, [], filters).map(record => record.id), description: recordFilterDescription(filters, {}, []) }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: frontend, env: { ...process.env, TZ: zone }, encoding: 'utf8',
  }));
}

test('empty filters return a fresh array in the original history order, and default objects are independent', () => {
  const first = defaultRecordFilters(), second = defaultRecordFilters();
  assert.deepEqual(first, { query: '', label: '', from: '', to: '', parcelId: '' });
  assert.notEqual(first, second);
  const result = filterVerifications(rows, parcels, first);
  assert.notEqual(result, rows);
  assert.deepEqual(result, rows);
  assert.ok(result.every((record, index) => record === rows[index]));
  assert.equal(recordFiltersActive(first), false);
  assert.equal(recordFiltersActive(filters({ query: ' \t\n ' })), false);
  for (const field of ['query', 'label', 'from', 'to', 'parcelId']) assert.equal(recordFiltersActive(filters({ [field]: 'x' })), true);
});

test('all constraints combine with AND, using observed days rather than saved time without resorting backfills', () => {
  const changes = { query: '  water BY gate ', label: 'waterlogging', from: '2026-10-16', to: '2026-10-18', parcelId: 'parcel-full-A' };
  assert.deepEqual(ids(changes), ['latest', 'middle']);
  assert.deepEqual(ids({ from: '2026-10-15', to: '2026-10-16', parcelId: 'parcel-full-A' }), ['backfill', 'middle']);
  assert.deepEqual(ids({ from: '2026-10-20', to: '2026-10-20' }), []);
  assert.deepEqual(ids({ label: 'waterlogging', parcelId: 'parcel-full-B' }), ['other-parcel']);
});

test('literal case-insensitive query covers each full identity, parcel name, season and note but not label semantics', () => {
  for (const query of ['BACKFILL', 'visit-full-BACKFILL']) assert.deepEqual(ids({ query }), ['backfill']);
  assert.deepEqual(ids({ query: 'PARCEL-FULL-b' }), ['other-parcel']);
  assert.deepEqual(ids({ query: '2026-2027' }), ['other-parcel']);
  assert.equal(ids({ query: 'north <FIELD>' }).length, rows.length);
  assert.deepEqual(ids({ query: 'waterlogging' }), []);
  assert.deepEqual(ids({ query: '田间积水' }), []);
  assert.deepEqual(ids({ query: 'water gate' }), [], 'query is not split into words');
  assert.deepEqual(ids({ query: 'full-A visit' }), [], 'query does not join unrelated fields');
  assert.deepEqual(ids({ query: '2026-10-20' }), [], 'saved timestamps are not query fields');
});

test('query metacharacters and markup remain literal, without regex, HTML decoding or normalization', () => {
  const source = [
    report('exact', { note: 'Keep [a-z]+ .* <img src="x"> &amp; =1+1 café' }),
    report('plain', { note: 'Plain alphabet img & café' }),
    report('decomposed', { note: 'cafe\u0301' }),
  ];
  for (const query of ['[a-z]+', '.*', '<IMG SRC="X">', '&amp;', '=1+1']) assert.deepEqual(ids({ query }, source), ['exact']);
  assert.deepEqual(ids({ query: 'CAFE\u0301' }, source), ['decomposed']);
  assert.deepEqual(ids({ query: 'café' }, source), ['exact', 'plain']);
  assert.deepEqual(ids({ query: '.*missing' }, source), []);
});

test('exact stale, unknown and sentinel-like label and parcel filters never widen the result', () => {
  const source = [
    report('unknown', { label: 'retired-label', parcel_id: 'missing-parcel' }),
    report('prototype', { label: '__proto__', parcel_id: '__proto__' }),
    report('all-literal', { label: 'all', parcel_id: 'all' }),
    report('normal'),
  ];
  for (const [label, parcelId, id] of [['retired-label', 'missing-parcel', 'unknown'], ['__proto__', '__proto__', 'prototype'], ['all', 'all', 'all-literal']]) {
    assert.deepEqual(ids({ label, parcelId }, source), [id]);
  }
  assert.deepEqual(ids({ label: 'NORMAL' }, source), []);
  assert.deepEqual(ids({ label: ' normal' }, source), []);
  assert.deepEqual(ids({ parcelId: 'parcel-full-a' }, source), []);
  assert.deepEqual(ids({ parcelId: 'missing' }, source), []);
  assert.deepEqual(ids({ query: 'missing-parcel' }, source), ['unknown']);
  assert.deepEqual(ids({ query: 'North' }, source), ['normal']);
});

test('invalid or reversed filter dates fail closed without calendar overflow', () => {
  for (const day of ['2026-02-29', '2026-02-30', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '2026-1-01', '26-01-01', '2026-10-18T00:00:00Z', ' 2026-10-18', '2026-10-18 ', '2026-10-18\n', '2026-10-18\r\n']) {
    for (const field of ['from', 'to']) {
      const input = filters({ [field]: day });
      assert.match(recordFilterError(input), /日期/);
      assert.deepEqual(filterVerifications(rows, parcels, input), [], day);
    }
  }
  const reversed = filters({ from: '2026-10-19', to: '2026-10-18' });
  assert.match(recordFilterError(reversed), /晚于/);
  assert.deepEqual(filterVerifications(rows, parcels, reversed), []);
  for (const day of ['0001-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) assert.equal(recordFilterError(filters({ from: day, to: day })), undefined);
});

test('malformed filter shapes or field types report an error and cannot silently become all records', () => {
  const malformed = [null, undefined, [], {}, 'all', true, 3, ...['query', 'label', 'from', 'to', 'parcelId'].flatMap(field =>
    [null, undefined, false, 0, [], {}, new String('')].map(value => filters({ [field]: value })))];
  for (const input of malformed) {
    assert.match(recordFilterError(input), /格式无效/);
    assert.equal(recordFiltersActive(input), true);
    assert.deepEqual(filterVerifications(rows, parcels, input), []);
    assert.match(recordFilterDescription(input, {}, parcels), /^筛选无效：/);
  }
});

test('query limit matches maxlength at 200 raw UTF-16 code units, not code points or trimmed length', () => {
  for (const query of ['x'.repeat(200), '🌾'.repeat(100)]) {
    const input = filters({ query });
    assert.equal(recordFilterError(input), undefined);
    assert.deepEqual(ids({ query }, [report('match', { note: query })]), ['match']);
  }
  for (const query of ['x'.repeat(201), '🌾'.repeat(101), ` ${'x'.repeat(200)}`, ' '.repeat(201)]) {
    const input = filters({ query });
    assert.match(recordFilterError(input), /200/);
    assert.deepEqual(filterVerifications([report('match', { note: query })], parcels, input), []);
  }
});

test('unknown or malformed observed timestamps survive only without date filters and never use created_at', () => {
  const unknown = [undefined, null, '', 1790000000000, {}, 'not-a-date', '2026-10-18', '2026-10-18T00:00:00', '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '0000-01-01T00:00:00Z', '2026-10-18T24:00:00Z', '2026-10-18T00:60:00Z', '2026-10-18T00:00:60Z', '2026-10-18T00:00:00+24:00', '2026-10-18T00:00:00-08:60', '2026-10-18T00:00:00Z extra', '2026-10-18T00:00:00Z\n', '2026-10-18T00:00:00Z\r\n'];
  const source = unknown.map((observed_at, index) => report(`unknown-${index}`, { observed_at }));
  assert.equal(ids({}, source).length, unknown.length);
  assert.equal(ids({ label: 'normal', query: 'literal' }, source).length, unknown.length);
  for (const changes of [{ from: '0001-01-01' }, { to: '9999-12-31' }, { from: '2026-10-20', to: '2026-10-20' }]) assert.deepEqual(ids(changes, source), []);
});

test('inclusive observed days use the actual device timezone across both date-line directions', () => {
  const values = ['2026-10-18T00:30:00Z', '2026-10-18T23:30:00Z'];
  for (const [zone, expected] of [['America/Los_Angeles', ['1']], ['Pacific/Honolulu', ['1']], ['UTC', ['0', '1']], ['Asia/Shanghai', ['0']], ['Pacific/Kiritimati', ['0']]]) {
    const result = inZone(zone, values, { from: '2026-10-18', to: '2026-10-18' });
    assert.deepEqual(result.ids, expected, zone);
    assert.ok(result.description.includes(zone), result.description);
  }
  assert.deepEqual(inZone('Pacific/Kiritimati', ['2026-12-31T09:59:59.999999Z', '2026-12-31T10:00:00.000001Z'], { from: '2027-01-01' }).ids, ['1']);
  assert.deepEqual(inZone('America/Los_Angeles', values, { to: '2026-10-17' }).ids, ['0']);
});

test('DST transitions preserve both repeated instants and inclusive local-day edges without fixed-duration days', () => {
  const spring = ['2026-03-08T07:59:59.999999Z', '2026-03-08T08:00:00Z', '2026-03-08T09:59:59Z', '2026-03-08T10:00:00Z', '2026-03-09T06:59:59.999999Z', '2026-03-09T07:00:00Z'];
  assert.deepEqual(inZone('America/Los_Angeles', spring, { from: '2026-03-08', to: '2026-03-08' }).ids, ['1', '2', '3', '4']);
  const fall = ['2026-11-01T06:59:59Z', '2026-11-01T07:00:00Z', '2026-11-01T01:30:00-07:00', '2026-11-01T01:30:00-08:00', '2026-11-02T07:59:59.999999Z', '2026-11-02T08:00:00Z'];
  assert.deepEqual(inZone('America/Los_Angeles', fall, { from: '2026-11-01', to: '2026-11-01' }).ids, ['1', '2', '3', '4']);
});

test('UTC microseconds and equivalent aware offsets agree, with no rounding into the next day', () => {
  const same = ['2026-10-18T23:59:59.999999+00:00', '2026-10-18T23:59:59.999999Z', '2026-10-19T07:59:59.999999+08:00', '2026-10-18T16:59:59.999999-07:00', '2026-10-19T00:00:00.000001Z'];
  assert.deepEqual(inZone('UTC', same, { from: '2026-10-18', to: '2026-10-18' }).ids, ['0', '1', '2', '3']);
  const compatible = ['2026-10-18T12:00Z', '2026-10-18t12:00:00z', '2026-10-18 12:00:00+0000', '2026-10-18T20:00:00+08', '2026-10-18T12:00:00,123456Z'];
  assert.deepEqual(inZone('UTC', compatible, { from: '2026-10-18', to: '2026-10-18' }).ids, ['0', '1', '2', '3', '4']);
  assert.deepEqual(inZone('UTC', ['0001-01-01T00:00:00Z', '0099-01-01T00:00:00Z'], { from: '0001-01-01', to: '0001-01-01' }).ids, ['0']);
});

test('selector and descriptions accept frozen input without mutating records, parcels or filters', () => {
  const source = Object.freeze(rows.map(row => Object.freeze({ ...row, photo_ids: Object.freeze([...row.photo_ids]) })));
  const catalog = Object.freeze(parcels.map(parcel => Object.freeze({ ...parcel })));
  const input = Object.freeze(filters({ query: 'WATER', parcelId: 'parcel-full-A', from: '2026-10-15' }));
  const before = JSON.stringify({ source, catalog, input });
  assert.deepEqual(filterVerifications(source, catalog, input).map(row => row.id), ['backfill', 'latest', 'middle']);
  recordFilterDescription(input, Object.freeze({ normal: '未见明显异常' }), catalog);
  assert.equal(JSON.stringify({ source, catalog, input }), before);
});

test('descriptions name exact query, label, parcel and observed range as plain text for caller escaping', () => {
  assert.equal(recordFilterDescription(defaultRecordFilters(), {}, parcels), '无附加筛选');
  assert.equal(recordFilterDescription(filters({ query: ' \n ' }), {}, parcels), '无附加筛选');
  const input = filters({ query: '  <img src="x"> & [a-z]+  ', label: 'normal', parcelId: 'parcel-full-A', from: '2026-10-15', to: '2026-10-18' });
  const description = recordFilterDescription(input, { normal: '未见明显异常' }, parcels);
  for (const text of ['<img src="x"> & [a-z]+', '未见明显异常（normal）', '精确匹配', 'North <field>', '2025-2026', 'parcel-full-A', '观察日期', '2026-10-15 至 2026-10-18', '本机时区', '含起止日']) assert.ok(description.includes(text), text);
  assert.doesNotMatch(description, /&lt;|&amp;/);
  assert.match(esc(description), /&lt;img src=&quot;x&quot;&gt; &amp; \[a-z\]\+/);
  assert.match(recordFilterDescription(filters({ label: '__proto__', parcelId: 'unloaded' }), {}, []), /现场判断：__proto__（精确匹配）.*地块 ID：unloaded（档案未读取）/);
  assert.doesNotMatch(recordFilterDescription(filters({ label: 'constructor' }), {}, []), /function Object/);
  assert.match(recordFilterDescription(filters({ from: '2026-10-15' }), {}, []), /2026-10-15 至 不限/);
  assert.match(recordFilterDescription(filters({ to: '2026-10-18' }), {}, []), /不限 至 2026-10-18/);
});
