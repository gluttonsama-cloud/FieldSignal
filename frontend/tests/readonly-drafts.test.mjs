import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { saveDraft, listDrafts, clearDraft } from '../src/drafts.ts';
import { verificationResult, harness, deferred, turn } from './helpers/ui-harness.mjs';

globalThis.window = { indexedDB: globalThis.indexedDB };
beforeEach(async () => {
  for (const draft of await listDrafts()) await clearDraft(draft);
});

const draft = (visit = 'v1') => ({
  visit_id: visit, parcel_id: visit === 'v1' ? 'p1' : 'p2', parcel_name: `Saved parcel ${visit}`,
  data_origin: 'user', client_submission_id: `submission-${visit}`,
  observed_at: '2026-10-17T12:34:56.000Z', label: 'uncertain', note: `Saved observation ${visit}`,
  photos: [{ key: `photo-${visit}`, name: `${visit}.png`, uploaded_id: `uploaded-${visit}`,
    blob: new Blob([`Saved photo bytes ${visit}`], { type: 'image/png' }) }],
  pending_delete_photo_ids: ['previously-removed'], state: 'error', error: 'Previous offline upload',
  updated_at: '2026-10-17T12:35:00.000Z',
});

async function storedUI(t, { count = 1, writeFailure = new DOMException('Storage is read-only', 'ReadOnlyError') } = {}) {
  for (let i = 1; i <= count; i++) await saveDraft(draft(`v${i}`));
  const originals = await listDrafts();
  const ui = harness(), writes = [], uploads = [], createdUrls = [], revokedUrls = [];
  const storage = { writeFailure, readFailure: undefined };
  const transaction = IDBDatabase.prototype.transaction;
  // Use the real repository's read/write/CAS functions, failing only the
  // IndexedDB transaction boundary. Reads still return persisted Blob bytes.
  t.mock.method(IDBDatabase.prototype, 'transaction', function (...args) {
    if (args[1] === 'readwrite') {
      writes.push(args[0]);
      if (storage.writeFailure) throw storage.writeFailure;
    } else if (storage.readFailure) throw storage.readFailure;
    return transaction.apply(this, args);
  });
  ui.context.listDrafts = listDrafts;
  ui.context.saveDraft = saveDraft;
  ui.context.uploadVerificationDraft = async value => {
    uploads.push(structuredClone(value));
    await clearDraft(value);
    return verificationResult(value);
  };
  // Photo DOM nodes are enough to exercise the production renderer and its
  // object URL cleanup; this is not browser/visual QA.
  const photoNodes = Object.fromEntries(['#draft-photos', '#photo-count', '#no-photo'].map(id =>
    [id, { innerHTML: '', textContent: '' }]));
  const query = ui.modal.querySelector.bind(ui.modal);
  ui.modal.querySelector = selector => photoNodes[selector] || query(selector);
  ui.context.URL = {
    createObjectURL(blob) { const url = `blob:readonly-test-${createdUrls.length}`; createdUrls.push({ blob, url }); return url; },
    revokeObjectURL(url) { revokedUrls.push(url); },
  };
  return Object.assign(ui, { originals, writes, uploads, storage, photoNodes, createdUrls, revokedUrls });
}

async function openStored(ui, visit = 'v1') {
  await ui.run(`openVerification('${visit}')`);
  assert.equal(ui.modal.open, true, 'persisted drafts must remain viewable when writes fail');
  assert.equal(ui.run('currentDraft.visit_id'), visit);
}

async function assertStoredUnchanged(ui) {
  assert.deepEqual(await listDrafts(), ui.originals);
  for (const value of await listDrafts()) {
    assert.equal(await value.photos[0].blob.text(), `Saved photo bytes ${value.visit_id}`);
  }
}

function input(ui, name, value) {
  ui.modal.listeners.input({ target: { name, value, closest: () => ui.modal.form } });
}

async function cancel(ui) {
  let prevented = false;
  ui.modal.listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await ui.run('saving').catch(() => {});
  await turn();
}

function assertUnsaved(ui) {
  assert.equal(ui.modal.open, true);
  assert.match(ui.modal.saveStatus.textContent, /尚未确认保存/);
  assert.doesNotMatch(ui.modal.saveStatus.textContent, /^已保存到本机/);
  assert.equal(ui.uploads.length, 0);
}

test('persisted note and photos render without a write or revision change in read-only storage', async t => {
  const ui = await storedUI(t);
  await openStored(ui);
  assert.match(ui.modal.innerHTML, /Saved observation v1/);
  assert.match(ui.modal.innerHTML, /Previous offline upload/);
  assert.match(ui.photoNodes['#draft-photos'].innerHTML, /v1\.png/);
  assert.equal(await ui.createdUrls[0].blob.text(), 'Saved photo bytes v1');
  assert.equal(ui.run('currentDraft.revision'), ui.originals[0].revision);
  assert.equal(ui.writes.length, 0);
  assert.equal(ui.uploads.length, 0);
  await assertStoredUnchanged(ui);
});

