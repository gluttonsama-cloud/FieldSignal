import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred } from './helpers/ui-harness.mjs';
import { syntheticRecordReceipt } from './helpers/record-receipts.mjs';

const polygon={type:'Polygon',coordinates:[[[112,30],[112.01,30],[112.01,30.01],[112,30]]]};
function open(type){
  const ui=harness({pathname:'/field'});
  ui.run("visits=[{id:'v1',parcel_id:'p1',risk_id:'risk-original',note:'Original task prompt',status:'pending',due_date:'2026-10-18',assignee:'Original label',plan_revision:2,created_at:'2026-10-18T00:00:00.123456Z'}];visitFilters={timing:'overdue',assignee:'',parcelId:''};fieldTab='parcels';");
  const original=ui.run('structuredClone(visits[0])');
  ui.run(type==='parcel'?'parcelModal()':type==='visit'?'visitModal()':type==='plan'?"visitPlanModal('v1')":'eventModal()');
  const form=ui.modal.form;
  Object.assign(form.values,type==='parcel'?{name:'Synthetic parcel',region:'other',season:'2026-2027',geometry:JSON.stringify(polygon),sowing_date:'',cultivar:''}:type==='event'?{occurred_on:'2026-10-18',kind:'drainage',note:'Synthetic event'}:{due_date:'2026-10-20',assignee:'New label',note:'Synthetic task'});
  return {ui,form,original};
}
for(const type of ['parcel','visit','plan','event']){
  test(`${type}: invalid receipt preserves exact manual retry, no success side effects, then accepts bound acknowledgment`,async()=>{
    const {ui,form,original}=open(type),calls=[],before=structuredClone(form.values),state=ui.run('JSON.stringify([selectedId,visits,visitFilters,fieldTab])');let malformed=true;
    ui.context.post=async(path,body,key)=>{calls.push({path,body:structuredClone(body),key});return malformed?{}:syntheticRecordReceipt(path,body,'saved-record',original);};
    await ui.submit(form);
    assert.equal(ui.modal.open,true);assert.equal(ui.modal.form,form);assert.deepEqual(form.values,before);assert.equal(form.submit.disabled,false);
    assert.match(ui.modal.error.textContent,/原记录可能已经保存/);assert.equal(ui.run('JSON.stringify([selectedId,visits,visitFilters,fieldTab])'),state);
    assert.doesNotMatch(ui.toast.textContent,/已保存|已确认|已录入/);
    malformed=false;await ui.submit(form);assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].body,calls[1].body);
    assert.equal(ui.modal.open,false);assert.match(ui.toast.textContent,/已保存|已确认|已录入/);
  });
  test(`${type}: wrong submitted fields or target are not acknowledged despite an ID and successful transport`,async()=>{
    for(const corrupt of [value=>({...value,id:''}),value=>({...value,created_at:'2026-02-30T00:00:00Z'}),value=>({...value,[type==='parcel'?'name':type==='visit'?'parcel_id':type==='plan'?'id':'parcel_id']:'other-target'}),value=>({...value,[type==='parcel'?'season':type==='visit'?'due_date':type==='plan'?'assignee':'note']:'different-content'})]){
      const {ui,form,original}=open(type);const before=ui.run('JSON.stringify([selectedId,visits,visitFilters,fieldTab])');
      ui.context.post=async(path,body)=>corrupt(syntheticRecordReceipt(path,body,'saved-record',original));
      await ui.submit(form);assert.equal(ui.modal.open,true);assert.equal(ui.modal.form,form);assert.match(ui.modal.error.textContent,/原记录可能已经保存/);
      assert.equal(ui.run('JSON.stringify([selectedId,visits,visitFilters,fieldTab])'),before);
    }
  });
}

test('plan receipt binds immutable identity to the opened task snapshot, not a refreshed task cache',async()=>{
  const {ui,form,original}=open('plan'),pending=deferred();let request;
  ui.context.post=async(path,body)=>{request={path,body};return pending.promise;};
  const saving=ui.submit(form);
  ui.run("visits[0]={...visits[0],risk_id:'different-cache-risk',note:'Different cache note',plan_revision:5};");
  pending.resolve(syntheticRecordReceipt(request.path,request.body,'v1',original));await saving;
  assert.equal(ui.modal.open,false);assert.match(ui.toast.textContent,/保留当前已读取的较新任务状态/);assert.equal(ui.run('visits[0].plan_revision'),5);
  assert.equal(ui.run('visits[0].risk_id'),'different-cache-risk');
});

test('plan immutable mismatch never overwrites the original task, and tampered form identity sends nothing',async()=>{
  for(const field of ['risk_id','note','created_at']){
    const {ui,form,original}=open('plan'),before=ui.run('JSON.stringify(visits)');
    ui.context.post=async(path,body)=>({...syntheticRecordReceipt(path,body,'v1',original),[field]:field==='created_at'?'2026-10-19T00:00:00Z':'changed immutable'});
    await ui.submit(form);assert.equal(ui.modal.open,true);assert.equal(ui.run('JSON.stringify(visits)'),before);
  }
  const {ui,form}=open('plan');form.dataset.visit='other-task';ui.context.post=()=>assert.fail('changed form identity must not send');
  await ui.submit(form);assert.equal(ui.modal.open,true);assert.match(ui.modal.error.textContent,/本次没有发送/);assert.doesNotMatch(ui.modal.error.textContent,/原记录可能已经保存/);
});

test('visit and event inputs lock only after the payload snapshot, and unlock on an unacknowledged response',async()=>{
  for(const type of ['visit','event']){
    const {ui,form}=open(type),pending=deferred();let sent;
    ui.context.FormData=class{constructor(f){this.values=f.recordFields.disabled?{}:{...f.values};}get(key){return this.values[key]??null;}};
    ui.context.post=async(path,body)=>{sent=structuredClone(body);return pending.promise;};
    const saving=ui.submit(form);assert.equal(form.recordFields.disabled,true);assert.equal(form.submit.disabled,true);
    assert.equal(sent.note,form.values.note);assert.match(ui.modal.innerHTML,/<fieldset id="record-fields">/);
    pending.resolve({});await saving;assert.equal(form.recordFields.disabled,false);assert.equal(form.submit.disabled,false);assert.equal(ui.modal.open,true);
  }
});

test('late malformed receipt stays outside a replacement form and cannot reset newer filters',async()=>{
  const {ui,form}=open('visit'),pending=deferred();ui.context.post=async()=>pending.promise;const saving=ui.submit(form);
  await ui.click('close-dialog');ui.run('eventModal()');const replacement=ui.modal.form;
  ui.run("visitFilters={timing:'today',assignee:'name:New label',parcelId:'p2'}");pending.resolve({});await saving;
  assert.equal(ui.modal.form,replacement);assert.equal(ui.modal.error.hidden,true);assert.equal(ui.run('visitFilters.timing'),'today');assert.match(ui.toast.textContent,/先前表单保存未确认/);
});

test('a validated save remains confirmed when the subsequent page refresh throws',async()=>{
  for(const type of ['parcel','visit','plan','event']){
    const {ui,form,original}=open(type);
    ui.context.post=async(path,body)=>syntheticRecordReceipt(path,body,'saved-record',original);
    ui.run("refresh=async()=>{throw new Error('Synthetic page update failed')}");
    await ui.submit(form);assert.equal(ui.modal.open,false);
    assert.match(ui.toast.textContent,/保存已确认/);assert.match(ui.toast.textContent,/手动刷新/);
    assert.doesNotMatch(ui.toast.textContent,/保存未确认|原记录可能/);
  }
});
