import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore, forceCloseDatabase } from 'fake-indexeddb';
import { harness, turn } from './helpers/ui-harness.mjs';

// Supported fake-indexeddb force-close plus injected terminal abort events;
// these are abnormal lifecycle regressions, not real-browser occurrence rates.
let sequence=0;
async function fixture() {
  const factory=new IDBFactory();let opens=0,database;
  const open=factory.open.bind(factory);
  factory.open=(...args)=>{opens++;const request=open(...args);request.addEventListener('success',()=>{database=request.result;});return request;};
  globalThis.indexedDB=factory;globalThis.window={indexedDB:factory};
  const drafts=await import(`../src/drafts.ts?connection=${++sequence}`);
  const value={visit_id:'v1',parcel_id:'p1',parcel_name:'Test parcel',data_origin:'user',client_submission_id:'same-submission',observed_at:'2026-10-18T00:00:00Z',label:'uncertain',note:'Original',photos:[{key:'photo-key',uploaded_id:'photo-id',name:'test.png',blob:new Blob(['photo-bytes'])}],pending_delete_photo_ids:['old-photo'],state:'draft',updated_at:'2026-10-18T00:00:00Z'};
  await drafts.saveDraft(value);
  return {...drafts,value,factory,get database(){return database;},get opens(){return opens;}};
}

test('unexpected close does no work until explicit read/save reopens and preserves draft identity and photos',async()=>{
  const f=await fixture(),old=f.database;forceCloseDatabase(old);
  assert.equal(f.opens,1,'close must not trigger an automatic storage retry');
  const [stored]=await f.listDrafts();assert.equal(f.opens,2);
  old.onclose();old.onversionchange();
  await f.listDrafts();assert.equal(f.opens,2,'late old events must not invalidate the replacement connection');
  assert.equal(stored.revision,f.value.revision);assert.equal(stored.client_submission_id,f.value.client_submission_id);
  assert.equal(await stored.photos[0].blob.text(),'photo-bytes');assert.equal(stored.photos[0].uploaded_id,'photo-id');
  stored.note='Explicit edit';await f.saveDraft(stored);
  const [saved]=await f.listDrafts();assert.equal(saved.note,'Explicit edit');assert.equal(saved.revision,2);
  assert.deepEqual(saved.pending_delete_photo_ids,['old-photo']);assert.equal(saved.photos[0].key,'photo-key');
  f.database.close();
});

test('explicit clear can reopen a closed connection without deleting a newer revision',async()=>{
  const f=await fixture(),old=structuredClone(f.value);f.value.note='Newer saved note';await f.saveDraft(f.value);
  forceCloseDatabase(f.database);
  await assert.rejects(f.clearDraft(old),f.DraftConflictError);
  const opens=f.opens;
  await assert.rejects(f.saveDraft(old),f.DraftConflictError);
  assert.equal(f.opens,opens,'ordinary CAS abort must not reset the connection');
  const [saved]=await f.listDrafts();assert.equal(saved.note,'Newer saved note');assert.equal(saved.revision,2);
  forceCloseDatabase(f.database);await f.clearDraft(saved);assert.deepEqual(await f.listDrafts(),[]);
  f.database.close();
});

test('a terminal abort after getAll success rejects instead of leaving a read pending',async t=>{
  const f=await fixture(),original=IDBObjectStore.prototype.getAll;
  let signal;const aborted=new Promise(resolve=>{signal=resolve;});
  const hook=t.mock.method(IDBObjectStore.prototype,'getAll',function(...args){
    const request=original.apply(this,args),tx=this.transaction;
    request.addEventListener('success',()=>tx.abort());tx.addEventListener('abort',signal);return request;
  });
  const state={status:'pending'};
  f.listDrafts().then(()=>{state.status='resolved';},error=>{state.status='rejected';state.error=error;});
  await aborted;await turn();
  assert.equal(state.status,'rejected');assert.match(state.error.message,/读取被中断/);
  hook.mock.restore();assert.equal((await f.listDrafts())[0].note,'Original');assert.equal(f.opens,1);
  f.database.close();
});