for (const action of ['save-close', 'close-dialog', 'escape', 'open-next']) {
  test(`unchanged stored view can ${action} without a write, upload or revision change`, async t => {
    const ui = await storedUI(t, { count: 2 });
    await openStored(ui);
    if (action === 'escape') await cancel(ui);
    else if (action === 'open-next') await openStored(ui, 'v2');
    else await ui.click(action);
    assert.equal(ui.modal.open, action === 'open-next');
    assert.equal(ui.run('currentDraft?.visit_id'), action === 'open-next' ? 'v2' : undefined);
    assert.equal(ui.writes.length, 0);
    assert.equal(ui.uploads.length, 0);
    assert.ok(ui.revokedUrls.includes(ui.createdUrls[0].url));
    await assertStoredUnchanged(ui);
  });
}

for (const [name, value] of [['note', 'Unsaved note'], ['label', 'waterlogging'], ['observed_at', '2026-10-18T16:20']]) {
  test(`${name} input in a stored view requires persistence and cannot close on failure`, async t => {
    const ui = await storedUI(t);
    await openStored(ui);
    input(ui, name, value);
    await assert.rejects(ui.run('saving'), /Storage is read-only/);
    const current = ui.run('currentDraft');
    assert.equal(current[name], name === 'observed_at' ? new Date(value).toISOString() : value);
    assertUnsaved(ui);
    const attempts = ui.writes.length;
    await ui.click('save-close');
    await cancel(ui);
    await ui.run("openVerification('v2')");
    assert.equal(ui.run('currentDraft'), current);
    assert.equal(ui.writes.length, attempts + 3, 'each explicit action must retry the dirty draft, never skip it');
    assertUnsaved(ui);
    await assertStoredUnchanged(ui);
  });
}

for (const action of ['add', 'remove']) {
  test(`photo ${action} in a stored view stays dirty and retains its state when persistence fails`, async t => {
    const ui = await storedUI(t);
    await openStored(ui);
    if (action === 'add') {
      const photo = new File(['New photo bytes'], 'new.png', { type: 'image/png' });
      await ui.modal.listeners.change({ target: { id: 'photo-input', files: [photo], value: 'new.png' } });
      assert.equal(ui.run('currentDraft.photos.length'), 2);
      assert.equal(await ui.run('currentDraft.photos[1].blob').text(), 'New photo bytes');
    } else {
      await ui.click('remove-photo', { id: 'photo-v1' });
      assert.equal(ui.run('currentDraft.photos.length'), 0);
      assert.deepEqual(Array.from(ui.run('currentDraft.pending_delete_photo_ids')), ['previously-removed', 'uploaded-v1']);
    }
    const current = ui.run('currentDraft');
    assertUnsaved(ui);
    await ui.click('save-close');
    assert.equal(ui.run('currentDraft'), current);
    assertUnsaved(ui);
    await assertStoredUnchanged(ui);
  });
}

for (const mutation of ['metadata', 'blob']) {
  test(`direct ${mutation} mutation cannot pass the unchanged-view guard`, async t => {
    const ui = await storedUI(t);
    await openStored(ui);
    const current = ui.run('currentDraft');
    if (mutation === 'metadata') current.note = 'Changed without an input event';
    else current.photos[0].blob = new Blob(['Replacement photo'], { type: 'image/png' });
    await ui.click('save-close');
    assert.equal(ui.writes.length, 1);
    assert.equal(ui.run('currentDraft'), current);
    assertUnsaved(ui);
    await assertStoredUnchanged(ui);
  });
}

test('explicit submit from an unchanged view still persists before uploading and retains state on quota failure', async t => {
  const ui = await storedUI(t, { writeFailure: new DOMException('Storage quota exceeded', 'QuotaExceededError') });
  await openStored(ui);
  const current = ui.run('currentDraft');
  await ui.submit();
  assert.equal(ui.writes.length, 1, 'submit must try a real write even if the visible draft is unchanged');
  assert.equal(ui.run('currentDraft'), current);
  assert.equal(await current.photos[0].blob.text(), 'Saved photo bytes v1');
  assert.match(ui.modal.error.textContent, /Storage quota exceeded.*尚未发送核查/);
  assertUnsaved(ui);
  await ui.click('save-close');
  assert.equal(ui.writes.length, 2, 'failed submit must invalidate the unchanged-view exemption');
  assertUnsaved(ui);
  await assertStoredUnchanged(ui);
});

test('explicit submit after storage recovers writes current and pending-upload revisions before upload', async t => {
  const ui = await storedUI(t);
  await openStored(ui);
  await ui.submit();
  assertUnsaved(ui);
  ui.storage.writeFailure = undefined;
  const savedStates = [];
  ui.context.saveDraft = async value => { await saveDraft(value); savedStates.push([value.state, value.revision]); };
  ui.context.uploadVerificationDraft = async value => {
    const persisted = (await listDrafts())[0];
    assert.equal(persisted.state, 'pending_upload');
    assert.equal(persisted.revision, value.revision);
    ui.uploads.push(structuredClone(value));
    await clearDraft(value);
    return verificationResult(value);
  };
  await ui.submit();
  assert.deepEqual(savedStates, [['draft', ui.originals[0].revision + 1], ['pending_upload', ui.originals[0].revision + 2]]);
  assert.equal(ui.uploads.length, 1);
  assert.equal(await ui.uploads[0].photos[0].blob.text(), 'Saved photo bytes v1');
  assert.equal(ui.modal.open, false);
  assert.deepEqual(await listDrafts(), []);
});

