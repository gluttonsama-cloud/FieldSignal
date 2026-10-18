import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred, turn } from './helpers/ui-harness.mjs';

function eventForm(ui) {
  ui.run('eventModal()');
  Object.assign(ui.modal.form.values, { occurred_on: '2026-10-18', kind: 'drainage', note: 'Original event' });
  return ui.modal.form;
}

test('late success from a dismissed form does not close its replacement', async () => {
  const ui = harness(), pending = deferred();
  ui.context.post = () => pending.promise;
  const done = ui.submit(eventForm(ui));
  await ui.click('close-dialog');
  ui.run('parcelModal()');
  const replacement = ui.modal.form;
  replacement.values.name = 'Unsaved replacement parcel';
  pending.resolve({ id: 'event-a' });
  await done;
  assert.equal(ui.modal.open, true, 'the newer dialog must remain open');
  assert.equal(ui.modal.form, replacement);
  assert.equal(replacement.values.name, 'Unsaved replacement parcel');
});

test('late failure from a dismissed form is not rendered inside its replacement', async () => {
  const ui = harness(), pending = deferred();
  ui.context.post = () => pending.promise;
  const done = ui.submit(eventForm(ui));
  await ui.click('close-dialog');
  ui.run('parcelModal()');
  pending.reject(new Error('Original event request failed'));
  await done;
  assert.equal(ui.modal.open, true);
  assert.equal(ui.modal.error.hidden, true, 'an older request must not mark the newer form invalid');
  assert.match(ui.toast.textContent, /Original event request failed/);
});

test('a form retains the parcel it displayed when it was opened', async () => {
  const ui = harness(), paths = [];
  const form = eventForm(ui);
  ui.run("selectedId='p2'");
  ui.context.post = async path => { paths.push(path); return { id: 'event-a' }; };
  await ui.submit(form);
  assert.deepEqual(paths, ['/parcels/p1/events']);
});

test('save-close awaiting persistence cannot close a newer dialog', async () => {
  const ui = harness(), pending = deferred();
  eventForm(ui);
  ui.context.pendingSave = pending.promise;
  ui.run('saving=pendingSave');
  const closing = ui.click('save-close');
  ui.run('parcelModal()');
  const replacement = ui.modal.form;
  pending.resolve();
  await closing;
  assert.equal(ui.modal.open, true);
  assert.equal(ui.modal.form, replacement);
});

test('Escape awaiting persistence cannot close a newer dialog', async () => {
  const ui = harness(), pending = deferred();
  ui.run('parcelModal(); currentDraft={visit_id:"v1",photos:[]}');
  ui.context.pendingSave = pending.promise;
  ui.run('saving=pendingSave');
  let prevented = false;
  ui.modal.listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  ui.run('eventModal()');
  const replacement = ui.modal.form;
  pending.resolve();
  await turn();
  assert.equal(ui.modal.open, true);
  assert.equal(ui.modal.form, replacement);
});

test('a pending verification open cannot replace a newer dialog', async () => {
  const ui = harness(), pending = deferred();
  ui.context.listDrafts = () => pending.promise;
  const opening = ui.run("openVerification('v1')");
  await turn();
  ui.run('parcelModal()');
  const replacement = ui.modal.form;
  pending.resolve([]);
  await opening;
  assert.equal(ui.modal.open, true);
  assert.equal(ui.modal.form, replacement);
  assert.equal(ui.run('currentDraft'), undefined);
});

test('the most recent verification open wins when draft reads finish out of order', async () => {
  const ui = harness(), first = deferred(), second = deferred();
  let reads = 0;
  ui.context.listDrafts = () => (++reads === 1 ? first.promise : second.promise);
  const openingFirst = ui.run("openVerification('v1')");
  await turn();
  const openingSecond = ui.run("openVerification('v2')");
  await turn();
  second.resolve([]);
  await openingSecond;
  assert.equal(ui.run('currentDraft.visit_id'), 'v2');
  first.resolve([]);
  await openingFirst;
  assert.equal(ui.run('currentDraft.visit_id'), 'v2');
  assert.match(ui.modal.innerHTML, /Parcel two/);
});

test('a queued native close event does not clear a newly opened verification', async () => {
  const ui = harness();
  ui.modal.deferCloseEvents = true;
  ui.run('parcelModal()');
  await ui.click('close-dialog');
  await ui.run("openVerification('v2')");
  const current = ui.run('currentDraft');
  assert.equal(current.visit_id, 'v2');
  ui.modal.closeEvents.splice(0).forEach(dispatch => dispatch());
  assert.equal(ui.modal.open, true);
  assert.equal(ui.run('currentDraft'), current);
});

test('a queued native close event does not cancel a new pending verification open', async () => {
  const ui = harness(), pending = deferred();
  ui.modal.deferCloseEvents = true;
  ui.run('parcelModal()');
  await ui.click('close-dialog');
  ui.context.listDrafts = () => pending.promise;
  const opening = ui.run("openVerification('v2')");
  await turn();
  ui.modal.closeEvents.splice(0).forEach(dispatch => dispatch());
  pending.resolve([]);
  await opening;
  assert.equal(ui.modal.open, true);
  assert.equal(ui.run('currentDraft.visit_id'), 'v2');
});

test('tab navigation cancels a pending verification open', async () => {
  const ui = harness(), pending = deferred();
  ui.context.listDrafts = () => pending.promise;
  const opening = ui.run("openVerification('v1')");
  await turn();
  await ui.click('field-tab', { tab: 'records' });
  pending.resolve([]);
  await opening;
  assert.equal(ui.modal.open, false);
  assert.equal(ui.run('currentDraft'), undefined);
});

test('an older successful refresh cannot remove or deselect a newly created parcel', async () => {
  const ui = harness(), older = deferred(), newer = deferred();
  let reads = 0;
  ui.context.api = async path => path === '/dashboard' ? (++reads === 1 ? older.promise : newer.promise)
    : path === '/health' ? {} : [];
  ui.run('refresh=realRefresh; loadDetail=async()=>{}; selectedId="p1"');
  const oldRefresh = ui.run('refresh()');
  // A second completed form has selected its new parcel and requested fresh data.
  ui.run('selectedId="p2"');
  const newRefresh = ui.run('refresh()');
  newer.resolve({ parcels: [{ id: 'p1' }, { id: 'p2' }] });
  await newRefresh;
  assert.equal(ui.run('selectedId'), 'p2');
  older.resolve({ parcels: [{ id: 'p1' }] });
  await oldRefresh;
  assert.equal(ui.run('selectedId'), 'p2');
  assert.equal(ui.run('dashboard.parcels.map(p=>p.id).join(",")'), 'p1,p2');
  assert.equal(ui.run('loading'), false);
});

test('an older failed refresh cannot replace a newer successful connection state', async () => {
  const ui = harness(), older = deferred(), newer = deferred();
  let reads = 0;
  ui.context.api = async path => path === '/dashboard' ? (++reads === 1 ? older.promise : newer.promise)
    : path === '/health' ? {} : [];
  ui.run('refresh=realRefresh; loadDetail=async()=>{}');
  const oldRefresh = ui.run('refresh()');
  const newRefresh = ui.run('refresh()');
  newer.resolve({ parcels: [{ id: 'p1' }, { id: 'p2' }] });
  await newRefresh;
  older.reject(new Error('Older request lost connection'));
  await oldRefresh;
  assert.equal(ui.run('connected'), true);
  assert.equal(ui.run('loadError'), '');
  assert.equal(ui.run('dashboard.parcels.map(p=>p.id).join(",")'), 'p1,p2');
  assert.equal(ui.run('loading'), false);
});
