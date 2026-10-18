import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Exercise the production event handlers with a tiny DOM boundary. This does not
// replace browser/visual testing or the IndexedDB CAS tests in core.test.mjs.
const mainSource = stripTypeScriptTypes(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^void refresh\(\);\s*$/m, '');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  class Button {
    disabled = false;
    textContent = '';
    constructor(dataset = {}) { this.dataset = dataset; }
  }
  const status = () => ({ textContent: '', hidden: true, focus() {} });
  const app = { innerHTML: '', addEventListener() {} };
  const modal = {
    open: false, className: '', listeners: {}, form: undefined, closeCount: 0,
    deferCloseEvents: false, closeEvents: [],
    error: status(), saveStatus: status(), fields: { disabled: false },
    get innerHTML() { return this.html || ''; },
    set innerHTML(html) {
      this.html = html;
      this.error = status();
      this.saveStatus = status();
      const tag = html.match(/<form\b([^>]*)>/)?.[1];
      if (!tag) { this.form = undefined; return; }
      const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
      const dataset = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()), value]));
      const form = {
        id: attrs.id, dataset, values: {}, submit: new Button(),
        reportValidity: () => true,
        querySelector(selector) { return selector.includes('submit') ? this.submit : null; },
        get isConnected() { return modal.form === this; },
      };
      this.form = form;
    },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    showModal() { this.open = true; },
    close() {
      this.open = false; this.closeCount += 1;
      if (this.deferCloseEvents) this.closeEvents.push(() => this.listeners.close?.());
      else this.listeners.close?.();
    },
    contains(element) { return element === this.form; },
    querySelector(selector) {
      if (selector === '.form-error') return this.error;
      if (selector === '#draft-save') return this.saveStatus;
      if (selector === '#verification-fields') return this.fields;
      if (selector.includes('submit')) return this.form?.submit;
      if (selector === 'form' || selector === `#${this.form?.id}`) return this.form;
      return null;
    },
  };
  const toast = { textContent: '', classList: { add() {}, remove() {} } };
  const document = {
    listeners: {},
    querySelector(selector) { return selector === '#app' ? app : selector === '#modal' ? modal : toast; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
  const context = vm.createContext({
    document, location: { pathname: '/admin' }, navigator: { onLine: true },
    window: { addEventListener() {}, scrollTo() {} },
    createSourceController: () => ({ refresh: async () => {} }),
    listDrafts: async () => [], saveDraft: async draft => { draft.revision = (draft.revision || 0) + 1; },
    post: async () => ({}), crypto, structuredClone, URL, Date, Error, Promise,
    setTimeout() {}, HTMLButtonElement: Button,
    FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.values[key]; } },
    regions: {}, kinds: {}, labels: {}, today: () => '2026-10-18',
    fmtTime: value => value, localInput: value => value, esc: String, fixture: () => '',
  });
  vm.runInContext(`${mainSource}\nglobalThis.realRefresh=refresh; render=()=>{}; refresh=async()=>{};
    dashboard.parcels=[{id:'p1',name:'Parcel one',data_origin:'user'},{id:'p2',name:'Parcel two',data_origin:'user'}];
    visits=[{id:'v1',parcel_id:'p1'},{id:'v2',parcel_id:'p2'}]; selectedId='p1';`, context);
  return {
    context, modal, toast,
    run: code => vm.runInContext(code, context),
    click: (action, dataset = {}) => document.listeners.click({ target: { closest: () => new Button({ action, ...dataset }) } }),
    submit(form = modal.form) { return modal.listeners.submit({ target: form, preventDefault() {} }); },
  };
}

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
