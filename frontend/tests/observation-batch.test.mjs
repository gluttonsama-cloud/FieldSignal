import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred } from './helpers/ui-harness.mjs';
import { esc } from '../src/display.ts';
import { observationBatchError, observationBatchReview, validateObservationBatchReceipt, observationBatchReceiptBody } from '../src/observation-batch.ts';
import { ApiError } from '../src/api.ts';
import { readFileSync } from 'node:fs';

const bundle = (count=3) => ({schema_version:1,bundle_id:'synthetic-batch',scope:'parcel',bundle_sha256:'a'.repeat(64),processing_version:'synthetic-v1',limitations:['Synthetic tests only; not real field evidence'],observations:Array.from({length:count},(_,i)=>({source:'manual',source_record_id:`synthetic-${i}`,observed_at:`2026-10-${String(i%18+1).padStart(2,'0')}T08:00:00+08:00`,features:{ndvi:i/1000},quality:{usable:i%2===0,valid_fraction:0.9,flags:[]},provenance:{provider:'Synthetic provider',collection:'test',item_id:`test-${i}`,processing_version:'synthetic-v1',usage_scope:'parcel',parcel_geometry_sha256:'b'.repeat(64)}}))});
const receipt = (body,parcelId='p1',existing=0) => ({id:'batch-test',parcel_id:parcelId,bundle_id:body.bundle_id,bundle_sha256:body.bundle_sha256,processing_version:body.processing_version,created_at:'2026-10-20T00:00:00Z',created_count:body.observations.length-existing,existing_count:existing,observations:body.observations.map((r,i)=>({id:`obs-${i}`,source:r.source,source_record_id:r.source_record_id,observed_at:new Date(r.observed_at).toISOString(),status:i<existing?'existing':'created'}))});
function batchUi() {
  const ui=harness(),calls=[];ui.context.esc=esc;
  const modalQuery=ui.modal.querySelector.bind(ui.modal);
  ui.modal.querySelector=selector=>ui.modal.form?.querySelector(selector)||modalQuery(selector);
  ui.context.post=async(path,body,key)=>{calls.push({path,body:structuredClone(body),key});return receipt(body);};
  return {...ui,calls};
}
function open(ui) {
  ui.run('observationModal()');const form=ui.modal.form,query=form.querySelector.bind(form);
  form.values.json='{"source":"manual"}';form.fields={hidden:false,disabled:false};form.actions={hidden:false};
  form.fileStatus={textContent:''};form.preview={textContent:''};form.choices={hidden:true,innerHTML:''};
  form.confirm={textContent:'Confirm',disabled:false};form.refreshStatus={textContent:''};
  form.panel={hidden:true,disabled:false,innerHTML:'',querySelector:()=>({focus(){}})};
  form.textarea={name:'json',get value(){return form.values.json;},set value(value){form.values.json=value;},closest:()=>form};
  form.fileInput={id:'observation-file',files:[],closest:()=>form};
  form.select={id:'observation-record',value:'',closest:()=>form,focus(){}};
  form.querySelector=selector=>({'#observation-fields':form.fields,'#observation-edit-actions':form.actions,'#observation-edit-submit':form.submit,'#observation-batch-panel':form.panel,'#observation-file-status':form.fileStatus,'#observation-preview':form.preview,'#observation-choices':form.choices,'textarea[name="json"]':form.textarea,'#observation-record':form.select,'#confirm-observation-batch':form.confirm,'#observation-batch-refresh':form.refreshStatus}[selector]||query(selector));
  return form;
}
async function choose(ui,form,body) {form.fileInput.files=[{name:'synthetic.json',size:JSON.stringify(body).length,text:async()=>JSON.stringify(body)}];await ui.modal.listeners.change({target:form.fileInput});}
async function reviewed(ui,body=bundle()) {const form=open(ui);await choose(ui,form,body);await ui.click('review-observation-batch');return form;}

