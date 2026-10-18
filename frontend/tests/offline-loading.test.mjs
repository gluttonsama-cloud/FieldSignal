import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { harness, deferred, turn } from './helpers/ui-harness.mjs';

const dashboard = () => ({ parcel_count: 0, open_risk_count: 0, pending_visit_count: 0,
  verification_count: 0, parcels: [], recent_verifications: [] });
const draft = (name = 'Saved local draft') => ({ visit_id: 'saved-visit', parcel_id: 'saved-parcel',
  parcel_name: name, data_origin: 'user', client_submission_id: 'saved-submission',
  observed_at: '2026-10-18T12:00:00Z', label: 'uncertain', note: 'Saved observation',
  photos: [{ key: 'photo-one', name: 'field.png', blob: new Blob(['field-photo'], { type: 'image/png' }) }],
  state: 'draft', updated_at: '2026-10-18T12:00:00Z', revision: 1 });

function fieldUi() {
  const ui = harness({ pathname: '/field' });
  const networks = [], locals = [], apiCalls = [], uploads = [], posts = [];
  let stored = [];
  Object.assign(ui.context, display);
  ui.context.api = async path => {
    apiCalls.push(path);
    if (path === '/dashboard') return networks.shift()?.promise ?? dashboard();
    return path === '/health' ? {} : [];
  };
  ui.context.listDrafts = async () => locals.shift()?.promise ?? structuredClone(stored);
  ui.context.saveDraft = async value => {
    value.revision = (value.revision || 0) + 1;
    stored = [...stored.filter(item => item.visit_id !== value.visit_id), structuredClone(value)];
  };
  ui.context.uploadVerificationDraft = async value => {
    uploads.push(structuredClone(value));
    stored = stored.filter(item => item.visit_id !== value.visit_id);
  };
  ui.context.post = async (...args) => { posts.push(args); return {}; };
  ui.run("refresh=realRefresh; render=()=>{document.querySelector('#app').innerHTML=renderField();}; dashboard.parcels=[]; selectedId=''; visits=[];");
  return Object.assign(ui, {
    apiCalls, uploads, posts,
    store(values) { stored = structuredClone(values); },
    begin() {
      const network = deferred(), local = deferred();
      networks.push(network); locals.push(local);
      return { network, local, done: ui.run('refresh()') };
    },
  });
}

function assertNoUpload(ui) {
  assert.equal(ui.uploads.length, 0);
  assert.equal(ui.posts.length, 0);
  assert.ok(ui.apiCalls.every(path => /^\/(health|dashboard|risks|visits|verifications)$/.test(path)));
}

test('saved drafts render and reopen with their photos before stalled service requests settle', async () => {
  const ui = fieldUi(), saved = draft();
  ui.store([saved]);
  const refresh = ui.begin();
  refresh.local.resolve([saved]);
  await turn();
  assert.match(ui.app.innerHTML, /data-action="resume-draft" data-id="saved-visit"/);
  assert.match(ui.app.innerHTML, /Saved local draft/);
  assert.match(ui.app.innerHTML, /1 张照片/);
  assert.equal(ui.run('loading'), true);
  assert.equal(ui.run('connected'), false);
  assert.equal(ui.run('lastLoaded'), '');
  assert.match(ui.app.innerHTML, /本地服务未连接/);
  await ui.click('resume-draft', { id: saved.visit_id });
  assert.equal(ui.modal.open, true);
  assert.equal(ui.run('currentDraft.note'), saved.note);
  assert.equal(await ui.run('currentDraft.photos[0].blob.text()'), 'field-photo');
  ui.window.listeners.offline();
  ui.window.listeners.online();
  assertNoUpload(ui);
  refresh.network.resolve(dashboard());
  await refresh.done;
  assert.equal(ui.modal.open, true, 'service completion must not close a resumed draft');
  assertNoUpload(ui);
});