test('manual local retry after unexpected close saves retained edits without starting any upload',async()=>{
  const f=await fixture(),ui=harness({pathname:'/field'});let uploads=0;
  ui.context.listDrafts=f.listDrafts;ui.context.saveDraft=f.saveDraft;
  ui.context.uploadVerificationDraft=async()=>{uploads++;};
  await ui.run("openVerification('v1')");
  ui.run("currentDraft.note='Retained unsaved edit'; storedDraftView=undefined");
  forceCloseDatabase(f.database);assert.equal(f.opens,1);
  await ui.click('retry-draft-save');
  assert.equal(uploads,0);assert.equal(ui.modal.open,true);assert.equal(f.opens,2);
  const [saved]=await f.listDrafts();assert.equal(saved.note,'Retained unsaved edit');
  assert.equal(saved.client_submission_id,'same-submission');assert.equal(saved.photos[0].uploaded_id,'photo-id');
  assert.equal(await saved.photos[0].blob.text(),'photo-bytes');assert.deepEqual(saved.pending_delete_photo_ids,['old-photo']);
  f.database.close();
});

test('if stored data disappeared after a close, an old in-memory revision cannot silently recreate it',async()=>{
  const f=await fixture();forceCloseDatabase(f.database);
  await new Promise((resolve,reject)=>{const request=f.factory.deleteDatabase('fieldsignal-local-drafts');request.onsuccess=resolve;request.onerror=reject;});
  await assert.rejects(f.saveDraft(f.value),f.DraftConflictError);
  assert.deepEqual(await f.listDrafts(),[]);assert.equal(f.value.note,'Original');
  assert.equal(await f.value.photos[0].blob.text(),'photo-bytes');
  f.database.close();
});

async function legacyStore() {
  const factory=new IDBFactory(),connections=[];
  const open=factory.open.bind(factory);
  factory.open=(...args)=>{const request=open(...args);request.addEventListener('success',()=>connections.push(request.result));return request;};
  globalThis.indexedDB=factory;globalThis.window={indexedDB:factory};
  const database=await new Promise((resolve,reject)=>{const request=factory.open('fieldsignal-local-drafts',1);request.onupgradeneeded=()=>request.result.createObjectStore('verifications',{keyPath:'visit_id'});request.onsuccess=()=>resolve(request.result);request.onerror=reject;});
  const value={visit_id:'legacy',parcel_id:'p1',parcel_name:'Legacy parcel',client_submission_id:'legacy-submission',observed_at:'2026-10-18T00:00:00Z',note:'Keep every byte',label:'uncertain',photos:[{key:'local',name:'test.png',blob:new Blob(['legacy-photo-bytes'])}],state:'draft',updated_at:'2026-10-18T00:00:00Z'};
  await new Promise((resolve,reject)=>{const tx=database.transaction('verifications','readwrite');tx.objectStore('verifications').put(value);tx.oncomplete=resolve;tx.onerror=reject;});
  const storage=await import(`../src/drafts.ts?migration=${++sequence}`);
  return {factory,database,value,storage,connections};
}

test('version 2 preserves existing notes and photos and makes old version-1 readers fail before seeing markers',async()=>{
  const f=await legacyStore();let changed=0;
  f.database.onversionchange=()=>{changed++;f.database.close();};
  const [saved]=await f.storage.listDrafts();assert.equal(changed,1);assert.deepEqual(saved,f.value);
  assert.equal(await saved.photos[0].blob.text(),'legacy-photo-bytes');
  await f.storage.removeDraft(saved);assert.deepEqual(await f.storage.listDrafts(),[]);
  await assert.rejects(new Promise((resolve,reject)=>{const request=f.factory.open('fieldsignal-local-drafts',1);request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject(request.error);}),{name:'VersionError'});
  await assert.rejects(f.storage.saveDraft(saved),f.storage.DraftConflictError);
  f.connections.forEach(database=>database.close());
});

test('blocked version upgrade leaves existing data intact and a manual retry closes the orphan upgrade connection',async()=>{
  const f=await legacyStore();
  await assert.rejects(f.storage.listDrafts(),/旧窗口.*关闭其他 FieldSignal 页面后重试/);
  const original=await new Promise((resolve,reject)=>{const tx=f.database.transaction('verifications','readonly'),request=tx.objectStore('verifications').get('legacy');tx.oncomplete=()=>resolve(request.result);tx.onerror=reject;});
  assert.deepEqual(original,f.value);f.database.close();
  const [saved]=await f.storage.listDrafts();assert.deepEqual(saved,f.value);assert.equal(await saved.photos[0].blob.text(),'legacy-photo-bytes');
  assert.equal(f.connections.length,3);
  assert.throws(()=>f.connections[1].transaction('verifications','readonly'),{name:'InvalidStateError'});
  assert.equal(f.connections[2].version,2);
  f.connections.forEach(database=>database.close());
});