test('file read and explicit full-batch review make no requests; complete fixed target and all rows are visible',async()=>{
  const ui=batchUi(),form=await reviewed(ui);assert.equal(ui.calls.length,0);
  assert.equal(form.fields.hidden,true);assert.equal(form.fields.disabled,true);assert.equal(form.actions.hidden,true);assert.equal(form.panel.hidden,false);
  assert.match(form.panel.innerHTML,/核对整批 3 条/);assert.match(form.panel.innerHTML,/固定目标地块：p1/);assert.match(form.panel.innerHTML,/synthetic-0/);assert.match(form.panel.innerHTML,/synthetic-2/);
  assert.match(form.panel.innerHTML,/不会自动运行分析/);assert.match(form.panel.innerHTML,/未独立核验|尚未.*核验|未.*认证|不是.*认证/);
  assert.equal(ui.run('observationBundles.get(modal.form).selected'),undefined);
});

test('explicit confirmation submits exact reviewed bundle to opening parcel and keeps acknowledged per-row receipt',async()=>{
  const ui=batchUi(),body=bundle(),form=await reviewed(ui,body);ui.run("selectedId='p2'");await ui.submit(form);
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].path,'/parcels/p1/observation-batches');assert.deepEqual(ui.calls[0].body,body);assert.ok(ui.calls[0].key);
  assert.match(form.panel.innerHTML,/整批导入已确认/);assert.match(form.panel.innerHTML,/新增 3 条/);assert.match(form.panel.innerHTML,/obs-2/);assert.equal(ui.modal.open,true);
  await ui.submit(form);assert.equal(ui.calls.length,1);
});

test('returning to single-record choice preserves existing JSON and selection, with no write',async()=>{
  const ui=batchUi(),form=open(ui);await choose(ui,form,bundle());form.select.value='1';await ui.modal.listeners.change({target:form.select});const json=form.values.json;
  await ui.click('review-observation-batch');await ui.click('edit-observation-batch');
  assert.equal(form.values.json,json);assert.equal(form.fields.disabled,false);assert.equal(form.fields.hidden,false);assert.equal(form.actions.hidden,false);assert.equal(form.panel.hidden,true);assert.equal(form.submit.disabled,false);assert.equal(ui.calls.length,0);
});

test('single-record submit is disabled during batch review and hidden styles override flex actions',async()=>{
  const ui=batchUi(),form=open(ui);await choose(ui,form,bundle());form.select.value='0';await ui.modal.listeners.change({target:form.select});assert.equal(form.submit.disabled,false);
  await ui.click('review-observation-batch');assert.equal(form.submit.disabled,true);assert.equal(form.actions.hidden,true);
  const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
  assert.match(css,/#observation-edit-actions\[hidden\][^{]*\{display:none!important\}/);
  assert.match(ui.modal.innerHTML,/id="observation-edit-submit"/);
});

test('double submit, return and file changes during upload cannot change the reviewed batch or send twice',async()=>{
  const ui=batchUi(),form=await reviewed(ui),pending=deferred();ui.context.post=async(path,body,key)=>{ui.calls.push({path,body,key});return pending.promise;};
  const saving=ui.submit(form);await ui.submit(form);await ui.click('edit-observation-batch');await choose(ui,form,bundle(1));form.select.value='1';await ui.modal.listeners.change({target:form.select});
  assert.equal(form.panel.disabled,true);assert.equal(form.fields.hidden,true);assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].body.observations.length,3);
  pending.resolve(receipt(ui.calls[0].body));await saving;assert.match(form.panel.innerHTML,/整批导入已确认/);
});

