import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api.ts';
import { validatePhotoReceipt, validateVerificationReceipt } from '../src/record-receipts.ts';

const original = { visit_id: 'visit-synthetic', parcel_id: 'parcel-synthetic', data_origin: 'user' };
const payload = {
  client_submission_id: 'submission-synthetic',
  observed_at: '2026-10-18T12:05:06.123456+08:00',
  label: 'uncertain',
  note: 'Synthetic field report, not a diagnosis.',
  photo_ids: ['photo-synthetic-a', 'photo-synthetic-b'],
};
const verification = {
  id: 'verification-synthetic', ...original, ...payload,
  observed_at: '2026-10-18T04:05:06.123456Z',
  label_source: 'field_report_unadjudicated',
  created_at: '2026-10-18T04:06:00.654321+00:00',
};
const photo = {
  id: payload.photo_ids[0], visit_id: original.visit_id,
  created_at: verification.created_at, content_type: 'image/jpeg',
  size_bytes: 825, metadata_stripped: true, state: 'staged', data_origin: 'user',
};
const verify = (raw, expected = payload, context = original) => validateVerificationReceipt(raw, context, expected);
const upload = (raw, visitId = original.visit_id, origin = original.data_origin) => validatePhotoReceipt(raw, visitId, origin);
function rejected(action) {
  assert.throws(action, error => error instanceof Error && !(error instanceof ApiError) &&
    /回执.*尚未确认.*草稿已保留.*相同内容.*手动重试/.test(error.message));
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('actual verification and staged or confirmed photo receipts pass without mutating snapshots', () => {
  const context = freeze(structuredClone(original)), expected = freeze(structuredClone(payload));
  const result = freeze(structuredClone(verification)), uploaded = freeze(structuredClone(photo));
  const before = JSON.stringify([context, expected, result, uploaded]);
  assert.equal(verify(result, expected, context), result);
  assert.equal(upload(uploaded), uploaded);
  assert.equal(upload({ ...photo, state: 'confirmed' }).state, 'confirmed', 'deduplicated replay may already be confirmed');
  assert.equal(JSON.stringify([context, expected, result, uploaded]), before);
  for (const label of ['normal', 'waterlogging', 'frost', 'disease_suspected', 'other', 'uncertain']) {
    assert.equal(verify({ ...verification, label }, { ...payload, label }).label, label);
  }
  assert.deepEqual(verify({ ...verification, photo_ids: [] }, { ...payload, photo_ids: [] }).photo_ids, []);
});

test('both receipt validators reject malformed roots, IDs and timestamps as uncertain, not API errors', () => {
  for (const [receipt, validate] of [[verification, verify], [photo, upload]]) {
    for (const raw of [undefined, null, false, true, 1, '', 'ok', [], [receipt], {}]) rejected(() => validate(raw));
    for (const id of [undefined, null, false, 7, [], {}, '', ' \t\n\u0085 ', ' padded ']) rejected(() => validate({ ...receipt, id }));
    for (const created_at of [
      undefined, null, 42, '', '2026-10-18', '2026-10-18T04:06:00',
      '2026-02-30T04:06:00Z', '2025-02-29T04:06:00Z', '0000-01-01T00:00:00Z',
      '2026-10-18T24:00:00Z', '2026-10-18T00:60:00Z', '2026-10-18T00:00:60Z',
      '2026-10-18T04:06:00+24:00', '2026-10-18T04:06:00+08:60',
    ]) rejected(() => validate({ ...receipt, created_at }));
    for (const created_at of ['2024-02-29T12:00:00.123456Z', '2026-10-18 12:06:00+08:00']) {
      assert.equal(validate({ ...receipt, created_at }).created_at, created_at);
    }
  }
});

test('verification binds the visit, parcel, submission ID and every submitted content field', () => {
  for (const field of ['visit_id', 'parcel_id', 'client_submission_id', 'observed_at', 'label', 'note', 'photo_ids']) {
    const missing = { ...verification }; delete missing[field]; rejected(() => verify(missing));
  }
  for (const changes of [
    { visit_id: 'other-visit' }, { parcel_id: 'other-parcel' }, { visit_id: null }, { parcel_id: {} },
    { client_submission_id: 'other-submission' }, { client_submission_id: null }, { client_submission_id: {} },
    { label: 'normal' }, { label: null }, { label: {} }, { note: 'Changed report' }, { note: null }, { note: 42 },
  ]) rejected(() => verify({ ...verification, ...changes }));
  for (const field of ['visit_id', 'parcel_id']) {
    for (const invalid of ['', ' \u0085 ', ' padded ', null, 1]) {
      rejected(() => verify({ ...verification, [field]: invalid }, payload, { ...original, [field]: invalid }));
    }
  }
  for (const label of ['confirmed_disease', ' uncertain ', 'UNCERTAIN', '', null, {}]) {
    rejected(() => verify({ ...verification, label }, { ...payload, label }));
  }
  for (const client_submission_id of ['', 'short', 'x'.repeat(101), ' \u0085 ', null, [], 1]) {
    rejected(() => verify({ ...verification, client_submission_id }, { ...payload, client_submission_id }));
  }
  for (const note of ['', ' \u0085 ', 'x'.repeat(2001), null, [], 1]) {
    rejected(() => verify({ ...verification, note }, { ...payload, note }));
  }
});

test('submission IDs, notes and photo IDs use Pydantic Unicode White_Space normalization', () => {
  // Verified against backend VerificationCreate (Pydantic), not JS trim.
  const stripped = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
    ...Array.from({ length: 11 }, (_, index) => 0x2000 + index), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
  for (const code of stripped) {
    const edge = String.fromCodePoint(code), wrap = value => `${edge}${value}${edge}`;
    const expected = {
      ...payload, client_submission_id: wrap(payload.client_submission_id),
      note: wrap(payload.note), photo_ids: payload.photo_ids.map(wrap),
    };
    assert.equal(verify(verification, expected), verification);
    rejected(() => verify({ ...verification, note: edge }, { ...payload, note: edge }));
    rejected(() => verify({ ...verification, note: wrap(payload.note) }, expected));
  }
  for (const code of [0, 1, 8, 0x0e, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f, 0x180e, 0x200b, 0x2060, 0xfeff]) {
    const edge = String.fromCodePoint(code);
    const meaningful = {
      ...payload, client_submission_id: `${edge}submission${edge}`,
      note: `${edge}note${edge}`, photo_ids: [`${edge}photo${edge}`],
    };
    assert.equal(verify({ ...verification, ...meaningful }, meaningful).note, meaningful.note);
    rejected(() => verify({ ...verification, ...meaningful, note: 'note' }, meaningful));
    rejected(() => verify({ ...verification, ...meaningful, client_submission_id: 'submission' }, meaningful));
    rejected(() => verify({ ...verification, ...meaningful, photo_ids: ['photo'] }, meaningful));
  }
});

test('normalization preserves inner whitespace, does not strip enum or timestamp, and counts Unicode code points', () => {
  for (const edge of [' ', '\n', '\u0085', '\u00a0', '\u2003', '\ufeff', '\u001c']) {
    const note = `first${edge}second`, client_submission_id = `submit${edge}marker`;
    assert.equal(verify({ ...verification, note, client_submission_id }, { ...payload, note, client_submission_id }).note, note);
    rejected(() => verify({ ...verification, note: 'firstsecond' }, { ...payload, note }));
    rejected(() => verify(verification, { ...payload, label: `${edge}uncertain${edge}` }));
    rejected(() => verify(verification, { ...payload, observed_at: `${edge}${payload.observed_at}${edge}` }));
  }
  const unicode = { ...payload, note: '🌾'.repeat(2000), client_submission_id: '🌱'.repeat(100), photo_ids: ['📷'.repeat(200)] };
  assert.equal(verify({ ...verification, ...unicode }, unicode).note, unicode.note);
  for (const client_submission_id of ['🌱'.repeat(7), '🌱'.repeat(101)]) {
    rejected(() => verify({ ...verification, client_submission_id }, { ...payload, client_submission_id }));
  }
  const minimum = { ...payload, client_submission_id: '🌱'.repeat(8) };
  assert.equal(verify({ ...verification, ...minimum }, minimum).client_submission_id, minimum.client_submission_id);
});

test('observed time compares timezone instants without losing any microseconds', () => {
  for (const observed_at of [
    '2026-10-18T04:05:06.123456Z', '2026-10-18t04:05:06.123456z',
    '2026-10-18 12:05:06.123456+08:00', '2026-10-18T12:05:06.123456+0800',
    '2026-10-17T23:05:06.123456-05:00', '2026-10-18T04:05:06,123456Z',
    '2026-10-18T04:05:06.123456000Z',
  ]) assert.equal(verify({ ...verification, observed_at }).observed_at, observed_at);
  for (const observed_at of [
    undefined, null, 42, '', '2026-10-18', '2026-10-18T04:05:06.123456',
    '2026-10-18T04:05:06.123455Z', '2026-10-18T04:05:06.123457Z',
    '2026-10-18T04:05:06.123Z', '2026-10-18T04:05:06.1234561Z',
    '2026-10-18T12:05:06.123456Z', '2026-02-30T04:05:06.123456Z',
  ]) rejected(() => verify({ ...verification, observed_at }));
  for (const observed_at of [undefined, null, '', '2026-10-18T04:05:06.123456', '2026-02-30T04:05:06.123456Z']) {
    rejected(() => verify({ ...verification, observed_at }, { ...payload, observed_at }));
  }
  assert.equal(verify(verification, { ...payload, observed_at: '2026-10-18T04:05:06.123456999Z' }), verification,
    'Pydantic truncates submitted sub-microsecond digits before persisting');
  const whole = { ...verification, observed_at: '2026-10-18T04:05:06Z' };
  assert.equal(verify(whole, { ...payload, observed_at: '2026-10-18T04:05:06.0000009Z' }), whole);
  const boundary = { ...verification, observed_at: '2024-02-29T23:59:59.999999Z' };
  assert.equal(verify(boundary, { ...payload, observed_at: '2024-03-01T07:59:59.999999+08:00' }), boundary);
});

test('photo references must be ordered, unique, bounded and identical to the normalized submitted references', () => {
  for (const photo_ids of [
    undefined, null, {}, '', payload.photo_ids[0], [payload.photo_ids[0]],
    [...payload.photo_ids].reverse(), [...payload.photo_ids, 'extra-photo'], ['other-photo', payload.photo_ids[1]],
    [payload.photo_ids[0], payload.photo_ids[0]], [null, payload.photo_ids[1]], [42, payload.photo_ids[1]],
  ]) rejected(() => verify({ ...verification, photo_ids }));
  for (const photo_ids of [
    [''], [' \u0085 '], ['x'.repeat(201)], [false], [{}], [null], [1], new Array(1),
    ['duplicate', 'duplicate'], ['duplicate', ' duplicate '],
    Array.from({ length: 9 }, (_, index) => `photo-${index}`),
  ]) rejected(() => verify({ ...verification, photo_ids }, { ...payload, photo_ids }));
  const maximum = Array.from({ length: 8 }, (_, index) => `photo-${index}`);
  assert.deepEqual(verify({ ...verification, photo_ids: maximum }, { ...payload, photo_ids: maximum }).photo_ids, maximum);
  rejected(() => verify({ ...verification, photo_ids: ['duplicate', 'duplicate'] },
    { ...payload, photo_ids: ['duplicate', '\u0085duplicate\u0085'] }));
});

test('verification permits missing legacy metadata but rejects present wrong provenance or label authority', () => {
  const legacy = { ...verification }; delete legacy.data_origin; delete legacy.label_source;
  assert.equal(verify(legacy), legacy);
  assert.equal(verify({ ...verification, data_origin: 'fixture' }, payload, { ...original, data_origin: 'fixture' }).data_origin, 'fixture');
  const unknownOrigin = { visit_id: original.visit_id, parcel_id: original.parcel_id };
  assert.equal(verify({ ...verification, data_origin: 'fixture' }, payload, unknownOrigin).data_origin, 'fixture');
  assert.equal(verify(legacy, payload, unknownOrigin), legacy);
  for (const data_origin of [undefined, null, '', 'unknown', {}, false, 'fixture']) {
    rejected(() => verify({ ...verification, data_origin }));
  }
  for (const label_source of [undefined, null, '', 'confirmed_diagnosis', 'model', {}, false]) {
    rejected(() => verify({ ...verification, label_source }));
  }
  for (const data_origin of [null, 'unknown', false]) rejected(() => verify(legacy, payload, { ...original, data_origin }));
});

test('photo metadata must bind the same visit, canonical JPEG processing and known origin', () => {
  for (const field of ['visit_id', 'content_type', 'size_bytes', 'metadata_stripped', 'state', 'data_origin']) {
    const missing = { ...photo }; delete missing[field]; rejected(() => upload(missing));
  }
  for (const changes of [
    ...['other-visit', '', ' visit-synthetic ', null, 1, {}].map(visit_id => ({ visit_id })),
    ...['image/png', 'image/webp', 'IMAGE/JPEG', '', null, {}].map(content_type => ({ content_type })),
    ...[0, -1, 0.1, '825', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(size_bytes => ({ size_bytes })),
    ...[false, 'true', 1, null].map(metadata_stripped => ({ metadata_stripped })),
    ...['pending', 'deleted', '', null, {}].map(state => ({ state })),
    ...['fixture', 'unknown', '', null, {}].map(data_origin => ({ data_origin })),
  ]) rejected(() => upload({ ...photo, ...changes }));
  for (const visitId of ['', ' padded ', '\u0085', null, 42]) rejected(() => upload({ ...photo, visit_id: visitId }, visitId));
  assert.equal(validatePhotoReceipt(photo, original.visit_id), photo);
  assert.equal(upload({ ...photo, data_origin: 'fixture' }, original.visit_id, 'fixture').data_origin, 'fixture');
  assert.equal(validatePhotoReceipt({ ...photo, data_origin: 'fixture' }, original.visit_id).data_origin, 'fixture');
  rejected(() => validatePhotoReceipt(photo, original.visit_id, 'unknown'));
});

test('a rejected receipt does not mutate the receipt, original snapshot or payload', () => {
  const expected = freeze(structuredClone(payload)), context = freeze(structuredClone(original));
  const mismatch = freeze({ ...structuredClone(verification), parcel_id: 'wrong-parcel' });
  const uploaded = freeze({ ...photo, visit_id: 'wrong-visit' });
  const before = JSON.stringify([mismatch, uploaded, expected, context]);
  rejected(() => verify(mismatch, expected, context));
  rejected(() => upload(uploaded));
  assert.equal(JSON.stringify([mismatch, uploaded, expected, context]), before);
});
