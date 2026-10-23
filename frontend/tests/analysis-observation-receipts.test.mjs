import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api.ts';
import { validateAnalysisReceipt, validateObservationReceipt } from '../src/record-receipts.ts';
import { syntheticAnalysisReceipt, syntheticObservationPayload, syntheticObservationReceipt } from './helpers/analysis-observation-receipts.mjs';

const parcel = { id: 'parcel-synthetic', data_origin: 'user' };
const request = { method: 'statistical' };
const analysis = (raw, target = parcel, body = request) => validateAnalysisReceipt(raw, target, body);
const payload = syntheticObservationPayload();
const observation = (raw, body = payload, target = parcel.id) => validateObservationReceipt(raw, target, body);
function rejected(action, kind) {
  assert.throws(action, error => error instanceof Error && !(error instanceof ApiError) &&
    new RegExp(`${kind}.*回执.*尚未确认`).test(error.message));
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('analysis acknowledgments distinguish blocked, preview-only, and fixture outcomes for the exact requested method', () => {
  for (const origin of ['user', 'fixture']) for (const method of ['statistical', 'isolation_forest']) {
    const target = { ...parcel, data_origin: origin };
    for (const status of ['candidate', 'not_flagged', 'insufficient_data', 'stale']) {
      const raw = freeze(syntheticAnalysisReceipt(target, method, status)), before = JSON.stringify(raw);
      assert.equal(analysis(raw, target, { method }), raw);
      assert.equal(JSON.stringify(raw), before);
      if (origin === 'user') assert.equal(raw.risk_id, null, 'a preview must never acknowledge a monitoring event');
    }
  }
  assert.equal(analysis(syntheticAnalysisReceipt(), parcel, {}).method, 'statistical');
  assert.equal(analysis({ ...syntheticAnalysisReceipt(), qualification_status: 'unverified' }).qualification_status, 'unverified');
});

test('analysis rejects foreign target, method, provenance and unsafe trust combinations instead of inferring success from 2xx', () => {
  const raw = syntheticAnalysisReceipt();
  for (const changes of [
    { parcel_id: 'another-parcel' }, { method: 'isolation_forest' }, { method: 'future_model' },
    { data_origin: 'fixture' }, { mode: 'fixture_demo' }, { mode: 'monitoring' }, { mode: undefined },
    { qualification_status: 'qualified' }, { qualification_status: 'fixture_demo' }, { qualification_status: undefined },
    { monitoring_eligible: true }, { monitoring_eligible: 'false' }, { monitoring_eligible: undefined },
    { status: 'not_flagged' }, { status: 'candidate' }, { status: 'healthy' }, { status: 'blocked' },
    { preview_status: 'healthy' }, { preview_status: null }, { preview_status: undefined }, { preview_evidence: {} },
    { risk_id: 'foreign-risk' }, { risk_id: '' }, { risk_id: undefined }, { risk_id: [] },
    { qualification_reasons: undefined }, { qualification_reasons: 'verified' }, { qualification_reasons: [null] },
    { observation_count: -1 }, { observation_count: '21' }, { observation_count: 1.5 }, { observation_count: Infinity },
    { observation_count: Number.MAX_SAFE_INTEGER + 1 }, { observation_count: 0 }, { message: null }, { message: '' },
    { evaluated_at: '2026-02-30T00:00:00Z' }, { evaluated_at: '2026-10-18' }, { model_version: [] },
  ]) rejected(() => analysis({ ...raw, ...changes }), '分析');
  rejected(() => analysis(raw, { ...parcel, id: 'other' }), '分析');
  rejected(() => analysis(raw, { ...parcel, data_origin: 'fixture' }), '分析');
  rejected(() => analysis(raw, parcel, { method: 'future_model' }), '分析');
  rejected(() => analysis(raw, parcel, { method: null }), '分析');
});

test('analysis candidate risk IDs are mandatory only for fixture candidates, never borrowed for previews or blocked runs', () => {
  const fixture = { ...parcel, data_origin: 'fixture' };
  for (const outcome of ['candidate', 'not_flagged', 'insufficient_data', 'stale']) {
    const raw = syntheticAnalysisReceipt(fixture, 'statistical', outcome);
    for (const risk_id of [undefined, '', ' padded ', [], {}, 1, outcome === 'candidate' ? null : 'unexpected-risk']) {
      rejected(() => analysis({ ...raw, risk_id }, fixture), '分析');
    }
    for (const preview_status of ['candidate', 'not_flagged', 'stale', undefined]) {
      rejected(() => analysis({ ...raw, preview_status }, fixture), '分析');
    }
  }
  const candidate = syntheticAnalysisReceipt(parcel, 'statistical', 'candidate');
  for (const preview_evidence of [null, undefined, [], 'candidate']) rejected(() => analysis({ ...candidate, preview_evidence }), '分析');
  for (const outcome of ['stale', 'insufficient_data']) {
    const raw = syntheticAnalysisReceipt(parcel, 'statistical', outcome);
    rejected(() => analysis({ ...raw, status: 'preview_only' }), '分析');
    rejected(() => analysis({ ...raw, preview_evidence: {} }), '分析');
  }
});

test('both mutation guards reject malformed JSON roots, absent identity and impossible timestamps', () => {
  for (const [kind, raw, validate] of [['分析', syntheticAnalysisReceipt(), analysis], ['观测', syntheticObservationReceipt(payload), observation]]) {
    for (const bad of [undefined, null, [], [raw], {}, 0, true, 'ok']) rejected(() => validate(bad), kind);
    for (const id of [undefined, null, '', ' \n\u0085 ', ' padded ', 1, [], {}]) rejected(() => validate({ ...raw, id }), kind);
    for (const created_at of [undefined, null, '', [], '2026-10-18', '2026-02-30T00:00:00Z', '2026-10-18T24:00:00Z']) {
      rejected(() => validate({ ...raw, created_at }), kind);
    }
  }
});

test('single observation confirms complete normalized content without mutating defaults, nulls or property order', () => {
  const raw = freeze(syntheticObservationReceipt(payload)), expected = freeze(structuredClone(payload));
  const before = JSON.stringify([raw, expected]);
  assert.equal(observation(raw, expected), raw);
  assert.equal(JSON.stringify([raw, expected]), before);
  const reversed = Object.fromEntries(Object.entries(raw).reverse());
  reversed.features = { ndre: null, ndvi: 0.4 };
  assert.equal(observation(reversed), reversed, 'omitted optional null metrics are not extra observed values');
});

test('single observation rejects cross-parcel, changed source, every feature, quality, and provenance content mismatch', () => {
  const raw = syntheticObservationReceipt(payload);
  const mutations = [
    r => r.parcel_id = 'other-parcel', r => r.source = 'manual', r => r.source_record_id = 'another-source',
    r => r.data_origin = 'fixture', r => r.data_origin = 'public_sample', r => r.ingested_at = undefined,
    r => r.observed_at = '2026-10-18T04:05:06.123457Z', r => r.features.ndvi = 0.3,
    r => r.features.ndre = 0.3, r => r.features.unknown = 1, r => r.features = {},
    r => r.features.ndvi = '0.4', r => r.features.ndvi = Infinity,
    r => r.quality.usable = false, r => r.quality.usable = 1, r => r.quality.valid_fraction = 0.7,
    r => r.quality.cloud_fraction = 0.2, r => r.quality.flags = ['different'], r => delete r.quality.flags,
    r => r.provenance.provider = 'different', r => r.provenance.collection = 'different',
    r => r.provenance.item_id = 'different', r => r.provenance.processing_version = 'different',
    r => r.provenance.usage_scope = 'unverified', r => r.provenance.usage_scope = 'public_sample',
    r => r.provenance.temporal_support = 'daily_utc', r => r.provenance.license = 'different',
    r => r.provenance.source_uri = 'changed-source', r => r.provenance.support_note = 'added claim',
    r => r.provenance.retrieved_at = '2026-10-18T00:00:00Z', r => r.provenance.spatial_resolution_m = 20,
    r => r.provenance.parcel_geometry_sha256 = 'c'.repeat(64), r => r.provenance.parcel_mask_sha256 = 'c'.repeat(64),
    r => r.provenance.asset_checksums.mask = 'c'.repeat(64), r => r.provenance.asset_checksums.extra = 'a'.repeat(64),
    r => r.provenance.spatial_support.kind = 'public_window', r => r.provenance.spatial_support.bounds[0] = 113,
    r => r.provenance.spatial_support.crs = 'different', r => r.provenance.spatial_support.pixel_size_m = 10,
    r => r.provenance.spatial_support.valid_pixels = 20, r => r.provenance.spatial_support.grid_degrees = { latitude: 0.5 },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(raw); mutate(changed); rejected(() => observation(changed), '观测');
  }
  for (const key of ['features', 'quality', 'provenance']) for (const bad of [null, undefined, [], 'bad']) {
    rejected(() => observation({ ...raw, [key]: bad }), '观测');
  }
  rejected(() => observation(raw, payload, 'other-parcel'), '观测');
});

test('observation comparison follows server Unicode strings, exact enums and UTC microsecond normalization', () => {
  const expected = structuredClone(payload), raw = syntheticObservationReceipt(payload);
  expected.observed_at = '2026-10-18 12:05:06.1234569+0800';
  expected.source_record_id = `\u0085 ${payload.source_record_id} \u0085`;
  expected.provenance.provider = '\u0085 synthetic\u0085';
  expected.provenance.asset_checksums = { ' \u0085mask\u0085 ': 'b'.repeat(64) };
  expected.quality.flags = [' \u0085synthetic only\u0085 ']; raw.quality.flags = ['synthetic only'];
  expected.provenance.retrieved_at = '2026-10-18T12:30:00.1234567+08:00'; raw.provenance.retrieved_at = '2026-10-18T04:30:00.123456Z';
  assert.equal(observation(raw, expected), raw);
  for (const changes of [{ observed_at: '2026-10-18T04:05:06.1234569Z' }, { source: ' sentinel2 ' }, { source_record_id: expected.source_record_id }]) {
    rejected(() => observation({ ...raw, ...changes }, expected), '观测');
  }
  rejected(() => observation(raw, { ...expected, source: ' sentinel2 ' }), '观测');
  for (const time of ['2026-02-30T04:05:06Z', '2026-10-18T24:00:00Z', '2026-10-18', '2026-10-18T04:05:06']) {
    rejected(() => observation({ ...raw, observed_at: time }, { ...expected, observed_at: time }), '观测');
  }
});

test('manual and weather records preserve limited quality, optional defaults, numeric zero and boolean normalization', () => {
  const expected = { observed_at: '2026-10-18T00:00:00Z', source: 'weather', source_record_id: 'weather-synthetic',
    features: { precipitation_mm: 0, temperature_min_c: null }, quality: { usable: false, valid_fraction: 0, cloud_fraction: null },
    provenance: { provider: 'synthetic', collection: 'weather', item_id: 'synthetic', processing_version: 'test',
      spatial_support: { kind: 'coarse_grid', grid_degrees: { latitude: 0.5, longitude: 0.625 }, total_pixels: '1', valid_pixels: 0 } } };
  const raw = syntheticObservationReceipt(expected); delete raw.quality.cloud_fraction;
  raw.provenance.spatial_support.total_pixels = 1;
  assert.equal(observation(raw, expected), raw);
  for (const usable of ['false', 'NO', '0', 0]) assert.equal(observation(raw, { ...expected, quality: { ...expected.quality, usable } }), raw);
  rejected(() => observation({ ...raw, quality: { ...raw.quality, usable: 'false' } }, expected), '观测');
  expected.source = 'manual'; raw.source = 'manual';
  assert.equal(observation(raw, expected), raw);
  expected.features.precipitation_mm = null;
  rejected(() => observation(raw, expected), '观测');
});

test('unconfirmed single-import wording never promises idempotent retries or resolves provenance', () => {
  assert.throws(() => observation({}), /原记录可能已保存.*不要盲目重复导入/);
  assert.throws(() => analysis({}), /不要据此判断地块健康或安排巡田/);
});