test('service failure leaves already displayed local drafts available and marks the service disconnected', async () => {
  const ui = fieldUi(), refresh = ui.begin();
  refresh.local.resolve([draft()]);
  await turn();
  refresh.network.reject(new Error('Service is unavailable'));
  await refresh.done;
  assert.match(ui.app.innerHTML, /Saved local draft/);
  assert.match(ui.app.innerHTML, /data-action="resume-draft"/);
  assert.match(ui.app.innerHTML, /Service is unavailable/);
  assert.equal(ui.run('connected'), false);
  assert.equal(ui.run('loading'), false);
  assert.equal(ui.run('storageError'), '');
  assertNoUpload(ui);
});

test('service success becomes visible even while the independent local draft read remains pending', async () => {
  const ui = fieldUi(), refresh = ui.begin();
  refresh.network.resolve(dashboard());
  await turn();
  assert.equal(ui.run('connected'), true);
  assert.equal(ui.run('loading'), false);
  assert.match(ui.app.innerHTML, /本地服务已连接/);
  refresh.local.resolve([draft()]);
  await refresh.done;
  assert.match(ui.app.innerHTML, /Saved local draft/);
  assertNoUpload(ui);
});

test('local storage failure is visible before stalled service requests settle', async () => {
  const ui = fieldUi(), refresh = ui.begin();
  refresh.local.reject(new Error('Local storage permission denied'));
  await turn();
  assert.match(ui.app.innerHTML, /role="alert">Local storage permission denied/);
  assert.equal(ui.run('loading'), true);
  refresh.network.resolve(dashboard());
  await refresh.done;
  assert.equal(ui.run('connected'), true);
  assert.equal(ui.run('storageError'), 'Local storage permission denied');
  assert.match(ui.app.innerHTML, /Local storage permission denied/);
  assertNoUpload(ui);
});

test('older local and service successes cannot overwrite the latest refresh', async () => {
  const ui = fieldUi(), older = ui.begin(), newer = ui.begin();
  newer.local.resolve([draft('Latest local draft')]);
  await turn();
  older.local.resolve([draft('Obsolete local draft')]);
  older.network.resolve({ ...dashboard(), parcel_count: 9 });
  await older.done;
  await turn();
  assert.match(ui.app.innerHTML, /Latest local draft/);
  assert.doesNotMatch(ui.app.innerHTML, /Obsolete local draft/);
  assert.equal(ui.run('connected'), false);
  assert.equal(ui.run('loading'), true, 'older refresh must not complete the newer service request');
  newer.network.resolve(dashboard());
  await newer.done;
  assert.equal(ui.run('dashboard.parcel_count'), 0);
  assert.equal(ui.run('connected'), true);
});

test('older local and service failures cannot replace newer successful results', async () => {
  const ui = fieldUi(), older = ui.begin(), newer = ui.begin();
  newer.local.resolve([draft('Latest local draft')]);
  newer.network.resolve(dashboard());
  await newer.done;
  older.local.reject(new Error('Obsolete storage failure'));
  older.network.reject(new Error('Obsolete service failure'));
  await older.done;
  await turn();
  assert.equal(ui.run('storageError'), '');
  assert.equal(ui.run('loadError'), '');
  assert.equal(ui.run('connected'), true);
  assert.equal(ui.run('loading'), false);
  assert.match(ui.app.innerHTML, /Latest local draft/);
  assert.doesNotMatch(ui.app.innerHTML, /Obsolete/);
});

test('an older successful local read cannot clear the latest storage failure', async () => {
  const ui = fieldUi(), older = ui.begin(), newer = ui.begin();
  newer.local.reject(new Error('Current storage failure'));
  newer.network.resolve(dashboard());
  await newer.done;
  older.local.resolve([draft('Obsolete local draft')]);
  older.network.resolve(dashboard());
  await older.done;
  await turn();
  assert.equal(ui.run('storageError'), 'Current storage failure');
  assert.match(ui.app.innerHTML, /Current storage failure/);
  assert.doesNotMatch(ui.app.innerHTML, /Obsolete local draft/);
});

