import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { parseParcelGeometry, parcelGeometrySummary } from '../../src/parcel-geometry.ts';
import { parseObservationInput, observationImportSummary } from '../../src/observation-import.ts';
import { recordPhotoStrip, recordPhotoViewer, bindRecordPhotoEvents, retryRecordPhoto, zoomRecordPhoto } from '../../src/record-photos.ts';
import { shortParcelId } from '../../src/display.ts';
import { verificationNoteError } from '../../src/sync.ts';
import { recordCandidate, candidateSnapshot, candidateObservations } from '../../src/candidate-evidence.ts';
import { parcelBoundaryFile, downloadParcelBoundary } from '../../src/parcel-export.ts';
import { ApiError } from '../../src/api.ts';
import { DraftConflictError } from '../../src/drafts.ts';

// Exercise the production event handlers with a tiny DOM boundary. This does not
// replace browser/visual testing or the IndexedDB CAS tests in core.test.mjs.
const mainSource = stripTypeScriptTypes(readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^void refresh\(\);\s*$/m, '');
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export const turn = () => new Promise(resolve => setImmediate(resolve));

export function harness({ pathname = '/admin' } = {}) {
  class Button {
    disabled = false;
    textContent = '';
    hidden = true;
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
      this.candidateObservations = html.includes('id="candidate-observations"') ? {innerHTML:''} : undefined;
      this.retrySave = html.includes('id="retry-draft-save"') ? new Button({ action: 'retry-draft-save' }) : undefined;
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
      if (selector === '#candidate-observations') return this.candidateObservations;
      if (selector === '.candidate-evidence-viewer') return this.innerHTML.includes('class="candidate-evidence-viewer"') ? {} : null;
      if (selector === '.form-error') return this.error;
      if (selector === '.record-photo-viewer') return this.innerHTML.includes('class="record-photo-viewer"') ? {} : null;
      if (selector === '#draft-save') return this.saveStatus;
      if (selector === '#retry-draft-save') return this.retrySave;
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
  const window = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, scrollTo() {} };
  const context = vm.createContext({
    document, location: { pathname }, navigator: { onLine: true },
    window,
    createSourceController: () => ({ refresh: async () => {} }),
    listDrafts: async () => [], saveDraft: async draft => { draft.revision = (draft.revision || 0) + 1; },
    parseObservationInput, observationImportSummary, parseParcelGeometry, parcelGeometrySummary,
    recordPhotoStrip, recordPhotoViewer, bindRecordPhotoEvents, retryRecordPhoto, zoomRecordPhoto,
    recordCandidate, candidateSnapshot, candidateObservations, parcelBoundaryFile, downloadParcelBoundary,
    post: async () => ({}), DraftConflictError, ApiError, crypto, structuredClone, URL, Date, Error, SyntaxError, Promise,
    setTimeout() {}, HTMLButtonElement: Button,
    FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.values[key]; } },
    verificationNoteError, shortParcelId, regions: {}, kinds: {}, labels: {}, today: () => '2026-10-18',
    fmtTime: value => value, localInput: value => value, esc: String, fixture: () => '',
  });
  vm.runInContext(`${mainSource}\nglobalThis.realRefresh=refresh; render=()=>{}; refresh=async()=>{};
    dashboard.parcels=[{id:'p1',name:'Parcel one',season:'2026-2027',data_origin:'user'},{id:'p2',name:'Parcel two',season:'2026-2027',data_origin:'user'}];
    visits=[{id:'v1',parcel_id:'p1'},{id:'v2',parcel_id:'p2'}]; selectedId='p1';`, context);
  return {
    context, app, modal, toast, window,
    run: code => vm.runInContext(code, context),
    click: (action, dataset = {}) => document.listeners.click({ target: { closest: () => action === 'retry-draft-save' && modal.retrySave ? modal.retrySave : new Button({ action, ...dataset }) } }),
    submit(form = modal.form) { return modal.listeners.submit({ target: form, preventDefault() {} }); },
  };
}


// Acknowledged API result for UI upload stubs; production sync validates it.
export const verificationResult = draft => ({ id: `record-${draft.visit_id}`, visit_id: draft.visit_id, parcel_id: draft.parcel_id, observed_at: draft.observed_at, label: draft.label, note: draft.note, photo_ids: draft.photos.map(photo => photo.uploaded_id).filter(Boolean), client_submission_id: draft.client_submission_id, created_at: '2026-10-18T12:00:00Z' });