test('lost response keeps original batch and durable request identity for explicit manual retry',async()=>{
  const ui=batchUi(),form=await reviewed(ui);let fail=true;ui.context.post=async(path,body,key)=>{ui.calls.push({path,body:structuredClone(body),key});if(fail)throw new Error('Network lost');return receipt(body);};
  await ui.submit(form);assert.match(ui.modal.error.textContent,/原请求可能已经保存/);assert.doesNotMatch(form.panel.innerHTML,/整批导入已确认/);assert.equal(form.panel.disabled,false);
  fail=false;await ui.submit(form);assert.equal(ui.calls.length,2);assert.deepEqual(ui.calls[0],ui.calls[1]);assert.match(form.panel.innerHTML,/整批导入已确认/);assert.equal(ui.modal.error.hidden,true);
});

test('explicit server rejection reports atomic refusal and allows returning to retained choice',async()=>{
  const ui=batchUi(),form=await reviewed(ui);ui.context.post=async()=>{throw new ApiError(422,'第 2 条：边界不符');};await ui.submit(form);
  assert.match(ui.modal.error.textContent,/第 2 条/);assert.match(ui.modal.error.textContent,/本批未新增任何观测/);assert.doesNotMatch(ui.modal.error.textContent,/可能已经保存/);
  await ui.click('edit-observation-batch');assert.equal(form.panel.hidden,true);assert.equal(form.choices.hidden,false);
});

test('changed content or target after review blocks confirmation without sending',async()=>{
  for(const mutation of ["observationBundles.get(modal.form).bundle.observations[0].features.ndvi=.8","modal.form.dataset.parcel='p2'","++dialogSession"]){
    const ui=batchUi(),form=await reviewed(ui);ui.run(mutation);await ui.submit(form);assert.equal(ui.calls.length,0);assert.match(ui.modal.error.textContent,/本次没有发送/);
  }
});

for(const success of [true,false])test(`late batch ${success?'success':'failure'} cannot overwrite a replacement form`,async()=>{
  const ui=batchUi(),form=await reviewed(ui),pending=deferred();ui.context.post=async()=>pending.promise;const saving=ui.submit(form);
  ui.run('closeModal()');const replacement=open(ui),replacementHtml=ui.modal.innerHTML;
  if(success)pending.resolve(receipt(bundle()));else pending.reject(new Error('Delayed network loss'));await saving;
  assert.equal(ui.modal.form,replacement);assert.equal(ui.modal.innerHTML,replacementHtml);assert.equal(replacement.panel.innerHTML,'');assert.equal(ui.modal.error.hidden,true);assert.match(ui.toast.textContent,/先前批次/);
});

test('acknowledged import survives later refresh failure and never asks to resubmit',async()=>{
  const ui=batchUi(),form=await reviewed(ui);ui.run("refresh=async()=>{throw new Error('Refresh failed')}");await ui.submit(form);
  assert.match(form.panel.innerHTML,/整批导入已确认/);assert.match(form.refreshStatus.textContent,/导入已确认.*列表未能刷新/);assert.doesNotMatch(form.refreshStatus.textContent,/原样重试/);
  await ui.submit(form);assert.equal(ui.calls.length,1);
});

test('malformed or mismatched success response is uncertain rather than falsely acknowledged',async()=>{
  const ui=batchUi(),form=await reviewed(ui);ui.context.post=async()=>({...receipt(bundle()),parcel_id:'p2'});await ui.submit(form);
  assert.doesNotMatch(form.panel.innerHTML,/整批导入已确认/);assert.match(ui.modal.error.textContent,/导入结果尚未确认/);assert.match(ui.modal.error.textContent,/原样手动重试/);
});

test('receipt validation checks parcel, batch, all ordered source identities, exact times and accounting',()=>{
  const body=bundle();assert.equal(validateObservationBatchReceipt(receipt(body,'p1',1),'p1',body).existing_count,1);
  const mutations=[r=>r.id='',r=>r.parcel_id='p2',r=>r.bundle_id='other',r=>r.bundle_sha256='c'.repeat(64),r=>r.processing_version='other',r=>r.created_at='bad',r=>r.created_count=2,r=>r.existing_count=-1,r=>r.observations.pop(),r=>r.observations.reverse(),r=>r.observations[0].observed_at='2026-10-02T00:00:00Z',r=>r.observations[0].id=r.observations[1].id,r=>r.observations[0].status='unknown',r=>r.observations[0].observed_at=[r.observations[0].observed_at]];
  for(const mutate of mutations){const value=receipt(body);mutate(value);assert.throws(()=>validateObservationBatchReceipt(value,'p1',body),/尚未确认/);}
});

