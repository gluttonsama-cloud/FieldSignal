import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import * as storage from '../src/drafts.ts';
import { esc } from '../src/display.ts';
import { harness, deferred } from './helpers/ui-harness.mjs';

globalThis.window={indexedDB:globalThis.indexedDB};
beforeEach(async()=>{for(const draft of await storage.listDrafts())await storage.clearDraft(draft);});
const draft=id=>({visit_id:id,parcel_id:`p-${id}`,parcel_name:'<田块>',data_origin:'fixture',client_submission_id:`submission-${id}`,observed_at:'2026-10-18T00:00:00Z',label:'uncertain',note:'Saved field note',photos:[{key:`photo-${id}`,uploaded_id:`server-${id}`,name:'local.png',blob:new Blob([`bytes-${id}`])}],pending_delete_photo_ids:['server-old'],state:'error',error:'Network result unknown',updated_at:'2026-10-18T00:00:00Z'});
async function setup(){
  for(const id of ['one','two'])await storage.saveDraft({...draft(id),client_submission_id:crypto.randomUUID()},true);
  const ui=harness({pathname:'/field'});let network=0;
  Object.assign(ui.context,{listDrafts:storage.listDrafts,removeDraft:storage.removeDraft,saveDraft:storage.saveDraft,esc,fmtDate:String,empty:()=>'',post:async()=>{network++;throw Error('No network expected');},uploadVerificationDraft:async()=>{network++;throw Error('No upload expected');}});
  ui.context.saved=await storage.listDrafts();ui.run('drafts=saved; visits=[]');
  Object.defineProperty(ui,'network',{get:()=>network});return ui;
}

test('single draft removal has a separate scoped confirmation; cancel leaves notes and photos intact',async()=>{
  const ui=await setup(),before=await storage.listDrafts();
  assert.match(ui.run('fieldVisits()'),/data-action="remove-draft"/);
  await ui.click('remove-draft',{id:'one'});
  assert.equal(ui.modal.open,true);assert.equal(ui.run('currentDraft'),undefined);
  assert.match(ui.modal.innerHTML,/&lt;田块&gt;/);assert.doesNotMatch(ui.modal.innerHTML,/<田块>/);
  for(const text of ['p-one','one','1 张照片','不可恢复','服务端','其他页面'])assert.ok(ui.modal.innerHTML.includes(text),text);
  assert.deepEqual(await storage.listDrafts(),before);
  await ui.click('close-dialog');assert.equal(ui.modal.open,false);
  assert.deepEqual(await storage.listDrafts(),before);assert.equal(ui.network,0);
});

test('confirmed removal deletes only that persisted local revision and cannot resurrect via an old save',async()=>{
  const ui=await setup(),before=await storage.listDrafts();
  await ui.click('remove-draft',{id:'one'});await ui.click('confirm-remove-draft');
  const saved=await storage.listDrafts();assert.equal(saved.length,1);assert.equal(saved[0].visit_id,'two');
  assert.equal(await saved[0].photos[0].blob.text(),'bytes-two');assert.deepEqual(saved[0],before[1]);
  assert.equal(ui.modal.open,false);assert.equal(ui.run('drafts.length'),1);assert.equal(ui.network,0);
  await assert.rejects(storage.saveDraft(before[0]),storage.DraftConflictError);
});

test('another tab revision or replacement submission is preserved and requires new confirmation',async()=>{
  for(const replacement of [false,true]){
    const ui=await setup();await ui.click('remove-draft',{id:'one'});
    const other=(await storage.listDrafts()).find(d=>d.visit_id==='one');
    if(replacement){await storage.clearDraft(other);other.revision=0;other.client_submission_id=crypto.randomUUID();}
    other.note='Another tab updated this';await storage.saveDraft(other,replacement);
    await ui.click('confirm-remove-draft');
    assert.equal(ui.modal.open,true);assert.match(ui.modal.error.textContent,/另一页面/);
    assert.equal(ui.run('draftRemoval.blocked'),true);
    await ui.click('confirm-remove-draft');
    const remaining=(await storage.listDrafts()).find(d=>d.visit_id==='one');
    assert.equal(remaining.note,other.note);assert.equal(remaining.client_submission_id,other.client_submission_id);
    assert.equal(await remaining.photos[0].blob.text(),'bytes-one');assert.equal(ui.network,0);
    for(const d of await storage.listDrafts())await storage.clearDraft(d);
  }
});

