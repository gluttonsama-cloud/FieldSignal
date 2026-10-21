import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoreRead, validateObservationRead, validateAnalysisRead, validateEventRead } from '../src/read-contracts.ts';
import { ApiError } from '../src/api.ts';
import { boundaryMap, shortParcelId, usable } from '../src/display.ts';
import { qualityDetails } from '../src/sources.ts';

const verification = () => ({ id: 'record-1', parcel_id: 'parcel-1', visit_id: 'visit-1', photo_ids: ['photo-1'] });
const observation = () => ({ id: 'observation-1', parcel_id: 'parcel-1', observed_at: '2026-10-18', source: 'sentinel2',
  features: { ndvi: 0.4 }, quality: { usable: true, valid_fraction: 0.8, cloud_fraction: 0.1, flags: [] },
  provenance: { collection: 'synthetic', processing_version: 'test', temporal_support: 'daily_utc',
    spatial_support: { kind: 'parcel', bounds: [1, 2, 3, 4] } } });
const analysis = () => ({ id: 'analysis-1', parcel_id: 'parcel-1', evaluated_at: '2026-10-18', status: 'candidate' });
const event = () => ({ id: 'event-1', parcel_id: 'parcel-1', occurred_on: '2026-10-18', kind: 'drainage', note: 'Synthetic only' });
const core = () => [{ status: 'ok', version: 'test', demo_enabled: false },
  { parcel_count: 1, open_risk_count: 1, pending_visit_count: 1, verification_count: 1,
    parcels: [{ id: 'parcel-1', name: 'Synthetic parcel' }], recent_verifications: [verification()] },
  [{ id: 'risk-1', parcel_id: 'parcel-1', evidence: {} }],
  [{ id: 'visit-1', parcel_id: 'parcel-1', status: 'pending' }], [verification()]];

function readError(fn, path, label) {
  assert.throws(fn, error => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof ApiError), 'read failures must not claim an uncertain write');
    assert.match(error.message, /读取失败.*响应结构无效/);
    assert.ok(error.message.includes(path), `${error.message} should identify ${path}`);
    if (label) assert.ok(error.message.includes(label));
    assert.doesNotMatch(error.message, /提交|写入|保存成功/);
    return true;
  });
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('core read rejects malformed root, missing roots and non-array endpoint results without substituting empties', () => {
  for (const raw of [null, {}, [], core().slice(0, 4), [...core(), []]]) readError(() => validateCoreRead(raw), 'core', '工作台');
  for (const index of [0, 1]) for (const bad of [null, [], 'bad', 0]) {
    const raw = core(); raw[index] = bad;
    readError(() => validateCoreRead(raw), index === 0 ? 'health' : 'dashboard');
  }
  for (const [index, path] of [[2, 'risks'], [3, 'visits'], [4, 'verifications']]) {
    for (const bad of [null, {}, 'bad', 0]) {
      const raw = core(); raw[index] = bad; readError(() => validateCoreRead(raw), path);
    }
  }
});

test('core read rejects null, primitive, array, sparse and identity-less rows in every rendered collection', () => {
  const endpoints = [
    ['dashboard.parcels', (raw, rows) => { raw[1].parcels = rows; }],
    ['dashboard.recent_verifications', (raw, rows) => { raw[1].recent_verifications = rows; }],
    ['risks', (raw, rows) => { raw[2] = rows; }],
    ['visits', (raw, rows) => { raw[3] = rows; }],
    ['verifications', (raw, rows) => { raw[4] = rows; }],
  ];
  for (const [path, replace] of endpoints) for (const bad of [null, 'bad', 42, [], {}, { id: 42 }]) {
    const raw = core(); replace(raw, [bad]); readError(() => validateCoreRead(raw), `${path}[0]`);
  }
  for (const [path, replace] of endpoints) {
    const raw = core(); replace(raw, new Array(1)); readError(() => validateCoreRead(raw), `${path}[0]`);
  }
  for (const index of [2, 3, 4]) {
    const raw = core(); raw[index][0].parcel_id = null; readError(() => validateCoreRead(raw), 'parcel_id');
  }
});