test('receipt validation follows server whitespace normalization without weakening content identity',()=>{
  const body=bundle(1);body.bundle_id='  synthetic-batch  ';body.processing_version='  synthetic-v1  ';body.observations[0].source_record_id='  synthetic-0  ';
  const result=receipt(body);result.bundle_id='synthetic-batch';result.processing_version='synthetic-v1';result.observations[0].source_record_id='synthetic-0';
  assert.equal(validateObservationBatchReceipt(result,'p1',body),result);
  result.observations[0].source_record_id='synthetic-1';assert.throws(()=>validateObservationBatchReceipt(result,'p1',body),/尚未确认/);
});

test('receipt time comparison preserves microseconds while accepting equivalent explicit timezone offsets',()=>{
  const body=bundle(1);body.observations[0].observed_at='2026-10-01T08:00:00.123456+08:00';
  const result=receipt(body);result.observations[0].observed_at='2026-10-01T00:00:00.123456Z';
  assert.equal(validateObservationBatchReceipt(result,'p1',body),result);
  result.observations[0].observed_at='2026-10-01T00:00:00.123999Z';
  assert.throws(()=>validateObservationBatchReceipt(result,'p1',body),/尚未确认/);
  body.observations[0].observed_at='2026-10-01T08:00:00.1+08:00';result.observations[0].observed_at='2026-10-01T00:00:00.100000Z';
  assert.equal(validateObservationBatchReceipt(result,'p1',body),result);
  body.observations[0].observed_at='2026-10-01T08:00:00.1234569+08:00';result.observations[0].observed_at='2026-10-01T00:00:00.123456Z';
  assert.equal(validateObservationBatchReceipt(result,'p1',body),result);
  for(const text of ['2026-10-01 08:00:00.123456+08:00','2026-10-01T08:00:00.123456+0800']){
    body.observations[0].observed_at=text;assert.equal(observationBatchError(body),'');assert.equal(validateObservationBatchReceipt(result,'p1',body),result);
  }
  body.observations[0].observed_at='2026-10-01';assert.match(observationBatchError(body),/第 1 条的时间/);
});

test('batch limits do not silently truncate; duplicates require correction; 101 rows are supported',async()=>{
  assert.equal(observationBatchError(bundle(101)),'');assert.match(observationBatchError(bundle(501)),/最多 500/);
  const duplicate=bundle();duplicate.observations[1].source_record_id=duplicate.observations[0].source_record_id;assert.match(observationBatchError(duplicate),/第 2 条/);
  const large=bundle();large.limitations=['文'.repeat(400000)];assert.match(observationBatchError(large),/1 MiB/);
  for(const body of [bundle(501),duplicate]){const ui=batchUi(),form=open(ui);await choose(ui,form,body);await ui.click('review-observation-batch');assert.equal(form.panel.hidden,true);assert.equal(ui.calls.length,0);assert.equal(ui.modal.error.hidden,false);}
});

test('review and receipts escape all supplied labels and preserve quality limitations',()=>{
  const body=bundle(1),danger='<img src=x onerror=alert(1)>';body.bundle_id=danger;body.limitations=[danger];body.observations[0].source_record_id=danger;
  const reviewed=observationBatchReview(body,{id:'p1',name:danger,season:danger}),saved=observationBatchReceiptBody(receipt(body));
  for(const html of [reviewed,saved]){assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);}
  assert.match(reviewed,/文件声明/);assert.match(reviewed,/不.*认证/);assert.match(saved,/未独立核验/);
});
