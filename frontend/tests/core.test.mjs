import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { esc, boundaryMap, trend, usable } from '../src/display.ts';
import { saveDraft, listDrafts, clearDraft } from '../src/drafts.ts';
import { uploadVerificationDraft } from '../src/sync.ts';
import { api, ApiError } from '../src/api.ts';
import { photoReceipt, verificationReceipt } from './helpers/submission-receipts.mjs';

globalThis.window = { indexedDB: globalThis.indexedDB };
const observation = (overrides = {}) => ({ id:'o1',parcel_id:'p1',observed_at:new Date().toISOString(),source:'sentinel2',source_record_id:'src',features:{ndvi:.5},quality:{usable:true,valid_fraction:.8,cloud_fraction:.1,flags:[]},provenance:{provider:'fixture',collection:'same',item_id:'item',processing_version:'v1'},...overrides });
const draft = id => ({ visit_id:id,parcel_id:'p1',parcel_name:'测试',data_origin:'fixture',client_submission_id:crypto.randomUUID(),observed_at:new Date().toISOString(),label:'uncertain',note:'测试备注',photos:[{key:'photo1',name:'test.png',blob:new Blob(['image-bytes'],{type:'image/png'})}],pending_delete_photo_ids:[],state:'draft',updated_at:new Date().toISOString() });

test('untrusted text is escaped in map labels', () => {
  assert.equal(esc('<img onerror="x">&'), '&lt;img onerror=&quot;x&quot;&gt;&amp;');
  const map=boundaryMap([{id:'p1',name:'<script>alert(1)</script>',geometry:{coordinates:[[[112,30],[112.01,30],[112.01,30.01],[112,30]]]},data_origin:'user'}],'p1');
  assert.ok(map.includes('&lt;script&gt;'));
  assert.ok(!map.includes('<script>'));
  assert.ok(boundaryMap([]).includes('还没有地块边界'));
});

test('chart honors usable, valid fraction, S2 cloud and freshness gates', () => {
  assert.equal(usable(observation()),true);
  assert.equal(usable(observation({quality:{usable:true,valid_fraction:.59,cloud_fraction:0,flags:[]}})),false);
  assert.equal(usable(observation({quality:{usable:true,valid_fraction:.8,flags:[]}})),false);
  assert.equal(usable(observation({quality:{usable:true,valid_fraction:.8,cloud_fraction:.41,flags:[]}})),false);
  assert.equal(usable(observation({source:'manual',quality:{usable:true,valid_fraction:.6,flags:[]}})),true);
  assert.ok(trend([]).includes('待接入 NDVI 时序'));
  assert.ok(trend([observation({observed_at:new Date(Date.now()-15*86400000).toISOString()})]).includes('数据已过期'));
});

test('chart never connects long gaps, low quality or different processing sources', () => {
  const o=observation({observed_at:'2026-10-01T00:00:00Z'});
  const next=observation({id:'o2',observed_at:'2026-10-04T00:00:00Z'});
  const lineCount = values => (trend(values).match(/stroke="#478361"/g)||[]).length;
  assert.equal(lineCount([o,next]),1);
  assert.equal(lineCount([o,{...next,source:'manual'}]),0);
  assert.equal(lineCount([o,{...next,provenance:{...next.provenance,processing_version:'v2'}}]),0);
  assert.equal(lineCount([o,{...next,provenance:{...next.provenance,collection:'other'}}]),0);
  assert.equal(lineCount([o,{...next,observed_at:'2026-10-20T00:00:00Z'}]),0);
  assert.equal(lineCount([o,{...next,quality:{...next.quality,valid_fraction:.4}}]),0);
});

test('IndexedDB saves immutable draft snapshots including photo bytes', async () => {
  const value=draft('v-idb');
  await saveDraft(value);
  value.note='mutated after save';
  const stored=(await listDrafts()).find(x=>x.visit_id==='v-idb');
  assert.equal(stored.note,'测试备注');
  assert.equal(await stored.photos[0].blob.text(),'image-bytes');
  assert.equal(stored.client_submission_id,value.client_submission_id);
  await clearDraft(value);
  assert.equal((await listDrafts()).find(x=>x.visit_id===value.visit_id),undefined);
});

test('transient photo failure leaves original draft and blobs intact', async () => {
  const value=draft('v-photo-fail');await saveDraft(value);
  globalThis.fetch=async()=>{throw new TypeError('offline');};
  await assert.rejects(uploadVerificationDraft(value),/暂时无法连接/);
  const stored=(await listDrafts()).find(x=>x.visit_id===value.visit_id);
  assert.equal(stored.photos.length,1);assert.equal(stored.photos[0].uploaded_id,undefined);
  assert.equal(await stored.photos[0].blob.text(),'image-bytes');
  await clearDraft(value);
});

