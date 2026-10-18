import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { saveDraft, listDrafts, clearDraft, DraftConflictError } from '../src/drafts.ts';
import { harness, deferred, turn } from './helpers/ui-harness.mjs';

globalThis.window = { indexedDB: globalThis.indexedDB };
beforeEach(async () => {
  for (const draft of await listDrafts()) await clearDraft(draft);
});

async function verification() {
  const ui = harness();
  const writes = [], uploads = [];
  let failure;
  ui.context.listDrafts = listDrafts;
  ui.context.saveDraft = async draft => {
    writes.push(structuredClone(draft));
    if (failure) throw failure;
    await saveDraft(draft);
  };
  ui.context.uploadVerificationDraft = async draft => {
    uploads.push(structuredClone(draft));
    await clearDraft(draft);
  };
  await ui.run("openVerification('v1')");
  ui.context.photo = { key: 'photo-one', name: 'field.png', uploaded_id: 'uploaded-photo',
    blob: new Blob(['original-photo'], { type: 'image/png' }) };
  ui.run("currentDraft.note='Latest field observation'; currentDraft.photos=[photo]; currentDraft.pending_delete_photo_ids=['removed-photo']");
  return Object.assign(ui, {
    writes, uploads,
    fail(error = new Error('Temporary storage failure')) { failure = error; },
    recover() { failure = undefined; },
  });
}

async function failedAutosave(ui) {
  const savedNote = (await listDrafts())[0].note;
  ui.fail();
  await assert.rejects(ui.run('queueSave()'), /Temporary storage failure/);
  assert.equal(ui.modal.open, true);
  assert.equal((await listDrafts())[0].note, savedNote);
}

function assertSnapshot(actual, original) {
  assert.equal(actual.note, 'Latest field observation');
  assert.equal(actual.client_submission_id, original.client_submission_id);
  assert.equal(actual.photos[0].uploaded_id, 'uploaded-photo');
  assert.deepEqual(actual.pending_delete_photo_ids, ['removed-photo']);
}

test('submit retries a failed autosave without requiring another edit', async () => {
  const ui = await verification(), original = structuredClone(ui.run('currentDraft'));
  await failedAutosave(ui);
  ui.recover();
  await ui.submit();
  assert.equal(ui.uploads.length, 1);
  assertSnapshot(ui.uploads[0], original);
  assert.equal(await ui.uploads[0].photos[0].blob.text(), 'original-photo');
  assert.equal(ui.modal.open, false);
  assert.equal((await listDrafts()).length, 0);
  assert.equal(ui.run('storageError'), '');
});

test('Save and Return retries local persistence before closing without uploading', async () => {
  const ui = await verification(), original = structuredClone(ui.run('currentDraft'));
  await failedAutosave(ui);
  ui.recover();
  await ui.click('save-close');
  assert.equal(ui.modal.open, false);
  assertSnapshot((await listDrafts())[0], original);
  assert.equal(ui.uploads.length, 0);
  assert.equal(ui.run('storageError'), '');
});

test('Escape retries local persistence before closing without uploading', async () => {
  const ui = await verification(), original = structuredClone(ui.run('currentDraft'));
  await failedAutosave(ui);
  ui.recover();
  let prevented = false;
  ui.modal.listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await ui.run('saving');
  await turn();
  assert.equal(ui.modal.open, false);
  assertSnapshot((await listDrafts())[0], original);
  assert.equal(ui.uploads.length, 0);
});

test('opening another verification retries and preserves the previous unsaved draft', async () => {
  const ui = await verification(), original = structuredClone(ui.run('currentDraft'));
  await failedAutosave(ui);
  ui.recover();
  await ui.run("openVerification('v2')");
  assert.equal(ui.run('currentDraft.visit_id'), 'v2');
  assertSnapshot((await listDrafts()).find(d => d.visit_id === 'v1'), original);
  assert.equal(ui.uploads.length, 0);
});

test('persistent save failure keeps the dialog, edits and photos without uploading', async () => {
  const ui = await verification(), original = ui.run('currentDraft');
  await failedAutosave(ui);
  const attempts = ui.writes.length;
  await ui.submit();
  assert.ok(ui.writes.length > attempts, 'submit must make a fresh persistence attempt');
  await ui.click('save-close');
  await ui.run("openVerification('v2')");
  assert.equal(ui.modal.open, true);
  assert.equal(ui.run('currentDraft'), original);
  assert.equal(original.note, 'Latest field observation');
  assert.equal(await original.photos[0].blob.text(), 'original-photo');
  assert.equal(ui.uploads.length, 0);
  assert.equal((await listDrafts()).length, 1);
  assert.equal((await listDrafts())[0].note, '');
});

test('recovery preserves IndexedDB revision conflicts and never uploads a stale draft', async () => {
  const ui = await verification();
  await failedAutosave(ui);
  const otherTab = (await listDrafts())[0];
  otherTab.note = 'Newer content from another tab';
  await saveDraft(otherTab);
  ui.recover();
  await ui.submit();
  assert.equal(ui.modal.open, true);
  assert.equal(ui.uploads.length, 0);
  const stored = (await listDrafts())[0];
  assert.equal(stored.note, otherTab.note);
  assert.equal(stored.revision, otherTab.revision);
  assert.equal(ui.run('currentDraft.note'), 'Latest field observation');
  await assert.rejects(ui.run('queueSave()'), error => error instanceof DraftConflictError);
});

