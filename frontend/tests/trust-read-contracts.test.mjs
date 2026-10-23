import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoreRead, validateAnalysisRead } from '../src/read-contracts.ts';
import { validateFollowUpVisitReceipt, validateVerificationReceipt } from '../src/record-receipts.ts';
import { syntheticAnalysisReceipt } from './helpers/analysis-observation-receipts.mjs';

const core = () => [{}, { parcel_count: 1, open_risk_count: 1, pending_visit_count: 0, verification_count: 1,
  review_required_count: 1, parcels: [{ id: 'p1', data_origin: 'user', review_required_count: 1,
    latest_optical_observed_at: null, latest_weather_observed_at: '2026-10-18T00:00:00Z',
    optical_data_status: 'missing', weather_data_status: 'available', monitoring_status: 'blocked',
    qualification_status: 'unverified', monitoring_eligible: false }], recent_verifications: [] },
  [{ id: 'r1', parcel_id: 'p1', status: 'review_required', disposition: 'unresolved', legacy_status: 'verified', mode: 'preview', monitoring_eligible: false, evidence: {} }], [],
  [{ id: 'report1', parcel_id: 'p1', visit_id: 'v1', photo_ids: [], disposition: 'review_required', risk_id: 'r1', source_verification_id: null, label_source: 'field_report_unadjudicated' }]];

test('new read-only trust and report states remain explicit and never convert a submitted report into a resolved event', () => {
  const raw = core(), original = structuredClone(raw);
  assert.equal(validateCoreRead(raw), raw);
  assert.deepEqual(raw, original);
  assert.equal(raw[2][0].status, 'review_required');
  assert.equal(raw[2][0].disposition, 'unresolved');
  assert.equal(raw[4][0].disposition, 'review_required');
  assert.equal(raw[1].parcels[0].optical_data_status, 'missing', 'fresh weather does not fill missing optical data');
  const analyses = [syntheticAnalysisReceipt({ id: 'p1', data_origin: 'user' })];
  assert.equal(validateAnalysisRead(analyses, 'p1'), analyses);
  assert.equal(analyses[0].status, 'preview_only');
});

test('legacy reads do not synthesize dispositions, monitoring authority, preview states, or event links', () => {
  const raw = core();
  raw[1].parcels = [{ id: 'p1' }]; delete raw[1].review_required_count;
  raw[2] = [{ id: 'r1', parcel_id: 'p1', status: 'verified', evidence: {} }];
  raw[4] = [{ id: 'report1', parcel_id: 'p1', visit_id: 'v1', label: 'normal', photo_ids: [] }];
  const original = structuredClone(raw);
  assert.equal(validateCoreRead(raw), raw); assert.deepEqual(raw, original);
  assert.equal(Object.hasOwn(raw[2][0], 'disposition'), false);
  assert.equal(Object.hasOwn(raw[4][0], 'disposition'), false);
  assert.equal(Object.hasOwn(raw[1].parcels[0], 'monitoring_eligible'), false);
  const analyses = [{ id: 'old', parcel_id: 'p1', status: 'candidate' }];
  assert.equal(validateAnalysisRead(analyses, 'p1'), analyses);
  assert.equal(Object.hasOwn(analyses[0], 'mode'), false);
});

test('read guards allow future/nullable vocabulary but reject optional new fields with unsafe render types', () => {
  const mutations = [
    [raw => raw[1].review_required_count = '1', /review_required_count/],
    [raw => raw[1].parcels[0].monitoring_eligible = 'false', /monitoring_eligible/],
    [raw => raw[1].parcels[0].monitoring_status = {}, /monitoring_status/],
    [raw => raw[1].parcels[0].optical_data_status = [], /optical_data_status/],
    [raw => raw[1].parcels[0].latest_weather_observed_at = 1, /latest_weather_observed_at/],
    [raw => raw[2][0].mode = {}, /mode/], [raw => raw[2][0].monitoring_eligible = 'false', /monitoring_eligible/],
    [raw => raw[2][0].disposition = {}, /disposition/], [raw => raw[2][0].legacy_status = false, /legacy_status/],
    [raw => raw[4][0].disposition = true, /disposition/], [raw => raw[4][0].risk_id = [], /risk_id/],
    [raw => raw[4][0].source_verification_id = 1, /source_verification_id/],
  ];
  for (const [mutate, pattern] of mutations) { const raw = core(); mutate(raw); assert.throws(() => validateCoreRead(raw), pattern); }
  for (const [key, value] of [['mode', []], ['preview_status', false], ['qualification_status', 1], ['monitoring_eligible', 'false'], ['qualification_reasons', {}], ['qualification_reasons', [null]], ['preview_evidence', []]]) {
    assert.throws(() => validateAnalysisRead([{ ...syntheticAnalysisReceipt(), [key]: value }]), /读取失败.*响应结构无效/);
  }
  const legacy = core(); legacy[2][0].disposition = 'future-state'; legacy[4][0].risk_id = null; legacy[4][0].disposition = null;
  assert.equal(validateCoreRead(legacy), legacy);
  const analyses = [{ id: 'legacy', parcel_id: 'p1', mode: null, qualification_status: 'future-state', preview_status: null, preview_evidence: null, monitoring_eligible: null, qualification_reasons: null }];
  assert.equal(validateAnalysisRead(analyses, 'p1'), analyses);
});

