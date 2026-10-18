import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { uploadVerificationDraft } from '../src/sync.ts';
import { listDrafts, saveDraft } from '../src/drafts.ts';
import { harness } from './helpers/ui-harness.mjs';

globalThis.window={indexedDB:globalThis.indexedDB};
const draftFor=note=>({visit_id:crypto.randomUUID(),parcel_id:'unknown-parcel',parcel_name:'合成地块',data_origin:'fixture',client_submission_id:crypto.randomUUID(),observed_at:'2026-10-17T12:00:00Z',label:'uncertain',note,photos:[{key:'replacement',name:'synthetic.png',blob:new Blob(['synthetic replacement'],{type:'image/png'})}],pending_delete_photo_ids:['synthetic-staged'],state:'draft',updated_at:'2026-10-18T00:00:00Z'});

test('blank remarks stop UI submission before metadata lookup, persistence, or photo operations and preserve the original draft',async()=>{
  for(const note of ['', ' \t\n ', '\u3000\u00a0']){
    const draft=draftFor(note);await saveDraft(draft);const before=structuredClone(draft),ui=harness({pathname:'/field'});let reads=0,saves=0,uploads=0;
    Object.assign(ui.context,{value:draft,api:async()=>{reads++;throw new Error('Metadata must not be requested');},saveDraft:async()=>{saves++;},uploadVerificationDraft:async()=>{uploads++;}});
    ui.run('currentDraft=value;verificationModal()');await ui.submit();
    assert.match(ui.modal.error.textContent,/请填写现场备注.*空格或换行/);assert.equal(ui.modal.open,true);assert.equal(ui.run('submitting'),false);assert.equal(ui.modal.fields.disabled,false);assert.equal(reads,0);assert.equal(saves,0);assert.equal(uploads,0);
    assert.deepEqual(draft,before);assert.equal(await draft.photos[0].blob.text(),'synthetic replacement');
    const stored=(await listDrafts()).find(item=>item.visit_id===draft.visit_id);assert.equal(stored.note,note);assert.deepEqual(stored.pending_delete_photo_ids,['synthetic-staged']);assert.equal(stored.state,'draft');
  }
});

test('the sync entry also refuses blank remarks before DELETE/upload; correcting to a padded substantive note resumes the explicit submission unchanged',async()=>{
  const draft=draftFor(' \t\n ');await saveDraft(draft);const before=structuredClone(draft),requests=[];
  globalThis.fetch=async(path,options)=>{requests.push({path,options});throw new Error('Must not send blank remarks');};
  await assert.rejects(uploadVerificationDraft(draft),/请填写现场备注/);assert.equal(requests.length,0);assert.deepEqual(draft,before);
  draft.note='  叶片正常\n已检查排水沟  ';await saveDraft(draft);
  globalThis.fetch=async(path,options)=>{
    requests.push({path,options});
    if(options.method==='DELETE')return new Response(null,{status:204});
    if(path.endsWith('/photos'))return Response.json({id:'acknowledged-replacement'});
    const payload=JSON.parse(options.body);assert.equal(payload.note,draft.note,'preflight must not rewrite substantive text');
    return Response.json({id:'synthetic-verification',visit_id:draft.visit_id,parcel_id:draft.parcel_id,photo_ids:payload.photo_ids});
  };
  await uploadVerificationDraft(draft);
  assert.equal(requests.length,3);assert.equal(requests[0].options.method,'DELETE');assert.equal(await requests[1].options.body.text(),'synthetic replacement');assert.deepEqual(JSON.parse(requests[2].options.body).photo_ids,['acknowledged-replacement']);
  assert.equal((await listDrafts()).some(item=>item.visit_id===draft.visit_id),false);
});