test('Save and Return waits for edits queued during the pending persistence attempt', async () => {
  const ui = await verification(), first = deferred(), second = deferred();
  const save = ui.context.saveDraft;
  let count = 0;
  ui.context.saveDraft = async draft => {
    const barrier = ++count === 1 ? first : second;
    await barrier.promise;
    return save(draft);
  };
  const closing = ui.click('save-close');
  await turn();
  ui.run("currentDraft.note='Additional edit while saving'");
  const latest = ui.run('queueSave()');
  first.resolve();
  await turn();
  assert.equal(ui.modal.open, true, 'the newer queued write has not committed yet');
  second.resolve();
  await latest;
  await closing;
  assert.equal(ui.modal.open, false);
  assert.equal((await listDrafts())[0].note, 'Additional edit while saving');
  assert.equal(ui.uploads.length, 0);
});

test('an older save completion cannot report saved while a newer write remains pending', async () => {
  const ui = await verification(), first = deferred(), second = deferred();
  const save = ui.context.saveDraft;
  let count = 0;
  ui.context.saveDraft = async draft => {
    await (++count === 1 ? first : second).promise;
    return save(draft);
  };
  const older = ui.run('queueSave()');
  ui.run("currentDraft.note='Additional unsaved edit'");
  const newer = ui.run('queueSave()');
  first.resolve();
  await older;
  assert.doesNotMatch(ui.modal.saveStatus.textContent, /已保存到本机/);
  second.resolve();
  await newer;
  assert.match(ui.modal.saveStatus.textContent, /已保存到本机/);
  assert.equal((await listDrafts())[0].note, 'Additional unsaved edit');
});

test('the visible local retry saves without uploading and only clears its warning after commit', async () => {
  const ui = await verification(), pending = deferred();
  assert.equal(ui.modal.retrySave.hidden, true);
  await failedAutosave(ui);
  assert.equal(ui.modal.retrySave.hidden, false);
  assert.match(ui.modal.saveStatus.textContent, /尚未确认保存/);
  ui.recover();
  const save = ui.context.saveDraft;
  ui.context.saveDraft = async draft => { await pending.promise; return save(draft); };
  const attempts = ui.writes.length;
  const retrying = ui.click('retry-draft-save');
  await ui.click('retry-draft-save');
  await turn();
  assert.equal(ui.modal.retrySave.disabled, true);
  assert.equal(ui.modal.open, true);
  assert.equal(ui.uploads.length, 0);
  assert.notEqual(ui.run('storageError'), '');
  pending.resolve();
  await retrying;
  assert.equal(ui.writes.length, attempts + 1, 'a repeated local retry is ignored while saving');
  assert.equal(ui.modal.retrySave.hidden, true);
  assert.equal(ui.run('storageError'), '');
  assert.match(ui.modal.saveStatus.textContent, /已保存到本机/);
  assert.equal(ui.modal.open, true);
  assert.equal(ui.uploads.length, 0);
  assert.equal((await listDrafts())[0].note, 'Latest field observation');
});

test('a CAS conflict offers the existing preservation guidance instead of a local retry button', async () => {
  const ui = await verification();
  const otherTab = (await listDrafts())[0];
  otherTab.note = 'Newer draft';
  await saveDraft(otherTab);
  await assert.rejects(ui.run('queueSave()'), error => error instanceof DraftConflictError);
  assert.equal(ui.modal.retrySave.hidden, true);
  assert.match(ui.modal.saveStatus.textContent, /另一页面已更新/);
  assert.equal((await listDrafts())[0].note, otherTab.note);
  assert.equal(ui.uploads.length, 0);
});

test('network restoration does not retry local saving or upload without a user action', async () => {
  const ui = await verification();
  await failedAutosave(ui);
  ui.recover();
  const attempts = ui.writes.length;
  ui.window.listeners.online();
  await turn();
  assert.equal(ui.writes.length, attempts);
  assert.equal(ui.uploads.length, 0);
  assert.equal(ui.modal.open, true);
  assert.equal((await listDrafts())[0].note, '');
});

test('repeated submit clicks during the recovery write start only one upload', async () => {
  const ui = await verification(), pending = deferred();
  await failedAutosave(ui);
  ui.recover();
  const save = ui.context.saveDraft;
  ui.context.saveDraft = async draft => { await pending.promise; return save(draft); };
  const first = ui.submit();
  const second = ui.submit();
  assert.equal(ui.modal.fields.disabled, true);
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(ui.uploads.length, 1);
  assert.equal(ui.modal.fields.disabled, false);
});

test('failure to persist pending-upload state prevents upload and permits a later explicit retry', async () => {
  const ui = await verification();
  const save = ui.context.saveDraft;
  let failPending = true;
  ui.context.saveDraft = async draft => {
    if (draft.state === 'pending_upload' && failPending) throw new Error('Pending state storage failure');
    return save(draft);
  };
  await ui.submit();
  assert.equal(ui.uploads.length, 0);
  assert.equal(ui.modal.open, true);
  assert.match(ui.modal.error.textContent, /Pending state storage failure/);
  assert.match(ui.modal.error.textContent, /尚未发送核查/);
  assert.match(ui.modal.saveStatus.textContent, /尚未确认保存/);
  assert.equal(ui.modal.retrySave.hidden, false);
  failPending = false;
  await ui.submit();
  assert.equal(ui.uploads.length, 1);
  assert.equal(ui.modal.open, false);
});

test('local retry after an upload failure never repeats the network operation', async () => {
  const ui = await verification();
  let uploads = 0;
  ui.context.uploadVerificationDraft = async () => { uploads++; throw new Error('Offline upload'); };
  await ui.submit();
  assert.equal(uploads, 1);
  await failedAutosave(ui);
  ui.recover();
  await ui.click('retry-draft-save');
  assert.equal(uploads, 1);
  assert.equal(ui.modal.open, true);
  assert.equal((await listDrafts())[0].photos[0].uploaded_id, 'uploaded-photo');
});
