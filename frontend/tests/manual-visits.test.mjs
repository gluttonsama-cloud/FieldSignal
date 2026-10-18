import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred } from './helpers/ui-harness.mjs';
import * as display from '../src/display.ts';

function visitUi() {
  const ui=harness({pathname:'/field'}),calls=[];
  Object.assign(ui.context,display,{boundaryMap:()=>'<span>Boundary preview</span>',trend:()=>'<span>No observations</span>'});
  ui.run("dashboard.parcels.forEach(p=>{p.season='2026-2027';p.region='other';p.area_ha=1}); risks=[];visits=[];observations=[];connected=true;fieldTab='parcels'");
  ui.context.post=async(path,body,key)=>{calls.push({path,body:structuredClone(body),key});return {id:'visit-new'};};
  return {...ui,calls};
}
function fill(ui) {
  const form=ui.modal.form;
  Object.assign(form.values,{due_date:'2026-10-18',assignee:'',note:'Routine field walk'});
  return form;
}

test('a parcel with no observations or candidates has a reachable routine-visit entry', async()=>{
  const ui=visitUi();
  assert.match(ui.run('fieldVisits()'),/选择地块并安排巡田/);
  assert.match(ui.run('fieldVisits()'),/无需等待遥感观测或异常候选/);
  assert.match(ui.run('fieldParcels()'),/data-action="new-routine-visit"/);
  await ui.click('new-routine-visit');
  assert.equal(ui.modal.form.id,'visit-form');
  assert.equal(ui.modal.form.dataset.parcel,'p1');
  assert.equal(ui.modal.form.dataset.risk,undefined);
  assert.match(ui.modal.innerHTML,/不关联异常候选/);
  assert.match(ui.modal.innerHTML,/种植季 2026-2027/);
  assert.match(ui.modal.innerHTML,/name="due_date"[^>]+required/);
  assert.match(ui.modal.innerHTML,/手动提交核查/);
  assert.equal(ui.calls.length,0);
  ui.run("selectedId='missing'");await ui.click('close-dialog');await ui.click('new-routine-visit');
  assert.equal(ui.modal.open,false,'no parcel must not create a targetless form');
});

test('routine submission is fixed to the displayed parcel and returns mobile to tasks',async()=>{
  const ui=visitUi();await ui.click('new-routine-visit');const form=fill(ui);
  ui.run("selectedId='p2';risks=[{id:'r2',parcel_id:'p2'}]");
  await ui.submit(form);
  assert.equal(ui.calls.length,1);
  assert.equal(ui.calls[0].path,'/visits');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0].body)),{parcel_id:'p1',risk_id:null,due_date:'2026-10-18',assignee:null,note:'Routine field walk'});
  assert.match(ui.calls[0].key,/^[0-9a-f-]{36}$/);
  assert.equal(ui.run('fieldTab'),'visits');
  assert.equal(ui.run('selectedId'),'p2');
});

test('candidate visit keeps its actual opening association even after the risk cache changes',async()=>{
  const ui=visitUi();ui.run("risks=[{id:'r1',parcel_id:'p1',summary:'Observed change'}]");
  await ui.click('new-visit',{id:'r1'});const form=fill(ui);
  assert.match(ui.modal.innerHTML,/异常候选核查/);
  ui.run("risks=[];selectedId='p2'");
  await ui.submit(form);
  assert.equal(ui.calls[0].body.parcel_id,'p1');assert.equal(ui.calls[0].body.risk_id,'r1');
  assert.match(ui.calls[0].key,/^[0-9a-f-]{36}$/);
});

test('routine request failures retain content and reuse exact request identity on manual retry',async()=>{
  const ui=visitUi();await ui.click('new-routine-visit');const form=fill(ui);
  ui.context.post=async(path,body,key)=>{ui.calls.push({path,body:structuredClone(body),key});throw new TypeError('Response lost');};
  await ui.submit(form);assert.equal(ui.modal.open,true);assert.equal(form.submit.disabled,false);
  assert.match(ui.modal.error.textContent,/原记录可能已经保存/);
  await ui.submit(form);
  assert.equal(ui.calls[0].key,ui.calls[1].key);
  form.values.note='Changed task';await ui.submit(form);assert.notEqual(ui.calls[2].key,ui.calls[0].key);
  form.values.note='Routine field walk';await ui.submit(form);assert.equal(ui.calls[3].key,ui.calls[0].key);
  assert.equal(ui.run('fieldTab'),'parcels');
});

test('in-flight duplicate submit is gated and late completion leaves a replacement form untouched',async()=>{
  const ui=visitUi(),pending=deferred();await ui.click('new-routine-visit');const form=fill(ui);
  ui.context.post=async(path,body,key)=>{ui.calls.push({path,body,key});return pending.promise;};
  const done=ui.submit(form);await ui.submit(form);assert.equal(ui.calls.length,1);
  await ui.click('close-dialog');ui.run("selectedId='p2'");await ui.click('new-routine-visit');
  const replacement=fill(ui);replacement.values.note='Do not overwrite';
  pending.resolve({id:'old-visit'});await done;
  assert.equal(ui.modal.open,true);assert.equal(ui.modal.form,replacement);
  assert.equal(replacement.values.note,'Do not overwrite');assert.equal(ui.run('fieldTab'),'parcels');
});

test('pending-task notice and task cards distinguish routine visits from candidate checks',async()=>{
  const ui=visitUi();ui.run("visits=[{id:'v1',parcel_id:'p1',risk_id:null,status:'pending',due_date:'2026-10-18'},{id:'v2',parcel_id:'p2',status:'pending'}]");
  await ui.click('new-routine-visit');assert.match(ui.modal.innerHTML,/已有 1 个待完成任务/);
  assert.match(ui.run('visitCard(visits[0])'),/自主巡田 · 未关联异常候选/);
  assert.match(ui.run("visitCard({...visits[0],risk_id:'not-loaded'})"),/异常候选核查/);
  assert.match(ui.run("recordCard({visit_id:'v1',parcel_id:'p1',photo_ids:[]})"),/自主巡田 · 未关联异常候选/);
  assert.match(ui.run("recordCard({visit_id:'missing',parcel_id:'p1',photo_ids:[]})"),/巡田来源待读取/);
  assert.equal(ui.calls.length,0);
});
