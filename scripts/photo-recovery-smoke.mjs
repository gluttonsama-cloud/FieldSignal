// Production sync and UI handlers against the smoke test's isolated local API.
// IndexedDB/DOM are controlled test boundaries, not browser or device validation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { saveDraft,listDrafts } from '../frontend/src/drafts.ts';
import { uploadVerificationDraft } from '../frontend/src/sync.ts';
import { harness } from '../frontend/tests/helpers/ui-harness.mjs';
createRequire(new URL('../frontend/package.json',import.meta.url))('fake-indexeddb/auto');
globalThis.window={indexedDB:globalThis.indexedDB};
const x=JSON.parse(readFileSync(0,'utf8'));
assert.match(x.base,/^http:\/\/127\.0\.0\.1:\d+$/);
const nativeFetch=globalThis.fetch,calls=[];
globalThis.fetch=(path,options={})=>{
 assert.ok(String(path).startsWith('/api/v1/'));
 calls.push({path,method:options.method||'GET'});
 return nativeFetch(x.base+path,options);
};
const draft={visit_id:x.visit.id,parcel_id:x.parcel.id,parcel_name:x.parcel.name,parcel_season:x.parcel.season,data_origin:x.parcel.data_origin,client_submission_id:'http-duplicate-photo-recovery',observed_at:'2020-03-30T12:00:00Z',label:'uncertain',note:'Synthetic duplicate photo recovery only',photos:x.images.map((image,index)=>({key:`image-${index}`,name:`synthetic-${index}.png`,blob:new Blob([Buffer.from(image,'base64')],{type:'image/png'})})),state:'draft',updated_at:'2020-03-30T12:00:00Z'};
assert.notDeepEqual(await draft.photos[0].blob.arrayBuffer(),await draft.photos[1].blob.arrayBuffer(),'PNG metadata differs before canonical processing');
await saveDraft(draft);
await assert.rejects(uploadVerificationDraft(draft),/同一张图片.*移除重复照片/);
assert.equal(calls.length,2);assert.ok(calls.every(call=>call.path.endsWith('/photos')));
const resumed=(await listDrafts()).find(value=>value.visit_id===draft.visit_id);
assert.ok(resumed);assert.equal(resumed.photos[0].uploaded_id,resumed.photos[1].uploaded_id);
const photoId=resumed.photos[0].uploaded_id;
const ui=harness({pathname:'/field'});
Object.assign(ui.context,{saved:resumed,parcel:x.parcel,visit:x.visit,saveDraft,listDrafts,uploadVerificationDraft});
ui.run('dashboard.parcels=[parcel];visits=[visit];selectedId=parcel.id;currentDraft=saved;verificationModal()');
await ui.click('remove-photo',{id:'image-1'});
assert.equal(resumed.photos.length,1);assert.deepEqual(Array.from(resumed.pending_delete_photo_ids||[]),[]);
// A legacy version could have queued this still-referenced ID. Reconciliation
// must save the corrected queue before any remote operation and keep the image.
resumed.pending_delete_photo_ids=[photoId];await saveDraft(resumed);
await ui.submit();
assert.equal(ui.modal.open,false);assert.equal(calls.length,3);
assert.equal(calls[2].method,'POST');assert.ok(calls[2].path.endsWith('/verifications'));
assert.equal((await listDrafts()).some(value=>value.visit_id===draft.visit_id),false);
const record=ui.run('verifications[0]');
assert.deepEqual(Array.from(record.photo_ids),[photoId]);
const photoResponse=await nativeFetch(x.base+'/api/v1/photos/'+encodeURIComponent(photoId));
assert.equal(photoResponse.status,200);
assert.ok((await photoResponse.arrayBuffer()).byteLength>0);
process.stdout.write(JSON.stringify({duplicate_normalized_image_detected:true,no_automatic_photo_deduplication:true,remove_one_keeps_shared_photo:true,legacy_delete_queue_reconciled:true,final_verification_photo_count:1,server_photo_retained:true,draft_cleared_after_valid_receipt:true,network_methods:calls.map(call=>call.method),browser_verified:false})+'\n');
