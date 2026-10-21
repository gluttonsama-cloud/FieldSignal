import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { uploadVerificationDraft } from '../src/sync.ts';
import { saveDraft,listDrafts,clearDraft,DraftConflictError } from '../src/drafts.ts';
import { photoReceipt,verificationReceipt } from './helpers/submission-receipts.mjs';
import { harness } from './helpers/ui-harness.mjs';
globalThis.window={indexedDB:globalThis.indexedDB};
const draftFor=()=>({visit_id:crypto.randomUUID(),parcel_id:'p1',parcel_name:'Synthetic parcel',parcel_season:'2026-2027',data_origin:'fixture',client_submission_id:crypto.randomUUID(),observed_at:'2026-10-17T12:00:00.123Z',label:'uncertain',note:' \u0085Original synthetic field note\u0085 ',photos:[{key:'original-photo',name:'synthetic.png',blob:new Blob(['synthetic original image'],{type:'image/png'}),uploaded_id:'photo-original'}],pending_delete_photo_ids:[],state:'draft',updated_at:'2026-10-18T00:00:00Z'});
const stored=async draft=>(await listDrafts()).find(item=>item.visit_id===draft.visit_id);
async function cleanup(draft){const value=await stored(draft);if(value)await clearDraft(value);}

test('same-task but wrong verification receipts never erase the durable original draft or photos',async()=>{
 const mismatches=[
  {id:{invalid:true}},{id:' '},{parcel_id:'wrong-parcel'},{client_submission_id:'wrong-submission'},
  {observed_at:'2026-10-17T12:00:00.124Z'},{label:'normal'},{note:'Changed report'},
  {photo_ids:[]},{photo_ids:['wrong-photo']},{photo_ids:['photo-original','photo-original']},
  {created_at:'not-a-time'},{data_origin:'user'},{label_source:'confirmed_diagnosis'},
 ];
 for(const mismatch of mismatches){
  const draft=draftFor();await saveDraft(draft);const before=structuredClone(await stored(draft));let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json(verificationReceipt(draft,mismatch));};
  try{
   await assert.rejects(uploadVerificationDraft(draft),/回执|未确认/);
   assert.deepEqual(await stored(draft),before);assert.equal(await (await stored(draft)).photos[0].blob.text(),'synthetic original image');assert.equal(calls,1);
  }finally{await cleanup(draft);}
 }
});

test('an uncertain final receipt retains acknowledged photo IDs and retries only the identical report with the original key',async()=>{
 const draft=draftFor();delete draft.photos[0].uploaded_id;await saveDraft(draft);const calls=[];
 globalThis.fetch=async(path,options)=>{calls.push({path,options});return Response.json(path.endsWith('/photos')?photoReceipt(draft,'new-photo'):verificationReceipt(draft,{note:'Not the submitted note'}));};
 try{
  await assert.rejects(uploadVerificationDraft(draft),/回执|未确认/);assert.equal(calls.length,2);const originalPayload=JSON.parse(calls[1].options.body),resumed=await stored(draft);
  assert.equal(resumed.photos[0].uploaded_id,'new-photo');assert.equal(resumed.client_submission_id,draft.client_submission_id);assert.equal(await resumed.photos[0].blob.text(),'synthetic original image');
  globalThis.fetch=async(path,options)=>{calls.push({path,options});assert.ok(path.endsWith('/verifications'));return Response.json(verificationReceipt(resumed));};
  await uploadVerificationDraft(resumed);assert.equal(calls.length,3);assert.deepEqual(JSON.parse(calls[2].options.body),originalPayload);assert.equal(await stored(draft),undefined);
 }finally{await cleanup(draft);}
});

test('invalid photo receipts stop before final submission, never persist the bogus ID and preserve original bytes for retry',async()=>{
 for(const mismatch of [{id:{}},{id:42},{id:' '},{visit_id:'wrong-task'},{created_at:'bad-time'},{content_type:'text/html'},{size_bytes:0},{metadata_stripped:false},{state:'missing'},{data_origin:'user'}]){
  const draft=draftFor();delete draft.photos[0].uploaded_id;await saveDraft(draft);let calls=0;
  globalThis.fetch=async path=>{calls++;return Response.json(path.endsWith('/photos')?photoReceipt(draft,'new-photo',mismatch):verificationReceipt({...draft,photos:[]}));};
  try{
   await assert.rejects(uploadVerificationDraft(draft),/第 1\/1 张照片.*结果尚未确认/);assert.equal(calls,1);assert.equal(draft.photos[0].uploaded_id,undefined);
   const saved=await stored(draft);assert.equal(saved.photos[0].uploaded_id,undefined);assert.equal(await saved.photos[0].blob.text(),'synthetic original image');
  }finally{await cleanup(draft);}
 }
});

test('the actual UI retains the editor and draft after an inconsistent receipt and only closes after an explicit valid retry',async()=>{
 const draft=draftFor();await saveDraft(draft);const ui=harness({pathname:'/field'});Object.assign(ui.context,{seedDraft:draft,saveDraft,listDrafts,uploadVerificationDraft});
 ui.run("currentDraft=seedDraft;visits=[{id:seedDraft.visit_id,parcel_id:'p1',status:'pending'}];verificationModal()");
 globalThis.fetch=async()=>Response.json(verificationReceipt(draft,{parcel_id:'wrong-parcel'}));
 try{
  await ui.submit();assert.equal(ui.modal.open,true);assert.match(ui.modal.error.textContent,/回执|未确认/);assert.equal(ui.run('visits[0].status'),'pending');assert.equal(ui.run('verifications.length'),0);assert.ok(await stored(draft));assert.doesNotMatch(ui.toast.textContent,/核查已保存/);
  globalThis.fetch=async()=>Response.json(verificationReceipt(draft));await ui.submit();assert.equal(ui.modal.open,false);assert.equal(ui.run('visits[0].status'),'completed');assert.equal(ui.run('verifications[0].parcel_id'),'p1');assert.equal(await stored(draft),undefined);
 }finally{await cleanup(draft);}
});

test('a receipt is bound to the sent snapshot, so mutation during the request cannot validate the wrong content or clear a newer revision',async()=>{
 const draft=draftFor();await saveDraft(draft);let sent;
 globalThis.fetch=async(_path,options)=>{
  sent=JSON.parse(options.body);draft.note='A newer saved local note';await saveDraft(draft);return Response.json(verificationReceipt(draft,{note:sent.note.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'')}));
 };
 try{
  await assert.rejects(uploadVerificationDraft(draft),error=>error instanceof DraftConflictError&&/提交已确认/.test(error.message));
  assert.equal((await stored(draft)).note,'A newer saved local note');assert.notEqual(sent.note,draft.note);
 }finally{await cleanup(draft);}
});