test('verification failure preserves uploaded ids, then retries without duplicate upload', async () => {
  const value=draft('v-retry');await saveDraft(value);let calls=[];
  globalThis.fetch=async(path,options)=>{calls.push([path,options]);if(path.endsWith('/photos'))return Response.json(photoReceipt(value,'uploaded-1'));throw new TypeError('lost connection');};
  await assert.rejects(uploadVerificationDraft(value),/暂时无法连接/);
  const stored=(await listDrafts()).find(x=>x.visit_id===value.visit_id);
  assert.equal(stored.photos[0].uploaded_id,'uploaded-1');
  const stableKey=stored.client_submission_id;calls=[];
  globalThis.fetch=async(path,options)=>{calls.push([path,options]);return Response.json(verificationReceipt(stored,{id:'verification-1'}));};
  await uploadVerificationDraft(stored);
  assert.equal(calls.length,1);assert.ok(calls[0][0].endsWith('/verifications'));
  const payload=JSON.parse(calls[0][1].body);assert.equal(payload.client_submission_id,stableKey);assert.deepEqual(payload.photo_ids,['uploaded-1']);
  assert.equal((await listDrafts()).find(x=>x.visit_id===value.visit_id),undefined);
});

test('queued remote deletes are acknowledged before replacement photo uploads', async () => {
  const value=draft('v-replace');value.pending_delete_photo_ids=['old-photo'];await saveDraft(value);const calls=[];
  globalThis.fetch=async(path,options)=>{calls.push([path,options.method]);if(options.method==='DELETE')return new Response(null,{status:204});if(path.endsWith('/photos'))return Response.json(photoReceipt(value,'new-photo'));return Response.json(verificationReceipt(value,{id:'verification-2'}));};
  await uploadVerificationDraft(value);
  assert.deepEqual(calls.map(c=>c[1]),['DELETE','POST','POST']);assert.ok(calls[0][0].endsWith('/photos/old-photo'));
  assert.deepEqual(value.pending_delete_photo_ids,[]);
});

test('failed queued delete leaves queue and replacement blob available for retry', async () => {
  const value=draft('v-delete-fail');value.pending_delete_photo_ids=['old-photo'];await saveDraft(value);
  globalThis.fetch=async()=>Response.json({error:{message:'任务已完成，请查看已提交记录。'}},{status:409});
  await assert.rejects(uploadVerificationDraft(value),/任务已完成/);
  const stored=(await listDrafts()).find(x=>x.visit_id===value.visit_id);
  assert.deepEqual(stored.pending_delete_photo_ids,['old-photo']);assert.equal(stored.photos[0].uploaded_id,undefined);
  await clearDraft(value);
});

test('unconfirmed or mismatched verification does not clear draft', async () => {
  const value=draft('v-wrong-result');value.photos=[];await saveDraft(value);
  globalThis.fetch=async()=>Response.json({id:'wrong',visit_id:'other'});
  await assert.rejects(uploadVerificationDraft(value),/回执.*尚未确认/);
  assert.ok((await listDrafts()).find(x=>x.visit_id===value.visit_id));await clearDraft(value);
});

test('validation API errors include the relevant field', async () => {
  globalThis.fetch=async()=>Response.json({error:{message:'输入不符合约定',details:[{field:'body.geometry',message:'坐标环必须闭合'}]}},{status:422});
  await assert.rejects(api('/parcels'),error=>error instanceof ApiError&&error.status===422&&error.message.includes('body.geometry：坐标环必须闭合'));
});


test('cross-tab CAS rejects stale saves and preserves a newer draft on clear', async () => {
  const initial=draft('v-cas'); await saveDraft(initial);
  const tabA=structuredClone(initial), tabB=structuredClone(initial);
  tabB.note='来自另一个标签页的新备注'; await saveDraft(tabB);
  tabA.note='较旧标签页尝试覆盖';
  await assert.rejects(saveDraft(tabA),/另一页面已更新/);
  await assert.rejects(clearDraft(tabA),/新草稿已保留/);
  const stored=(await listDrafts()).find(x=>x.visit_id===initial.visit_id);
  assert.equal(stored.note,tabB.note);assert.equal(stored.revision,tabB.revision);
  await clearDraft(stored);
});

test('successful server result cannot delete another tab edit made during submission', async () => {
  const value=draft('v-race'); value.photos=[]; await saveDraft(value);
  globalThis.fetch=async()=>{
    const other=(await listDrafts()).find(x=>x.visit_id===value.visit_id);
    other.note='提交过程中保存的新草稿'; await saveDraft(other);
    return Response.json(verificationReceipt(value,{id:'verified-race'}));
  };
  await assert.rejects(uploadVerificationDraft(value),/提交已确认/);
  const stored=(await listDrafts()).find(x=>x.visit_id===value.visit_id);
  assert.equal(stored.note,'提交过程中保存的新草稿');await clearDraft(stored);
});
