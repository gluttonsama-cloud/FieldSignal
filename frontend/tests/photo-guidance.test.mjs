import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { uploadVerificationDraft } from '../src/sync.ts';
import { saveDraft, listDrafts, clearDraft, DraftConflictError } from '../src/drafts.ts';
import { esc } from '../src/display.ts';
import { harness } from './helpers/ui-harness.mjs';

globalThis.window={indexedDB:globalThis.indexedDB};
const makeDraft=()=>({visit_id:crypto.randomUUID(),parcel_id:'p1',parcel_name:'合成地块',parcel_season:'2026-2027',data_origin:'fixture',client_submission_id:crypto.randomUUID(),observed_at:'2026-10-17T12:00:00Z',label:'uncertain',note:'合成现场记录',photos:[1,2,3].map(i=>({key:`photo-${i}`,name:i===2?'second-<photo>.png':`photo-${i}.png`,blob:new Blob([`synthetic-photo-${i}`],{type:'image/png'})})),state:'draft',updated_at:'2026-10-18T00:00:00Z'});
function photoUi(draft){
  const ui=harness({pathname:'/field'}),photos={innerHTML:''},count={},none={};
  const query=ui.modal.querySelector.bind(ui.modal);
  ui.modal.querySelector=selector=>selector==='#draft-photos'?photos:selector==='#photo-count'?count:selector==='#no-photo'?none:query(selector);
  Object.assign(ui.context,{value:draft,saveDraft,listDrafts,uploadVerificationDraft,esc,URL:{createObjectURL:()=>`blob:synthetic`,revokeObjectURL(){}}});
  ui.run('currentDraft=value;verificationModal()');return {...ui,photos};
}

test('a rejected or unconfirmed second photo is identifiable; confirmed first photo and originals survive, and retry skips it',async()=>{
  for(const failure of ['rejected','network','missing-id']){
    const draft=makeDraft();await saveDraft(draft);const ui=photoUi(draft),sent=[];
    globalThis.fetch=async(path,options)=>{
      sent.push(path);assert.ok(path.endsWith('/photos'));
      if(sent.length===1)return Response.json({id:'confirmed-first'});
      if(failure==='rejected')return Response.json({error:{message:'无法解码图片或图片超过1600万像素'}},{status:422});
      if(failure==='missing-id')return Response.json({});
      throw new TypeError('response lost');
    };
    await ui.submit();assert.equal(sent.length,2);assert.equal(ui.modal.open,true);
    assert.match(ui.modal.error.textContent,/第 2\/3 张照片「second-<photo>\.png」/);
    if(failure==='rejected')assert.match(ui.modal.error.textContent,/检查或更换这张照片/);
    else {assert.match(ui.modal.error.textContent,/服务端结果尚未确认/);assert.doesNotMatch(ui.modal.error.textContent,/此张未上传|这张照片未上传/);}
    assert.match(ui.photos.innerHTML,/>2\. second-&lt;photo&gt;\.png<\/small>/);
    assert.equal((ui.photos.innerHTML.match(/已上传 · 等待核查提交/g)||[]).length,1);
    assert.doesNotMatch(ui.photos.innerHTML,/<photo>/);
    const stored=(await listDrafts()).find(d=>d.visit_id===draft.visit_id);
    assert.deepEqual(stored.photos.map(p=>p.uploaded_id),['confirmed-first',undefined,undefined]);
    assert.deepEqual(await Promise.all(stored.photos.map(p=>p.blob.text())),['synthetic-photo-1','synthetic-photo-2','synthetic-photo-3']);
    const originalIdentity=stored.client_submission_id;
    if(failure==='rejected'){stored.photos[1].blob=new Blob(['replacement'],{type:'image/png'});stored.photos[1].name='replacement.png';await saveDraft(stored);}
    const resumed=photoUi(stored),retry=[];
    globalThis.fetch=async(path,options)=>{
      retry.push({path,options});
      if(path.endsWith('/photos'))return Response.json({id:`confirmed-${retry.length+1}`});
      return Response.json({id:'result',visit_id:stored.visit_id,parcel_id:'p1',photo_ids:['confirmed-first','confirmed-2','confirmed-3'],created_at:'2026-10-18T12:00:00Z'});
    };
    await resumed.submit();assert.equal(retry.length,3);assert.equal(resumed.modal.open,false);
    assert.equal(await retry[0].options.body.text(),failure==='rejected'?'replacement':'synthetic-photo-2');
    assert.equal(await retry[1].options.body.text(),'synthetic-photo-3');
    const payload=JSON.parse(retry[2].options.body);assert.deepEqual(payload.photo_ids,['confirmed-first','confirmed-2','confirmed-3']);assert.equal(payload.client_submission_id,originalIdentity);
    assert.equal((await listDrafts()).find(d=>d.visit_id===stored.visit_id),undefined);
  }
});

test('a local revision conflict after a confirmed photo is not mislabeled as a photo request error',async()=>{
  const draft=makeDraft();await saveDraft(draft);let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    const newer=(await listDrafts()).find(d=>d.visit_id===draft.visit_id);newer.note='另一页面的新备注';await saveDraft(newer);
    return Response.json({id:'confirmed-first'});
  };
  await assert.rejects(uploadVerificationDraft(draft),error=>error instanceof DraftConflictError&&!error.message.includes('第 1/3 张照片'));
  assert.equal(calls,1);assert.equal(draft.photos[0].uploaded_id,'confirmed-first');
  const stored=(await listDrafts()).find(d=>d.visit_id===draft.visit_id);assert.equal(stored.note,'另一页面的新备注');await clearDraft(stored);
});