test('dashboard requires safe counts and collections, and health only checks fields that are supplied', () => {
  for (const key of ['parcel_count', 'open_risk_count', 'pending_visit_count', 'verification_count']) {
    for (const bad of [undefined, null, '1', true, NaN, Infinity, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
      const raw = core(); raw[1][key] = bad; readError(() => validateCoreRead(raw), `dashboard.${key}`);
    }
  }
  for (const key of ['parcels', 'recent_verifications']) for (const bad of [null, {}, 0]) {
    const raw = core(); raw[1][key] = bad; readError(() => validateCoreRead(raw), `dashboard.${key}`);
  }
  const legacy = core(); legacy[0] = {}; delete legacy[1].recent_verifications;
  assert.equal(validateCoreRead(legacy), legacy);
  for (const [key, bad] of [['status', 1], ['version', null], ['demo_enabled', 'false']]) {
    const raw = core(); raw[0][key] = bad; readError(() => validateCoreRead(raw), `health.${key}`);
  }
});

test('verification photo identity arrays and risk evidence are mandatory, but legacy evidence content is not rewritten', () => {
  for (const bad of [undefined, null, {}, 'photo-1', [null], [1], new Array(1)]) {
    const raw = core(); raw[4][0].photo_ids = bad; readError(() => validateCoreRead(raw), 'photo_ids');
  }
  for (const bad of [undefined, null, [], 'bad']) {
    const raw = core(); raw[2][0].evidence = bad; readError(() => validateCoreRead(raw), 'evidence');
  }
  const raw = core(); raw[2][0].evidence = { limitations: 'Legacy saved limitation', baseline_observation_ids: ['legacy'] };
  assert.equal(validateCoreRead(raw), raw);
});

test('legacy visit omissions and nullable plan fields stay unchanged while unsafe sort and identity types fail', () => {
  const raw = core();
  raw[3] = [{ id: 'visit-1', parcel_id: 'parcel-1' }, { id: 'visit-2', parcel_id: 'parcel-1',
    status: null, due_date: null, created_at: null, assignee: null, risk_id: null, source_verification_id: null,
    plan_revision: null, plan_updated_at: null, note: null }];
  assert.equal(validateCoreRead(raw), raw);
  for (const key of ['due_date', 'created_at', 'assignee', 'status', 'risk_id', 'source_verification_id', 'plan_updated_at']) {
    for (const bad of [1, false, {}, []]) {
      const changed = core(); changed[3][0][key] = bad; readError(() => validateCoreRead(changed), `visits[0].${key}`);
    }
  }
  const changed = core(); changed[3][0].plan_revision = '1';
  readError(() => validateCoreRead(changed), 'plan_revision');
});

test('optional geometry guards all coordinate nesting without imposing polygon business validation', () => {
  for (const bad of [null, [], {}, { coordinates: 'abcd' }, { coordinates: [null] },
    { coordinates: [[null]] }, { coordinates: [[{}]] }, { coordinates: [[[1]]] },
    { coordinates: [[[1, '2']]] }, { coordinates: [[[1, NaN]]] }, { coordinates: [new Array(4)] }]) {
    const raw = core(); raw[1].parcels[0].geometry = bad;
    readError(() => validateCoreRead(raw), 'geometry');
  }
  const raw = core();
  raw[1].parcels[0].geometry = { type: 'future-compatible', coordinates: [[[500, 200, 3], [501, 201, 4]]] };
  assert.equal(validateCoreRead(raw), raw, 'read guard does not enforce CRS, extent, closure, or Polygon vocabulary');
  assert.doesNotThrow(() => boundaryMap(raw[1].parcels));
  assert.equal(shortParcelId(raw[1].parcels[0].id, raw[1].parcels), 'parcel-1');
});

for (const [label, validate, make] of [
  ['观测记录', validateObservationRead, observation], ['分析记录', validateAnalysisRead, analysis],
  ['农事记录', validateEventRead, event],
]) {
  test(`${label} rejects malformed roots, rows, identities, and mixed-parcel results as a whole`, () => {
    for (const raw of [undefined, null, {}, 'bad']) readError(() => validate(raw, 'parcel-1'), '', label);
    for (const row of [null, [], {}, 1, { ...make(), id: null }, { ...make(), parcel_id: 1 }]) {
      readError(() => validate([row], 'parcel-1'), '[0]', label);
    }
    const mixed = [make(), { ...make(), id: 'second', parcel_id: 'parcel-2' }], before = structuredClone(mixed);
    readError(() => validate(mixed, 'parcel-1'), '[1].parcel_id', label);
    assert.deepEqual(mixed, before, 'no partial filter or mutation after mismatch');
    readError(() => validate([make()], ''), 'parcel_id', label);
    assert.equal(validate([], 'parcel-1').length, 0);
  });
}

test('observations require features, quality and provenance objects and validate present collection/string render hazards', () => {
  for (const key of ['features', 'quality', 'provenance']) for (const bad of [undefined, null, [], 'bad']) {
    readError(() => validateObservationRead([{ ...observation(), [key]: bad }]), key);
  }
  for (const bad of [null, {}, 'flag', [null], [1]]) {
    const row = observation(); row.quality.flags = bad; readError(() => validateObservationRead([row]), 'quality.flags');
  }
  for (const bad of [null, {}, '1,2', [1, '2'], [NaN]]) {
    const row = observation(); row.provenance.spatial_support.bounds = bad;
    readError(() => validateObservationRead([row]), 'spatial_support.bounds');
  }
  for (const bad of ['bad', []]) {
    const row = observation(); row.provenance.spatial_support = bad;
    readError(() => validateObservationRead([row]), 'spatial_support');
  }
  for (const [key, bad] of [['usable', 'true'], ['valid_fraction', '0.9'], ['cloud_fraction', false]]) {
    const row = observation(); row.quality[key] = bad; readError(() => validateObservationRead([row]), `quality.${key}`);
  }
  const row = observation(); row.provenance.temporal_support = 1;
  readError(() => validateObservationRead([row]), 'temporal_support');
});

test('missing quality stays unknown and nullable values are not coerced to usable or zero', () => {
  const rows = [{ id: 'observation-1', parcel_id: 'parcel-1', source: 'weather', features: {}, quality: {}, provenance: {} },
    { id: 'observation-2', parcel_id: 'parcel-1', features: { ndvi: null },
      quality: { usable: null, valid_fraction: null, cloud_fraction: null }, provenance: { spatial_support: null, temporal_support: null } }];
  const original = structuredClone(rows);
  assert.equal(validateObservationRead(rows, 'parcel-1'), rows);
  assert.deepEqual(rows, original);
  assert.notEqual(usable(rows[0]), true);
  assert.match(qualityDetails(rows[0]), /未提供，待核验/);
  assert.doesNotMatch(qualityDetails(rows[0]), /0\.0%/);
  assert.equal(Object.hasOwn(rows[0].quality, 'valid_fraction'), false);
});

test('events require a sortable occurred_on string while analyses reject present non-string dates', () => {
  for (const bad of [undefined, null, 1, {}, []]) {
    readError(() => validateEventRead([{ ...event(), occurred_on: bad }], 'parcel-1'), 'occurred_on');
  }
  for (const bad of [1, {}, [], true]) {
    readError(() => validateAnalysisRead([{ ...analysis(), evaluated_at: bad }], 'parcel-1'), 'evaluated_at');
    readError(() => validateEventRead([{ ...event(), note: bad }], 'parcel-1'), 'note');
  }
  assert.doesNotThrow(() => validateAnalysisRead([{ id: 'analysis-legacy', parcel_id: 'parcel-1' }], 'parcel-1'));
});

test('unknown vocabularies, invalid date strings, additional metadata and nullable text stay compatible', () => {
  const raw = core();
  raw[1].parcels[0].region = 'future-region';
  Object.assign(raw[3][0], { status: 'legacy-state', due_date: 'not-a-date', created_at: 'impossible-time' });
  Object.assign(raw[4][0], { label: 'future-label', observed_at: 'bad-date', note: null, extension: { keep: true } });
  assert.equal(validateCoreRead(raw), raw);
  const observations = [{ ...observation(), source: 'future-source', observed_at: 'invalid', data_status: 'new-status' }];
  const analyses = [{ ...analysis(), evaluated_at: 'invalid', method: 'new-method', status: 'new-status' }];
  const events = [{ ...event(), occurred_on: '2026-02-30', kind: 'new-kind', note: null, created_at: null }];
  assert.equal(validateObservationRead(observations, 'parcel-1'), observations);
  assert.equal(validateAnalysisRead(analyses, 'parcel-1'), analyses);
  assert.equal(validateEventRead(events, 'parcel-1'), events);
});

test('successful guards preserve frozen top-level, row, and nested references without changing values', () => {
  const raw = freeze(core()), observations = freeze([observation()]), analyses = freeze([analysis()]), events = freeze([event()]);
  const originals = structuredClone({ raw, observations, analyses, events });
  assert.equal(validateCoreRead(raw), raw);
  assert.equal(validateCoreRead(raw)[1].parcels, raw[1].parcels);
  assert.equal(validateCoreRead(raw)[4][0].photo_ids, raw[4][0].photo_ids);
  assert.equal(validateObservationRead(observations, 'parcel-1'), observations);
  assert.equal(validateObservationRead(observations)[0].quality, observations[0].quality);
  assert.equal(validateAnalysisRead(analyses), analyses);
  assert.equal(validateEventRead(events, 'parcel-1'), events);
  assert.deepEqual({ raw, observations, analyses, events }, originals);
});