test('pending-upload persistence failure from a stored view prevents all upload and keeps photos', async t => {
  const ui = await storedUI(t);
  ui.storage.writeFailure = undefined;
  await openStored(ui);
  ui.context.saveDraft = async value => {
    if (value.state === 'pending_upload') throw new DOMException('Pending state quota exceeded', 'QuotaExceededError');
    return saveDraft(value);
  };
  await ui.submit();
  assertUnsaved(ui);
  assert.match(ui.modal.error.textContent, /Pending state quota exceeded.*尚未发送核查/);
  assert.equal(await ui.run('currentDraft.photos[0].blob').text(), 'Saved photo bytes v1');
  assert.equal((await listDrafts())[0].revision, ui.originals[0].revision + 1);
  assert.equal((await listDrafts())[0].state, 'draft');
});

test('submit from a stored view honors CAS and never retries or overwrites a newer tab revision automatically', async t => {
  const ui = await storedUI(t);
  await openStored(ui);
  ui.storage.writeFailure = undefined;
  const newer = (await listDrafts())[0];
  newer.note = 'Newer other-tab observation';
  await saveDraft(newer);
  const beforeSubmit = ui.writes.length;
  await ui.submit();
  assert.equal(ui.writes.length, beforeSubmit + 1);
  assertUnsaved(ui);
  assert.match(ui.modal.saveStatus.textContent, /另一页面已更新/);
  assert.equal(ui.modal.retrySave.hidden, true);
  await turn();
  assert.equal(ui.writes.length, beforeSubmit + 1, 'a CAS conflict must not trigger an automatic retry');
  assert.deepEqual((await listDrafts())[0], newer);
  assert.equal(ui.run('currentDraft.note'), 'Saved observation v1');
});

test('a new draft still requires its first durable write and cannot open when persistence is unavailable', async t => {
  const ui = await storedUI(t, { count: 0 });
  await ui.run("openVerification('v1')");
  assert.equal(ui.modal.open, false);
  assert.equal(ui.run('currentDraft'), undefined);
  assert.equal(ui.writes.length, 1);
  assert.match(ui.toast.textContent, /Storage is read-only/);
  assert.equal(ui.uploads.length, 0);
  assert.deepEqual(await listDrafts(), []);
});

test('stored-draft read failure is reported and does not become a new or falsely saved draft', async t => {
  const ui = await storedUI(t);
  ui.storage.readFailure = new Error('Cannot read stored drafts');
  await ui.run("openVerification('v1')");
  assert.equal(ui.modal.open, false);
  assert.equal(ui.run('currentDraft'), undefined);
  assert.equal(ui.writes.length, 0);
  assert.match(ui.toast.textContent, /Cannot read stored drafts/);
  ui.storage.readFailure = undefined;
  await assertStoredUnchanged(ui);
});

test('a no-op close waits for a pending save and cannot dismiss its replacement dialog', async t => {
  const ui = await storedUI(t), pending = deferred();
  await openStored(ui);
  ui.context.pending = pending.promise;
  ui.run('saving=pending');
  const closing = ui.click('save-close');
  await turn();
  assert.equal(ui.modal.open, true);
  ui.run('parcelModal()');
  const replacement = ui.modal.form;
  pending.resolve();
  await closing;
  assert.equal(ui.modal.open, true);
  assert.equal(ui.modal.form, replacement);
  assert.equal(ui.writes.length, 0);
});

test('queued native close from an unchanged stored view preserves a newly opened stored view', async t => {
  const ui = await storedUI(t, { count: 2 });
  ui.modal.deferCloseEvents = true;
  await openStored(ui);
  await ui.click('save-close');
  await openStored(ui, 'v2');
  const current = ui.run('currentDraft');
  ui.modal.closeEvents.splice(0).forEach(dispatch => dispatch());
  assert.equal(ui.run('currentDraft'), current);
  assert.equal(ui.modal.open, true);
  await ui.click('save-close');
  assert.equal(ui.modal.open, false);
  assert.equal(ui.writes.length, 0, 'a delayed native close must not invalidate the new stored-view guard');
  await assertStoredUnchanged(ui);
});

test('network restoration never saves or uploads an unchanged stored view automatically', async t => {
  const ui = await storedUI(t);
  await openStored(ui);
  ui.window.listeners.online();
  await turn();
  assert.equal(ui.writes.length, 0);
  assert.equal(ui.uploads.length, 0);
  assert.equal(ui.modal.open, true);
  await assertStoredUnchanged(ui);
});