test('removal waits for one transaction and blocks repeated clicks and close until its outcome',async()=>{
  const ui=await setup(),gate=deferred();let removes=0;
  ui.context.removeDraft=async d=>{removes++;await gate.promise;await storage.removeDraft(d);};
  await ui.click('remove-draft',{id:'one'});const removal=ui.click('confirm-remove-draft');
  await ui.click('confirm-remove-draft');await ui.click('close-dialog');
  let prevented=false;ui.modal.listeners.cancel({preventDefault(){prevented=true;}});
  assert.equal(removes,1);assert.equal(ui.modal.open,true);assert.equal(prevented,true);
  gate.resolve();await removal;assert.equal(ui.modal.open,false);assert.equal(ui.network,0);
});

test('local IO failure retains the draft and explicit retry does not upload',async()=>{
  const ui=await setup(),before=await storage.listDrafts();let attempts=0;
  ui.context.removeDraft=async d=>{if(++attempts===1)throw Error('Local transaction unavailable');await storage.removeDraft(d);};
  await ui.click('remove-draft',{id:'one'});await ui.click('confirm-remove-draft');
  assert.equal(ui.modal.open,true);assert.match(ui.modal.error.textContent,/Local transaction unavailable/);
  assert.deepEqual(await storage.listDrafts(),before);assert.equal(ui.network,0);
  await ui.click('confirm-remove-draft');assert.equal(attempts,2);assert.equal(ui.modal.open,false);assert.equal(ui.network,0);
});

test('editor and late confirmation reads cannot discard unsaved edits or replace a newer dialog',async()=>{
  const ui=await setup();await ui.run("openVerification('one')");
  ui.run("currentDraft.note='Unsaved edit'");await ui.click('remove-draft',{id:'two'});
  assert.equal(ui.run('currentDraft.note'),'Unsaved edit');assert.match(ui.modal.innerHTML,/verification-form/);
  ui.run('currentDraft=undefined;closeModal()');
  const read=deferred();ui.context.listDrafts=()=>read.promise;
  const pending=ui.click('remove-draft',{id:'one'});ui.run("openModal('New form','Keep this input')");
  read.resolve(await storage.listDrafts());await pending;
  assert.match(ui.modal.innerHTML,/Keep this input/);assert.equal(ui.run('draftRemoval'),undefined);assert.equal(ui.network,0);
});

// A legacy tab can retain revision zero even after another tab upgrades it.
test('legacy stale writer cannot restore deleted content; explicit new start uses a fresh identity',async()=>{
  const ui=await setup(),stored=(await storage.listDrafts())[0];
  const legacy={...structuredClone(stored),revision:undefined};
  await storage.removeDraft(stored);await storage.removeDraft(stored);await storage.clearDraft(stored);
  await assert.rejects(storage.saveDraft(legacy),storage.DraftConflictError);
  const fresh={...draft('one'),client_submission_id:crypto.randomUUID(),photos:[],note:''};
  await assert.rejects(storage.saveDraft(fresh),storage.DraftConflictError);
  await storage.saveDraft(fresh,true);assert.ok(fresh.revision>stored.revision);
  await assert.rejects(storage.removeDraft(stored),storage.DraftConflictError);
  await assert.rejects(storage.saveDraft(legacy),storage.DraftConflictError);
  await storage.clearDraft(fresh);
  await assert.rejects(storage.saveDraft(legacy),storage.DraftConflictError);
  assert.equal((await storage.listDrafts()).some(d=>d.visit_id==='one'),false);
  const database=await new Promise((resolve,reject)=>{const request=indexedDB.open('fieldsignal-local-drafts');request.onsuccess=()=>resolve(request.result);request.onerror=reject;});
  const marker=await new Promise((resolve,reject)=>{const tx=database.transaction('verifications','readonly'),request=tx.objectStore('verifications').get('one');tx.oncomplete=()=>resolve(request.result);tx.onerror=reject;});
  assert.deepEqual(Object.keys(marker).sort(),['client_submission_id','removed','revision','visit_id']);
  assert.equal(marker.removed,true);database.close();
});

test('explicitly starting the pending task after removal creates a new empty draft, not the old notes or photos',async()=>{
  const ui=await setup(),old=(await storage.listDrafts())[0];
  await ui.click('remove-draft',{id:'one'});await ui.click('confirm-remove-draft');
  ui.run("visits=[{id:'one',parcel_id:'p-one',status:'pending'}]");
  await ui.click('verify',{id:'one'});
  const fresh=ui.run('currentDraft');assert.ok(fresh);assert.notEqual(fresh.client_submission_id,old.client_submission_id);
  assert.equal(fresh.note,'');assert.equal(fresh.photos.length,0);assert.ok(fresh.revision>old.revision);
  await assert.rejects(storage.removeDraft(old),storage.DraftConflictError);
  await assert.rejects(storage.saveDraft({...old,revision:undefined}),storage.DraftConflictError);
  assert.equal(ui.network,0);
});
