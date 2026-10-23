import test from 'node:test';
import assert from 'node:assert/strict';
import { observationBatchError, validateObservationBatchReceipt } from '../src/observation-batch.ts';
import { syntheticObservationPayload } from './helpers/analysis-observation-receipts.mjs';
const bundle = () => ({ schema_version: 1, scope: 'parcel', bundle_id: 'synthetic', bundle_sha256: 'a'.repeat(64), processing_version: 'test-v1', observations: [syntheticObservationPayload()], limitations: ['Synthetic only.'] });
const receipt = body => ({ id: 'batch-synthetic', parcel_id: 'p1', bundle_id: body.bundle_id, bundle_sha256: body.bundle_sha256, processing_version: body.processing_version, created_at: '2026-10-18T05:00:00Z', created_count: 1, existing_count: 0, observations: [{ id: 'obs1', source: 'sentinel2', source_record_id: body.observations[0].source_record_id, observed_at: body.observations[0].observed_at, status: 'created' }] });

test('batch rejects rolled calendar dates, timezone-less receipts and significant extra fractional digits', () => {
  for (const time of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-10-18T24:00:00Z', '2026-10-18T00:00:00', '2026-10-18']) {
    const body = bundle(); body.observations[0].observed_at = time;
    assert.match(observationBatchError(body), /第 1 条的时间/);
    assert.throws(() => validateObservationBatchReceipt(receipt(body), 'p1', body), /尚未确认/);
    const other = bundle(), raw = receipt(other); raw.created_at = time;
    assert.throws(() => validateObservationBatchReceipt(raw, 'p1', other), /尚未确认/);
  }
  const body = bundle(), raw = receipt(body);
  raw.observations[0].observed_at = '2026-10-18T04:05:06.1234569Z';
  assert.throws(() => validateObservationBatchReceipt(raw, 'p1', body), /尚未确认/);
  body.observations[0].observed_at = raw.observations[0].observed_at;
  raw.observations[0].observed_at = '2026-10-18T04:05:06.123456Z';
  assert.equal(validateObservationBatchReceipt(raw, 'p1', body), raw);
});

test('batch uses backend Unicode White_Space, preserves literal source and rejects padded IDs', () => {
  const body = bundle(), raw = receipt(body);
  body.bundle_id = '\u0085 synthetic \u0085'; body.processing_version = '\u0085 test-v1 \u0085';
  body.observations[0].source_record_id = '\u0085 synthetic-observation \u0085';
  assert.equal(validateObservationBatchReceipt(raw, 'p1', body), raw);
  body.observations.push({ ...body.observations[0], source_record_id: 'synthetic-observation' });
  assert.match(observationBatchError(body), /第 2 条/);
  const single = bundle(); single.observations[0].source = ' sentinel2 ';
  assert.throws(() => validateObservationBatchReceipt(receipt(bundle()), 'p1', single), /尚未确认/);
  for (const value of ['', ' \u0085 ', ' padded ']) {
    const base = bundle(), saved = receipt(base); saved.id = value;
    assert.throws(() => validateObservationBatchReceipt(saved, 'p1', base), /尚未确认/);
    saved.id = 'batch'; saved.observations[0].id = value;
    assert.throws(() => validateObservationBatchReceipt(saved, 'p1', base), /尚未确认/);
  }
});