test('a stale refresh read cannot replace the draft list loaded after Save and Return', async () => {
  const ui = fieldUi(), original = draft();
  ui.store([original]);
  await ui.click('resume-draft', { id: original.visit_id });
  const refresh = ui.begin();
  ui.run("currentDraft.note='Updated observation after refresh began'");
  await ui.click('save-close');
  assert.equal(ui.run('drafts[0].note'), 'Updated observation after refresh began');
  refresh.local.resolve([original]);
  await turn();
  assert.equal(ui.run('drafts[0].note'), 'Updated observation after refresh began');
  refresh.network.resolve(dashboard());
  await refresh.done;
  assert.equal(ui.run('drafts[0].note'), 'Updated observation after refresh began');
  assertNoUpload(ui);
});

test('a stale refresh read cannot erase a newer failed save warning', async () => {
  const ui = fieldUi(), original = draft();
  ui.store([original]);
  await ui.click('resume-draft', { id: original.visit_id });
  const refresh = ui.begin();
  ui.context.saveDraft = async () => { throw new Error('New write failed'); };
  ui.run("currentDraft.note='Unsaved edit'");
  await assert.rejects(ui.run('queueSave()'), /New write failed/);
  refresh.local.resolve([original]);
  refresh.network.resolve(dashboard());
  await refresh.done;
  assert.equal(ui.run('storageError'), 'New write failed');
  assert.match(ui.app.innerHTML, /New write failed/);
  assert.equal(ui.run('currentDraft.note'), 'Unsaved edit');
  assert.equal(ui.modal.open, true);
  assertNoUpload(ui);
  // Even a fresh readable stored snapshot does not confirm this editor's write.
  await ui.run('refresh()');
  assert.match(ui.modal.saveStatus.textContent, /New write failed.*尚未确认保存/);
  assert.equal(ui.modal.retrySave.hidden, false);
  assert.equal(ui.run('currentDraft.note'), 'Unsaved edit');
  assertNoUpload(ui);
});

test('a refresh read started during a save cannot overwrite the list after that save commits', async () => {
  const ui = fieldUi(), original = draft(), writing = deferred();
  ui.store([original]);
  await ui.click('resume-draft', { id: original.visit_id });
  const save = ui.context.saveDraft;
  ui.context.saveDraft = async value => { await writing.promise; return save(value); };
  ui.run("currentDraft.note='Newly committed observation'");
  const closing = ui.click('save-close');
  await turn();
  const refresh = ui.begin();
  writing.resolve();
  await closing;
  refresh.local.resolve([original]);
  refresh.network.resolve(dashboard());
  await refresh.done;
  assert.equal(ui.run('drafts[0].note'), 'Newly committed observation');
  assertNoUpload(ui);
});

test('a stale refresh read cannot restore a draft after explicit submission removes it', async () => {
  const ui = fieldUi(), original = draft();
  ui.store([original]);
  await ui.click('resume-draft', { id: original.visit_id });
  const refresh = ui.begin();
  await ui.submit();
  assert.equal(ui.uploads.length, 1);
  assert.equal(ui.run('drafts.length'), 0);
  refresh.local.resolve([original]);
  refresh.network.resolve(dashboard());
  await refresh.done;
  await turn();
  assert.equal(ui.run('drafts.length'), 0);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="resume-draft"/);
  assert.equal(ui.uploads.length, 1, 'refresh must never resubmit the cleared draft');
});

for (const exit of ['Save and Return', 'Escape']) {
  test(`an older ${exit} list read cannot overwrite a newer refresh result`, async () => {
    const ui = fieldUi(), original = draft(), oldRead = deferred();
    ui.store([original]);
    await ui.click('resume-draft', { id: original.visit_id });
    const list = ui.context.listDrafts;
    let reads = 0;
    ui.context.listDrafts = () => ++reads === 1 ? oldRead.promise : list();
    let closing;
    if (exit === 'Save and Return') closing = ui.click('save-close');
    else ui.modal.listeners.cancel({ preventDefault() {} });
    await turn();
    assert.equal(reads, 1);
    ui.store([draft('Latest saved list')]);
    await ui.run('refresh()');
    assert.match(ui.app.innerHTML, /Latest saved list/);
    oldRead.resolve([original]);
    if (closing) await closing;
    await turn();
    assert.match(ui.app.innerHTML, /Latest saved list/);
    assert.doesNotMatch(ui.app.innerHTML, /Saved local draft/);
    assertNoUpload(ui);
  });
}