const payload = { observed_at: '2026-10-18T00:00:00Z', label: 'normal', note: 'Synthetic field report.', photo_ids: [], client_submission_id: 'submission-synthetic' };
const original = { visit_id: 'v1', parcel_id: 'p1', data_origin: 'user' };
const report = () => ({ id: 'report1', ...original, ...payload, created_at: '2026-10-18T01:00:00Z', label_source: 'field_report_unadjudicated', disposition: 'review_required', risk_id: 'r1', source_verification_id: 'previous-report' });

test('all report labels acknowledge review-required, never verified/resolved or diagnosis, while old replay omissions remain compatible', () => {
  for (const label of ['normal', 'uncertain', 'waterlogging', 'frost', 'disease_suspected', 'other']) {
    const raw = { ...report(), label }; assert.equal(validateVerificationReceipt(raw, original, { ...payload, label }), raw);
  }
  for (const disposition of ['resolved', 'verified', 'healthy', null, true, {}]) {
    assert.throws(() => validateVerificationReceipt({ ...report(), disposition }, original, payload), /回执.*草稿已保留/);
  }
  const legacy = report(); delete legacy.disposition; delete legacy.risk_id; delete legacy.source_verification_id;
  assert.equal(validateVerificationReceipt(legacy, original, payload), legacy);
  assert.equal(Object.hasOwn(legacy, 'disposition'), false);
  for (const key of ['risk_id', 'source_verification_id']) for (const value of ['', ' padded ', {}, []]) {
    assert.throws(() => validateVerificationReceipt({ ...report(), [key]: value }, original, payload), /回执.*草稿已保留/);
  }
});

test('known report event/source identities compare exactly rather than accepting arbitrary valid-looking IDs', () => {
  const target = { ...original, risk_id: 'r1', source_verification_id: 'previous-report' };
  assert.equal(validateVerificationReceipt(report(), target, payload).risk_id, 'r1');
  for (const key of ['risk_id', 'source_verification_id']) for (const value of [null, 'another-event', undefined]) {
    assert.throws(() => validateVerificationReceipt({ ...report(), [key]: value }, target, payload), /回执.*草稿已保留/);
  }
});

test('follow-up creation retains source report and same event, with no unrequested risk and no foreign event', () => {
  const source = { id: 'report1', parcel_id: 'p1', risk_id: 'r1' }, body = { due_date: '2026-10-20', note: 'Recheck the same event' };
  const receipt = { id: 'followup', parcel_id: 'p1', risk_id: 'r1', source_verification_id: source.id, ...body, status: 'pending', plan_revision: 0, created_at: '2026-10-18T01:00:00Z' };
  assert.equal(validateFollowUpVisitReceipt(receipt, source, body), receipt);
  for (const changes of [{ risk_id: 'other-event' }, { risk_id: null }, { source_verification_id: 'other-report' }, { parcel_id: 'other-parcel' }]) {
    assert.throws(() => validateFollowUpVisitReceipt({ ...receipt, ...changes }, source, body), /回执.*尚未确认/);
  }
  assert.throws(() => validateFollowUpVisitReceipt(receipt, { id: source.id, parcel_id: 'p1' }, body), /回执.*尚未确认/);
  const independent = { ...receipt, risk_id: null };
  assert.equal(validateFollowUpVisitReceipt(independent, { ...source, risk_id: null }, body), independent);
});
