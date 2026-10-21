import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { uploadVerificationDraft } from '../src/sync.ts';
import { saveDraft, listDrafts, clearDraft, DraftConflictError } from '../src/drafts.ts';
import { harness } from './helpers/ui-harness.mjs';
import { photoReceipt, verificationReceipt } from './helpers/submission-receipts.mjs';

globalThis.window = { indexedDB: globalThis.indexedDB };
const originalFetch = globalThis.fetch;
const originalTransaction = IDBDatabase.prototype.transaction;
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVZkAAAAASUVORK5CYII=', 'base64'));
const photo = (key, bytes = png, uploaded_id) => ({
  key, name: `${key}.png`, blob: new Blob([bytes], { type: 'image/png' }),
  ...(uploaded_id ? { uploaded_id } : {}),
});
const makeDraft = (photos = [photo('first'), photo('second')]) => ({
  visit_id: crypto.randomUUID(), parcel_id: 'p1', parcel_name: 'Synthetic parcel',
  parcel_season: '2026-2027', data_origin: 'fixture', client_submission_id: crypto.randomUUID(),
  observed_at: '2026-10-17T12:00:00Z', label: 'uncertain', note: 'Synthetic field observation',
  photos, pending_delete_photo_ids: [], state: 'draft', updated_at: '2026-10-18T00:00:00Z',
});
const stored = async draft => (await listDrafts()).find(item => item.visit_id === draft.visit_id);
const bytes = async photos => Promise.all(photos.map(async item => Array.from(new Uint8Array(await item.blob.arrayBuffer()))));
const duplicateGuidance = error => {
  assert.match(error.message, /第 1 张/);
  assert.match(error.message, /第 2 张/);
  assert.match(error.message, /重复|同一张/);
  assert.match(error.message, /移除|删除/);
  assert.match(error.message, /保留一张/);
  return true;
};
function photoUi(draft) {
  const ui = harness({ pathname: '/field' });
  Object.assign(ui.context, { seedDraft: draft, saveDraft, listDrafts, uploadVerificationDraft });
  ui.run("currentDraft=seedDraft;visits=[{id:seedDraft.visit_id,parcel_id:'p1',status:'pending'}];verificationModal()");
  return ui;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  IDBDatabase.prototype.transaction = originalTransaction;
  for (const draft of await listDrafts()) await clearDraft(draft);
});

for (const kind of ['same original bytes', 'different original bytes normalized to the same server ID']) {
  test(`${kind}: stop before final POST, name both positions, and durably retain both originals and IDs`, async () => {
    // The second scenario simulates the service's normalization/deduplication
    // receipt. It does not claim to exercise the backend image decoder.
    const second = kind.startsWith('different') ? new Uint8Array([...png, 1, 2, 3]) : png;
    const draft = makeDraft([photo('first'), photo('second', second)]);
    await saveDraft(draft);
    const originalBytes = await bytes(draft.photos), calls = [];
    globalThis.fetch = async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith('/photos')) return Response.json(photoReceipt(draft, 'shared-photo'));
      return Response.json({ error: { message: 'photo_ids must be unique' } }, { status: 422 });
    };
    let failure;
    try { await uploadVerificationDraft(draft); } catch (error) { failure = error; }
    const saved = await stored(draft);
    assert.deepEqual(saved.photos.map(item => item.uploaded_id), ['shared-photo', 'shared-photo']);
    assert.deepEqual(await bytes(saved.photos), originalBytes);
    assert.deepEqual(saved.photos.map(item => item.key), ['first', 'second']);
    assert.equal(saved.client_submission_id, draft.client_submission_id);
    assert.deepEqual(saved.pending_delete_photo_ids, []);
    assert.equal(calls.filter(call => call.path.endsWith('/verifications')).length, 0,
      'duplicate photo IDs must be rejected locally, not sent to the final endpoint');
    assert.equal(calls.length, 2);
    assert.ok(failure); duplicateGuidance(failure);
    calls.length = 0;
    await assert.rejects(uploadVerificationDraft(saved), duplicateGuidance);
    assert.equal(calls.length, 0, 'a restored duplicate draft must neither reupload nor submit');
    assert.deepEqual(await stored(draft), saved);
  });
}

test('the production UI removes only one duplicate locally and submits the retained shared photo without DELETE or reupload', async () => {
  const draft = makeDraft([photo('first', png, 'shared-photo'), photo('second', png, 'shared-photo')]);
  await saveDraft(draft);
  const ui = photoUi(draft), calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (path.endsWith('/photos')) return Response.json(photoReceipt(draft, 'unexpected-upload'));
    return Response.json(verificationReceipt(draft));
  };
  await ui.click('remove-photo', { id: 'second' });
  const saved = await stored(draft);
  assert.equal(saved.photos.length, 1);
  assert.equal(saved.photos[0].key, 'first');
  assert.equal(saved.photos[0].uploaded_id, 'shared-photo');
  assert.deepEqual(await bytes(saved.photos), [Array.from(png)]);
  assert.deepEqual(saved.pending_delete_photo_ids, [], 'a retained photo still owns the shared server ID');
  assert.equal(calls.length, 0);
  await ui.submit();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.endsWith('/verifications'));
  assert.deepEqual(JSON.parse(calls[0].options.body).photo_ids, ['shared-photo']);
  assert.equal(ui.modal.open, false);
  assert.equal(ui.run('visits[0].status'), 'completed');
  assert.equal(await stored(draft), undefined);
});

