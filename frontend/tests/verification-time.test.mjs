import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, verificationResult, deferred, turn } from './helpers/ui-harness.mjs';

async function uiFor(season='2025-2026') {
  const ui=harness({pathname:'/field'});let uploads=0;
  ui.context.season=season;ui.run('dashboard.parcels[0].season=season');
  ui.context.uploadVerificationDraft=async draft=>{uploads++;return verificationResult(draft);};
  await ui.run("openVerification('v1')");
  ui.context.photo={key:'local-photo',name:'field.png',blob:new Blob(['retained-photo'])};
  ui.run("currentDraft.note='Actual observation';currentDraft.photos=[photo]");
  Object.defineProperty(ui,'uploads',{get:()=>uploads});return ui;
}

test('out-of-season or future observation is stopped before photo upload and retains actual input',async()=>{
  for(const observed of ['2026-10-18T00:00:00Z','2099-01-01T00:00:00Z']){
    const ui=await uiFor();ui.context.observed=observed;ui.run('currentDraft.observed_at=observed');
    await ui.submit();
    assert.equal(ui.uploads,0);assert.equal(ui.modal.open,true);
    assert.match(ui.modal.error.textContent,/种植季|本机当前时间/);
    assert.equal(ui.run('currentDraft.observed_at'),observed);assert.equal(ui.run('currentDraft.note'),'Actual observation');
    assert.equal(await ui.run('currentDraft.photos[0].blob.text()'),'retained-photo');
    assert.equal(ui.run('currentDraft.state'),'draft');
  }
});

test('season preflight uses the parcel of the draft and Shanghai calendar boundaries, not the selected parcel or UTC date',async()=>{
  const ui=await uiFor();ui.run("selectedId='p2';dashboard.parcels[1].season='2026-2027'");
  for(const [value,allowed] of [['2025-06-30T15:59:59Z',false],['2025-06-30T16:00:00Z',true],['2026-06-30T15:59:59Z',true],['2026-06-30T16:00:00Z',false]]){
    ui.context.value=value;ui.run('currentDraft.observed_at=value');
    assert.equal(Boolean(ui.run('verificationTimeError(currentDraft)')),!allowed,value);
  }
  ui.run("currentDraft.observed_at='2026-04-01T03:00:00Z'");await ui.submit();assert.equal(ui.uploads,1);
});

test('offline season snapshots guide editing; legacy drafts resolve the exact parcel before any upload',async()=>{
  const ui=await uiFor();assert.equal(ui.run('currentDraft.parcel_season'),'2025-2026');
  assert.match(ui.modal.innerHTML,/2025-07-01.*2026-06-30/);assert.match(ui.modal.innerHTML,/北京时间/);
  ui.run("dashboard.parcels=[];currentDraft.observed_at='2026-07-01T00:00:00Z'");await ui.submit();assert.equal(ui.uploads,0);
  assert.match(ui.modal.error.textContent,/种植季/);
  ui.run("delete currentDraft.parcel_season;currentDraft.observed_at='2026-04-01T03:00:00.123Z';verificationModal()");
  assert.match(ui.modal.innerHTML,/未保存.*种植季/);
  ui.run('storedDraftView={draft:currentDraft,json:JSON.stringify(currentDraft),blobs:currentDraft.photos.map(photo=>photo.blob)}');
  const guard=ui.run('storedDraftView'),before=structuredClone(ui.run('currentDraft')),reads=[];
  ui.context.api=async path=>{reads.push(path);throw Error('offline');};
  await ui.submit();assert.equal(ui.uploads,0);assert.deepEqual(structuredClone(ui.run('currentDraft')),before);assert.equal(ui.run('storedDraftView'),guard);
  assert.match(ui.modal.error.textContent,/本次未发送照片或核查/);
  for(const wrong of [{id:'p2',season:'2025-2026'},{id:'p1',season:'unknown'}]){
    ui.context.api=async()=>wrong;await ui.submit();assert.equal(ui.uploads,0);assert.deepEqual(structuredClone(ui.run('currentDraft')),before);assert.equal(ui.run('storedDraftView'),guard);
  }
  ui.context.api=async path=>{reads.push(path);return {id:'p1',season:'2025-2026'};};
  let submitted;ui.context.uploadVerificationDraft=async draft=>{submitted=structuredClone(draft);return verificationResult(draft);};
  await ui.submit();assert.deepEqual(reads,['/parcels/p1','/parcels/p1']);
  assert.equal(submitted.observed_at,'2026-04-01T03:00:00.123Z');assert.equal(submitted.parcel_season,'2025-2026');
});

test('late metadata after review confirmation cannot save, repaint or submit a replacement draft',async()=>{
  const ui=await uiFor(undefined),metadata=deferred();let writes=0,reads=0;
  ui.run("delete currentDraft.parcel_season;delete dashboard.parcels[0].season;currentDraft.observed_at='2026-04-01T03:00:00.123Z'");
  const old=ui.run('currentDraft'),save=ui.context.saveDraft;
  ui.context.saveDraft=async(...args)=>{writes++;return save(...args);};
  ui.context.api=async()=>{reads++;return metadata.promise;};
  await ui.review();const submit=ui.submit();await ui.submit();assert.equal(reads,1);
  await ui.click('field-tab',{tab:'parcels'});await ui.click('verify',{id:'v2'});
  const priorWrites=writes,priorStatus=ui.modal.saveStatus.textContent;
  metadata.resolve({id:'p1',season:'2025-2026'});await submit;
  assert.equal(ui.uploads,0);assert.equal(writes,priorWrites);assert.equal(ui.run('currentDraft.visit_id'),'v2');
  assert.equal(ui.modal.open,true);assert.equal(ui.modal.saveStatus.textContent,priorStatus);
  assert.equal(old.parcel_season,undefined);assert.equal(old.observed_at,'2026-04-01T03:00:00.123Z');
});

test('a pending Save and Return blocks review and confirmation until its local write settles',async()=>{
  const ui=await uiFor(undefined),saving=deferred(),save=ui.context.saveDraft;let reads=0;
  ui.run("delete currentDraft.parcel_season;delete dashboard.parcels[0].season;currentDraft.observed_at='2026-04-01T03:00:00.123Z'");
  ui.context.saveDraft=async(...args)=>{await saving.promise;return save(...args);};
  ui.context.api=async()=>{reads++;throw new Error('Must not request metadata while closing');};
  const close=ui.click('save-close');await turn();await ui.submit();await ui.submit();
  assert.equal(reads,0);assert.equal(ui.uploads,0);assert.equal(ui.modal.form.id,'verification-form');
  saving.resolve();await close;assert.equal(ui.modal.open,false);
});
