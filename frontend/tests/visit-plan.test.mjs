import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api.ts';
import * as display from '../src/display.ts';
import { harness, deferred } from './helpers/ui-harness.mjs';

function planUi(){
  const ui=harness({pathname:'/field'}),calls=[];
  Object.assign(ui.context,display,{post:async(path,body,key)=>{calls.push({path,body:structuredClone(body),key});return {...ui.run('visits[0]'),...body,plan_revision:1};},saveDraft:()=>{throw new Error('Plan edit must not write a field draft');}});
  ui.run("visits=[{id:'v1',parcel_id:'p1',risk_id:'r1',status:'pending',due_date:'2026-10-18',assignee:'Original person',note:'Original candidate prompt',created_at:'2026-10-18T00:00:00Z'},{id:'v2',parcel_id:'p2',status:'pending',due_date:'2026-10-19',plan_revision:7}];drafts=[{visit_id:'v1',note:'Unsaved field report',client_submission_id:'unchanged-draft',revision:5,photos:[]}]");
  return {...ui,calls};
}
function fill(ui){const form=ui.modal.form;Object.assign(form.values,{due_date:'2025-01-01',assignee:'Corrected person'});return form;}

test('pending plan editing is reachable on both task views, scoped to its original task and independent of field evidence',async()=>{
  const ui=planUi(),drafts=ui.run('JSON.stringify(drafts)');
  for(const field of [true,false])assert.match(ui.run(`visitCard(visits[0],${field})`),/data-action="edit-visit-plan"/);
  assert.doesNotMatch(ui.run("visitCard({...visits[0],status:'completed'})"),/data-action="edit-visit-plan"/);
  await ui.click('edit-visit-plan',{id:'v1'});const form=fill(ui);
  assert.equal(form.dataset.visit,'v1');assert.equal(form.dataset.revision,'0');assert.match(ui.modal.innerHTML,/种植季 2026-2027/);
  assert.match(ui.modal.innerHTML,/原核查提示：Original candidate prompt（保持不变）/);assert.doesNotMatch(ui.modal.innerHTML,/name="note"/);assert.match(ui.modal.innerHTML,/不发送通知/);
  ui.run("selectedId='p2'");await ui.submit(form);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0].body)),{expected_revision:0,due_date:'2025-01-01',assignee:'Corrected person'});
  assert.equal(ui.calls[0].path,'/visits/v1/plan');assert.match(ui.calls[0].key,/^[0-9a-f-]{36}$/);
  assert.equal(ui.run('selectedId'),'p2');assert.equal(ui.run('visits[0].risk_id'),'r1');assert.equal(ui.run('visits[0].note'),'Original candidate prompt');assert.equal(ui.run('JSON.stringify(drafts)'),drafts);
  ui.run("visits[0].status='completed'");await ui.click('edit-visit-plan',{id:'v1'});assert.equal(ui.modal.open,false);assert.match(ui.toast.textContent,/计划只读/);
});

test('uncertain result reuses the exact request key; a conflict retains input and requires fresh reading without overriding',async()=>{
  const ui=planUi();await ui.click('edit-visit-plan',{id:'v1'});const form=fill(ui);
  ui.context.post=async(path,body,key)=>{ui.calls.push({path,body,key});throw new TypeError('Response lost');};
  await ui.submit(form);await ui.submit(form);assert.equal(ui.calls[0].key,ui.calls[1].key);assert.equal(form.submit.disabled,false);assert.match(ui.modal.error.textContent,/原记录可能已经保存/);
  form.values.assignee='Another person';await ui.submit(form);assert.notEqual(ui.calls[2].key,ui.calls[0].key);
  ui.context.post=async()=>{throw new ApiError(409,'此巡田计划已有更新。请关闭表单、刷新任务，再重新打开核对。');};
  await ui.submit(form);assert.equal(ui.modal.open,true);assert.equal(ui.modal.form,form);assert.equal(form.values.assignee,'Another person');assert.equal(form.dataset.revision,'0');assert.equal(ui.run('visits[0].assignee'),'Original person');assert.match(ui.modal.error.textContent,/刷新任务/);
});

test('duplicate clicks do not double update and a late response cannot close or overwrite a replacement plan editor',async()=>{
  const ui=planUi(),pending=deferred();await ui.click('edit-visit-plan',{id:'v1'});const old=fill(ui);
  ui.context.post=async(path,body,key)=>{ui.calls.push({path,body,key});return pending.promise;};
  const saving=ui.submit(old);await ui.submit(old);assert.equal(ui.calls.length,1);
  await ui.click('close-dialog');await ui.click('edit-visit-plan',{id:'v2'});const replacement=fill(ui);replacement.values.assignee='Do not change';
  pending.resolve({...ui.run('visits[0]'),assignee:'Corrected person',plan_revision:1});await saving;
  assert.equal(ui.modal.open,true);assert.equal(ui.modal.form,replacement);assert.equal(replacement.values.assignee,'Do not change');assert.equal(replacement.dataset.revision,'7');assert.equal(ui.run('visits[1].plan_revision'),7);
});

test('a late plan response cannot downgrade a newer or completed task when the following refresh fails',async()=>{
  for(const [status,revision] of [['pending',2],['completed',1],['completed',0]]){
    const ui=planUi(),pending=deferred();await ui.click('edit-visit-plan',{id:'v1'});const form=fill(ui);
    const oldResult={...ui.run('visits[0]'),assignee:'Earlier saved person',plan_revision:1};
    ui.context.post=async()=>pending.promise;const saving=ui.submit(form);await ui.click('close-dialog');
    ui.context.newer={...oldResult,status,plan_revision:revision,assignee:'Latest confirmed person'};
    ui.run("visits[0]=newer;refresh=async()=>{loadError='offline';}");
    pending.resolve(oldResult);await saving;
    assert.equal(ui.run('visits[0].status'),status);assert.equal(ui.run('visits[0].plan_revision'),revision);assert.equal(ui.run('visits[0].assignee'),'Latest confirmed person');
    assert.match(ui.toast.textContent,/保留当前已读取的较新任务状态/);
    if(status==='completed')assert.equal(ui.run("pendingVisits().some(v=>v.id==='v1')"),false);
  }
});