test('removing all duplicate entries through the production UI queues the shared ID once and deletes it once on explicit submit', async () => {
  const draft = makeDraft([photo('first', png, 'shared-photo'), photo('second', png, 'shared-photo')]);
  await saveDraft(draft);
  const ui = photoUi(draft), calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json(verificationReceipt(draft));
  };
  await ui.click('remove-photo', { id: 'first' });
  await ui.click('remove-photo', { id: 'second' });
  await ui.click('remove-photo', { id: 'second' });
  const saved = await stored(draft);
  assert.equal(saved.photos.length, 0);
  assert.deepEqual(saved.pending_delete_photo_ids, ['shared-photo']);
  assert.equal(calls.length, 0, 'local removal must not make network requests');
  await ui.submit();
  assert.deepEqual(calls.map(call => call.options.method), ['DELETE', 'POST']);
  assert.ok(calls[0].path.endsWith('/photos/shared-photo'));
  assert.deepEqual(JSON.parse(calls[1].options.body).photo_ids, []);
  assert.equal(ui.modal.open, false);
  assert.equal(await stored(draft), undefined);
});

test('a legacy poisoned queue is durably reconciled before any DELETE or new upload, while a genuine replacement delete still executes', async () => {
  const draft = makeDraft([photo('retained', png, 'shared-photo'), photo('replacement')]);
  draft.pending_delete_photo_ids = ['shared-photo', 'obsolete-photo', 'shared-photo', 'obsolete-photo'];
  await saveDraft(draft);
  const calls = [], queuesAtNetwork = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    queuesAtNetwork.push((await stored(draft)).pending_delete_photo_ids);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (path.endsWith('/photos')) return Response.json(photoReceipt(draft, 'replacement-photo'));
    return Response.json(verificationReceipt(draft));
  };
  await uploadVerificationDraft(draft);
  assert.deepEqual(calls.map(call => call.options.method), ['DELETE', 'POST', 'POST']);
  assert.ok(calls[0].path.endsWith('/photos/obsolete-photo'));
  assert.deepEqual(queuesAtNetwork, [['obsolete-photo'], [], []]);
  assert.deepEqual(JSON.parse(calls[2].options.body).photo_ids, ['shared-photo', 'replacement-photo']);
  assert.equal(await stored(draft), undefined);
});

test('failure to persist queue reconciliation blocks all network and preserves the durable original for an explicit retry', async () => {
  const draft = makeDraft([photo('retained', png, 'shared-photo')]);
  draft.pending_delete_photo_ids = ['shared-photo', 'obsolete-photo'];
  await saveDraft(draft);
  const before = await stored(draft), calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json(verificationReceipt(draft));
  };
  IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
    if (mode === 'readwrite') throw new Error('Synthetic local persistence failure');
    return originalTransaction.call(this, names, mode, ...rest);
  };
  await assert.rejects(uploadVerificationDraft(draft), /Synthetic local persistence failure/);
  assert.equal(calls.length, 0, 'reconciliation must commit before any remote action');
  assert.deepEqual(await stored(draft), before);
  assert.deepEqual(await bytes((await stored(draft)).photos), [Array.from(png)]);
  IDBDatabase.prototype.transaction = originalTransaction;
  const queuesAtRetryNetwork = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    queuesAtRetryNetwork.push((await stored(draft)).pending_delete_photo_ids);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json(verificationReceipt(draft));
  };
  // Reusing this object must not bypass the persistence fence after the failed
  // save. The durable queue is checked at the first remote action, not afterward.
  await uploadVerificationDraft(draft);
  assert.deepEqual(calls.map(call => call.options.method), ['DELETE', 'POST']);
  assert.ok(calls[0].path.endsWith('/photos/obsolete-photo'));
  assert.deepEqual(queuesAtRetryNetwork, [['obsolete-photo'], []]);
  assert.equal(await stored(draft), undefined);
});

test('a cross-tab revision conflict during queue reconciliation blocks network and cannot alter the newer draft or its originals', async () => {
  const stale = makeDraft([photo('retained', png, 'shared-photo')]);
  stale.pending_delete_photo_ids = ['shared-photo'];
  await saveDraft(stale);
  const newer = await stored(stale);
  newer.note = 'Newer note from another tab';
  newer.photos.push(photo('newer-photo'));
  await saveDraft(newer);
  const before = await stored(stale), calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json(verificationReceipt(stale));
  };
  await assert.rejects(uploadVerificationDraft(stale), error => error instanceof DraftConflictError);
  assert.equal(calls.length, 0);
  assert.deepEqual(await stored(stale), before);
  assert.deepEqual(await bytes((await stored(stale)).photos), await bytes(before.photos));
});

test('legacy duplicate entries and their poisoned delete queue recover without deleting either entry or contacting the service', async () => {
  const draft = makeDraft([photo('first', png, 'shared-photo'), photo('second', png, 'shared-photo')]);
  draft.pending_delete_photo_ids = ['shared-photo', 'shared-photo'];
  await saveDraft(draft);
  let network = 0;
  globalThis.fetch = async (path, options) => {
    network++;
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ error: { message: 'photo_ids must be unique' } }, { status: 422 });
  };
  await assert.rejects(uploadVerificationDraft(draft), duplicateGuidance);
  assert.equal(network, 0);
  const saved = await stored(draft);
  assert.deepEqual(saved.pending_delete_photo_ids, []);
  assert.deepEqual(saved.photos.map(item => item.uploaded_id), ['shared-photo', 'shared-photo']);
  assert.deepEqual(await bytes(saved.photos), [Array.from(png), Array.from(png)]);
});
