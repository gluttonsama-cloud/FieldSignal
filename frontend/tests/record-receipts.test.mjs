import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api.ts';
import { validateParcelReceipt, validateVisitReceipt, validateFollowUpVisitReceipt, validateVisitPlanReceipt, validateFarmEventReceipt } from '../src/record-receipts.ts';

const time = '2026-10-18T04:05:06.123456+00:00';
const geometry = { type: 'Polygon', coordinates: [[[112, 30], [112.001, 30], [112.001, 30.001], [112, 30]]] };
const parcelPayload = { name: 'Synthetic parcel', season: '2026-2027', geometry };
const parcel = {
  id: 'parcel-synthetic', ...parcelPayload, region: 'shayang', crop: 'oilseed_rape',
  sowing_date: null, cultivar: null, boundary_source: 'user_provided', boundary_reference: null,
  boundary_crs: 'EPSG:4326', area_ha: 0.5328, area_method: 'local_equirectangular_estimate_not_survey',
  data_origin: 'user', created_at: time,
};
const visitPayload = { parcel_id: parcel.id, due_date: '2026-10-18', risk_id: 'risk-synthetic', assignee: 'Synthetic person', note: 'Original prompt' };
const visit = { id: 'visit-synthetic', ...visitPayload, status: 'pending', plan_revision: 0, data_origin: 'user', created_at: time };
const planPayload = { expected_revision: 0, due_date: '2025-01-01', assignee: 'Changed person' };
const plan = { ...visit, due_date: planPayload.due_date, assignee: planPayload.assignee, plan_revision: 1, plan_updated_at: '2026-10-18T04:06:00Z' };
const eventPayload = { occurred_on: '2026-10-18', kind: 'drainage', note: 'Synthetic farm event' };
const event = { id: 'event-synthetic', parcel_id: parcel.id, ...eventPayload, created_at: time, data_origin: 'user' };
const source = { id: 'source-report', parcel_id: parcel.id };
const followUpPayload = { due_date: '2026-10-19', assignee: 'Synthetic person', note: 'Check the original report again' };
const followUp = { ...visit, ...followUpPayload, risk_id: null, source_verification_id: source.id };
const checks = [
  ['parcel', parcel, raw => validateParcelReceipt(raw, parcelPayload)],
  ['visit', visit, raw => validateVisitReceipt(raw, visitPayload)],
  ['plan', plan, raw => validateVisitPlanReceipt(raw, visit, planPayload)],
  ['event', event, raw => validateFarmEventReceipt(raw, parcel.id, eventPayload)],
  ['follow-up', followUp, raw => validateFollowUpVisitReceipt(raw, source, followUpPayload)],
];
function rejected(action) {
  assert.throws(action, error => error instanceof Error && !(error instanceof ApiError) && /回执.*尚未确认/.test(error.message));
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('all real API receipt shapes pass and validation never mutates receipts or submissions', () => {
  for (const [, receipt, check] of checks) {
    const raw = freeze(structuredClone(receipt)), before = JSON.stringify(raw);
    assert.equal(check(raw), raw);
    assert.equal(JSON.stringify(raw), before);
  }
  for (const value of [parcelPayload, visitPayload, planPayload, eventPayload, visit]) freeze(value);
  checks.forEach(([, receipt, check]) => check(receipt));
});

test('all operations reject non-record JSON, missing identities and malformed server timestamps as uncertain results', () => {
  for (const [, receipt, check] of checks) {
    for (const raw of [null, undefined, [], [receipt], '', 'ok', 1, true, {}]) rejected(() => check(raw));
    for (const id of [undefined, null, '', ' \n ', 42, [], {}, ' padded ']) rejected(() => check({ ...receipt, id }));
    for (const created_at of [
      undefined, null, '', 123, '2026-10-18', '2026-10-18T04:05:06',
      '2026-02-30T04:05:06Z', '2025-02-29T04:05:06Z', '2026-13-01T00:00:00Z',
      '2026-10-18T24:00:00Z', '2026-10-18T04:60:00Z', '2026-10-18T04:05:60Z',
      '2026-10-18T04:05:06+24:00', '2026-10-18T04:05:06+08:60', '0000-01-01T00:00:00Z',
    ]) rejected(() => check({ ...receipt, created_at }));
  }
});

test('timezone-bearing ISO timestamp compatibility includes offsets, microseconds and space separators', () => {
  for (const created_at of [
    '2026-10-18T04:05:06.123456Z', '2026-10-18t04:05:06.123456z',
    '2026-10-18 12:05:06.123456+08:00', '2026-10-18T12:05:06.123456+0800',
    '2026-10-18T12:05:06,123456+08', '2026-10-18T04:05:06.123456000Z',
  ]) {
    for (const [, receipt, check] of checks) assert.equal(check({ ...receipt, created_at }).created_at, created_at);
  }
  assert.equal(validateFarmEventReceipt({ ...event, created_at: '2024-02-29T00:00Z' }, parcel.id, eventPayload).id, event.id);
});

test('parcel submission defaults, whitespace and geometry key ordering compare semantically without guessing generated area', () => {
  const payload = {
    ...parcelPayload, name: '  Synthetic parcel\n', region: 'other', crop: 'oilseed_rape', season: ' 2026-2027 ',
    sowing_date: '2026-10-01', cultivar: ' cultivar ', boundary_source: 'user_survey', boundary_reference: ' local survey ',
    geometry: { coordinates: structuredClone(geometry.coordinates), type: 'Polygon' },
  };
  const raw = { ...parcel, region: 'other', sowing_date: '2026-10-01', cultivar: 'cultivar', boundary_source: 'user_survey', boundary_reference: 'local survey', area_ha: 123.4567 };
  assert.equal(validateParcelReceipt(raw, payload), raw);
  assert.equal(validateParcelReceipt({ ...parcel, cultivar: '' }, { ...parcelPayload, cultivar: ' \t ' }).cultivar, '');
  const missing = { ...parcel }; delete missing.sowing_date; delete missing.cultivar; delete missing.boundary_reference;
  assert.equal(validateParcelReceipt(missing, parcelPayload), missing);
  for (const field of ['name', 'region', 'crop', 'season', 'geometry', 'area_ha', 'area_method', 'boundary_source', 'boundary_crs', 'data_origin']) {
    const raw = { ...parcel }; delete raw[field]; rejected(() => validateParcelReceipt(raw, parcelPayload));
  }
});

test('normalized receipts follow backend Unicode White_Space for every submitted string, including parcel IDs', () => {
  // Verified against the installed Pydantic FarmEventCreate and VisitCreate
  // models. This is Rust's White_Space set, not JS trim or Python str.strip.
  const stripped = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
    ...Array.from({ length: 11 }, (_, index) => 0x2000 + index), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
  for (const code of stripped) {
    const edge = String.fromCodePoint(code), wrap = value => `${edge}${value}${edge}`;
    assert.equal(validateFarmEventReceipt(event, parcel.id, { ...eventPayload, note: wrap(event.note) }), event);
    assert.equal(validateParcelReceipt(parcel, { ...parcelPayload, name: wrap(parcel.name), season: wrap(parcel.season) }), parcel);
    assert.equal(validateVisitReceipt(visit, { ...visitPayload, parcel_id: wrap(parcel.id), risk_id: wrap(visit.risk_id), assignee: wrap(visit.assignee), note: wrap(visit.note) }), visit);
    assert.equal(validateVisitPlanReceipt(plan, visit, { ...planPayload, assignee: wrap(plan.assignee) }), plan);
    rejected(() => validateFarmEventReceipt({ ...event, note: edge }, parcel.id, { ...eventPayload, note: edge }));
  }
  const payload = { ...eventPayload, note: ` \u0085\n${event.note}\t\u0085 ` };
  assert.equal(validateFarmEventReceipt(event, parcel.id, payload), event);
  assert.equal(validateFarmEventReceipt(event, parcel.id, payload), event, 'same-key replay remains recognizable');
  const raw = { ...parcel, cultivar: 'cultivar', boundary_reference: 'reference' };
  assert.equal(validateParcelReceipt(raw, { ...parcelPayload, cultivar: '\u0085cultivar\u0085', boundary_reference: '\u0085reference\u0085' }), raw);
  rejected(() => validateVisitReceipt({ ...visit, id: '\u0085' }, visitPayload));
});

test('BOM and non-whitespace controls preserved by the backend are meaningful even at string edges', () => {
  const preserved = [0, 1, 8, 0x0e, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f, 0x180e, 0x200b, 0x2060, 0xfeff];
  for (const code of preserved) {
    const edge = String.fromCodePoint(code), note = `${edge}marker${edge}`;
    assert.equal(validateFarmEventReceipt({ ...event, note }, parcel.id, { ...eventPayload, note }).note, note);
    rejected(() => validateFarmEventReceipt({ ...event, note: 'marker' }, parcel.id, { ...eventPayload, note }));
    assert.equal(validateFarmEventReceipt({ ...event, note: edge }, parcel.id, { ...eventPayload, note: edge }).note, edge);
  }
  const parcel_id = '\ufeffparcel\ufeff', risk_id = '\ufeffrisk\ufeff';
  assert.equal(validateVisitReceipt({ ...visit, parcel_id, risk_id }, { ...visitPayload, parcel_id, risk_id }).parcel_id, parcel_id);
  const original = { ...visit, note: '\ufeff' }, result = { ...plan, note: '\ufeff' };
  assert.equal(validateVisitPlanReceipt(result, original, planPayload), result);
});

test('normalization never collapses inner whitespace or strips date and literal enum fields', () => {
  for (const space of [' ', '\t', '\n', '\u0085', '\u00a0', '\u2003', '\u2028', '\u3000', '\ufeff', '\u001c']) {
    const note = `first${space}second`;
    assert.equal(validateFarmEventReceipt({ ...event, note }, parcel.id, { ...eventPayload, note }).note, note);
    rejected(() => validateFarmEventReceipt({ ...event, note: 'firstsecond' }, parcel.id, { ...eventPayload, note }));
    rejected(() => validateFarmEventReceipt(event, parcel.id, { ...eventPayload, kind: `${space}drainage${space}` }));
    rejected(() => validateVisitReceipt(visit, { ...visitPayload, due_date: `${space}${visit.due_date}${space}` }));
  }
  for (const [field, value] of [['region', 'shayang'], ['crop', 'oilseed_rape'], ['boundary_source', 'user_provided']]) {
    rejected(() => validateParcelReceipt(parcel, { ...parcelPayload, [field]: ` ${value} ` }));
  }
});

test('text limits count Unicode characters like the backend, not UTF-16 code units', () => {
  const name = '🌱'.repeat(80), note = '🌾'.repeat(2000), assignee = '🧑'.repeat(100);
  assert.equal(validateParcelReceipt({ ...parcel, name }, { ...parcelPayload, name }).name, name);
  assert.equal(validateVisitReceipt({ ...visit, assignee }, { ...visitPayload, assignee }).assignee, assignee);
  assert.equal(validateFarmEventReceipt({ ...event, note }, parcel.id, { ...eventPayload, note }).note, note);
  rejected(() => validateParcelReceipt({ ...parcel, name: `${name}🌱` }, { ...parcelPayload, name: `${name}🌱` }));
});

test('parcel receipts reject wrong submitted fields, changed coordinates and malformed generated metadata', () => {
  for (const mismatch of [
    { name: 'Another parcel' }, { region: 'other' }, { crop: 'wheat' }, { season: '2025-2026' },
    { sowing_date: '2026-10-01' }, { cultivar: '' }, { boundary_source: 'user_survey' }, { boundary_reference: 'unexpected' },
    { data_origin: 'fixture' }, { boundary_crs: 'EPSG:3857' }, { area_method: 'authoritative_survey' },
    ...[undefined, null, 0, -1, '0.5328', NaN, Infinity, {}].map(area_ha => ({ area_ha })),
  ]) rejected(() => validateParcelReceipt({ ...parcel, ...mismatch }, parcelPayload));
  for (const boundary of [
    null, [], {}, { ...geometry, type: 'MultiPolygon' }, { type: 'Polygon', coordinates: [] },
    { type: 'Polygon', coordinates: [geometry.coordinates[0], geometry.coordinates[0]] },
    { type: 'Polygon', coordinates: [[[112, 30], [112.002, 30], [112.001, 30.001], [112, 30]]] },
    { type: 'Polygon', coordinates: [[[112, 30], ['112.001', 30], [112.001, 30.001], [112, 30]]] },
    { type: 'Polygon', coordinates: [[[112, 30], [NaN, 30], [112.001, 30.001], [112, 30]]] },
    { type: 'Polygon', coordinates: [[[112, 30], [112.001, 30, 1], [112.001, 30.001], [112, 30]]] },
  ]) rejected(() => validateParcelReceipt({ ...parcel, geometry: boundary }, parcelPayload));
  rejected(() => validateParcelReceipt({ ...parcel, sowing_date: null }, { ...parcelPayload, sowing_date: '2026-10-01' }));
  rejected(() => validateParcelReceipt({ ...parcel, cultivar: null }, { ...parcelPayload, cultivar: '' }));
});

test('create visit compares actual submitted fields and accepts original pending receipt rather than a later task state', () => {
  assert.equal(validateVisitReceipt(visit, { ...visitPayload, parcel_id: ` ${parcel.id} `, risk_id: ' risk-synthetic ', assignee: ' Synthetic person ', note: '\nOriginal prompt ' }), visit);
  for (const mismatch of [
    { parcel_id: 'other-parcel' }, { risk_id: 'other-risk' }, { risk_id: null }, { due_date: '2026-10-19' },
    { assignee: null }, { note: 'Other prompt' }, { status: 'completed' }, { status: 'unknown' },
    { plan_revision: 1 }, { plan_revision: null }, { plan_revision: '0' }, { plan_revision: NaN },
    { plan_updated_at: 'invalid' }, { data_origin: 'unknown' },
  ]) rejected(() => validateVisitReceipt({ ...visit, ...mismatch }, visitPayload));
  const legacy = { ...visit }; delete legacy.plan_revision; delete legacy.data_origin;
  assert.equal(validateVisitReceipt(legacy, visitPayload), legacy);
  const manualPayload = { parcel_id: parcel.id, due_date: '2026-10-18' };
  const manual = { ...visit, risk_id: null, assignee: null, note: null };
  assert.equal(validateVisitReceipt(manual, manualPayload), manual);
  delete manual.risk_id; delete manual.assignee; delete manual.note;
  assert.equal(validateVisitReceipt(manual, manualPayload), manual);
  rejected(() => validateVisitReceipt({ ...manual, risk_id: '' }, manualPayload));
  rejected(() => validateVisitReceipt({ ...manual, note: '' }, manualPayload));
});

test('plan receipt binds target and immutable fields to opening snapshot, not later cached visits', () => {
  assert.equal(validateVisitPlanReceipt(plan, visit, { ...planPayload, assignee: ' Changed person ' }), plan);
  for (const mismatch of [
    { id: 'other-visit' }, { parcel_id: 'other-parcel' }, { risk_id: 'other-risk' }, { risk_id: null },
    { note: 'Changed prompt' }, { note: null }, { created_at: '2026-10-18T04:05:06.123457Z' },
    { due_date: '2025-01-02' }, { assignee: 'Another person' }, { status: 'completed' },
    { plan_revision: 0 }, { plan_revision: 2 }, { plan_revision: 1.1 }, { plan_revision: '1' },
    { plan_revision: null }, { plan_revision: Infinity }, { plan_updated_at: null },
    { plan_updated_at: '2026-02-30T04:06:00Z' }, { plan_updated_at: '2026-10-18T04:06:00' },
  ]) rejected(() => validateVisitPlanReceipt({ ...plan, ...mismatch }, visit, planPayload));
  for (const field of ['id', 'parcel_id', 'created_at', 'status', 'due_date', 'plan_revision', 'plan_updated_at']) {
    const raw = { ...plan }; delete raw[field]; rejected(() => validateVisitPlanReceipt(raw, visit, planPayload));
  }
  for (const expected_revision of [-1, 0.5, '0', null, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    rejected(() => validateVisitPlanReceipt(plan, visit, { ...planPayload, expected_revision }));
  }
  const legacy = { ...visit }; delete legacy.risk_id; delete legacy.note;
  const legacyPlan = { ...plan, risk_id: null, note: null, assignee: null };
  assert.equal(validateVisitPlanReceipt(legacyPlan, legacy, { ...planPayload, assignee: null }), legacyPlan);
});

test('farm-event receipt compares fixed parcel and all submitted fields without trimming meaningful inner whitespace', () => {
  assert.equal(validateFarmEventReceipt(event, parcel.id, { ...eventPayload, note: ' Synthetic farm event\n' }), event);
  for (const mismatch of [
    { parcel_id: 'other-parcel' }, { parcel_id: '' }, { occurred_on: '2026-10-17' }, { occurred_on: '2026-02-30' },
    { kind: 'sowing' }, { kind: 'unknown' }, { note: 'Synthetic  farm event' }, { note: '' }, { note: {} },
  ]) rejected(() => validateFarmEventReceipt({ ...event, ...mismatch }, parcel.id, eventPayload));
  for (const field of ['parcel_id', 'occurred_on', 'kind', 'note']) {
    const raw = { ...event }; delete raw[field]; rejected(() => validateFarmEventReceipt(raw, parcel.id, eventPayload));
  }
  const legacy = { ...event }; delete legacy.data_origin;
  assert.equal(validateFarmEventReceipt(legacy, parcel.id, eventPayload), legacy);
});

test('rejected receipts and their submitted payloads remain unchanged', () => {
  for (const [, receipt, check] of checks) {
    const raw = freeze({ ...structuredClone(receipt), id: '' }), before = JSON.stringify(raw);
    rejected(() => check(raw));
    assert.equal(JSON.stringify(raw), before);
  }
});

test('follow-up receipt binds the immutable source report and parcel without acquiring its candidate', () => {
  const frozenSource=freeze(structuredClone(source)),payload=freeze(structuredClone(followUpPayload)),raw=freeze(structuredClone(followUp));
  assert.equal(validateFollowUpVisitReceipt(raw,frozenSource,payload),raw);
  for(const mismatch of [
    {source_verification_id:undefined},{source_verification_id:null},{source_verification_id:''},
    {source_verification_id:'other-report'},{source_verification_id:` ${source.id} `},
    {parcel_id:'other-parcel'},{risk_id:'original-candidate'},{status:'completed'},
    {due_date:'2026-10-20'},{assignee:'Another person'},{note:'Changed note'},{plan_revision:1},
  ])rejected(()=>validateFollowUpVisitReceipt({...followUp,...mismatch},source,followUpPayload));
  for(const invalid of [{...source,id:''},{...source,id:' source-report '},{...source,parcel_id:' parcel-synthetic '}])
    rejected(()=>validateFollowUpVisitReceipt(followUp,invalid,followUpPayload));
  assert.equal(validateFollowUpVisitReceipt(followUp,source,{...followUpPayload,note:`\u0085${followUpPayload.note}\u0085`}),followUp);
});

test('ordinary create receipts reject unsolicited source links while legacy receipts remain compatible', () => {
  assert.equal(validateVisitReceipt({...visit,source_verification_id:null},visitPayload).id,visit.id);
  assert.equal(validateVisitReceipt(visit,visitPayload),visit);
  for(const source_verification_id of ['source-report','',{},42])
    rejected(()=>validateVisitReceipt({...visit,source_verification_id},visitPayload));
});

test('plan receipt preserves follow-up lineage and does not add, remove or rewrite source relationships', () => {
  const original={...followUp},result={...followUp,...planPayload,plan_revision:1,plan_updated_at:plan.plan_updated_at};
  delete result.expected_revision;
  assert.equal(validateVisitPlanReceipt(result,original,planPayload),result);
  for(const source_verification_id of [undefined,null,'','other-report',' source-report '])
    rejected(()=>validateVisitPlanReceipt({...result,source_verification_id},original,planPayload));
  rejected(()=>validateVisitPlanReceipt({...plan,source_verification_id:source.id},visit,planPayload));
});
