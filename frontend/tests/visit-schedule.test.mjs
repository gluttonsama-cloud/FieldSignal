import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { harness } from './helpers/ui-harness.mjs';

function taskUi(){
  const ui=harness({pathname:'/field'});Object.assign(ui.context,display,{today:()=> '2026-10-18'});
  ui.run(`dashboard.parcels.forEach(p=>Object.assign(p,{region:'other',season:'2026-2027',area_ha:1}));risks=[];drafts=[];
    visits=[
      {id:'future',parcel_id:'p1',status:'pending',due_date:'2026-10-25',created_at:'2026-10-01T00:00:00Z',note:'Future task'},
      {id:'today',parcel_id:'p1',status:'pending',due_date:'2026-10-18',created_at:'2026-10-02T00:00:00Z',note:'Today task'},
      {id:'past',parcel_id:'p2',status:'pending',due_date:'2026-10-15',created_at:'2026-10-03T00:00:00Z',note:'Past plan task'},
      {id:'done',parcel_id:'p2',status:'completed',due_date:'2026-10-10',created_at:'2026-10-04T00:00:00Z',note:'Completed task'}
    ];`);
  return ui;
}

test('mobile and admin pending lists order by plan day, not creation time, without mutating stored records',()=>{
  const ui=taskUi();ui.run("risks=[{id:'future-risk',parcel_id:'p1',priority:'high',status:'assigned',summary:'Synthetic change',evidence:{limitations:[]}}];visits[0].risk_id='future-risk'");const before=ui.run('JSON.stringify(visits)');
  for(const html of [ui.run('fieldVisits()'),ui.run('riskPanel()')]){
    assert.ok(html.indexOf('Past plan task')<html.indexOf('Today task'));
    assert.ok(html.indexOf('Today task')<html.indexOf('Future task'));
    assert.doesNotMatch(html,/Completed task/);
    assert.match(html,/按计划日期/);assert.match(html,/不代表农情严重程度/);
  }
  assert.equal(ui.run('JSON.stringify(visits)'),before);
});

test('plan timing is a separate label from candidate priority and routine visit origin',()=>{
  const ui=taskUi();ui.run("risks=[{id:'high-risk',parcel_id:'p1',priority:'high'}]");
  const past=ui.run("visitCard(visits.find(v=>v.id==='past'))"),today=ui.run("visitCard({...visits[1],risk_id:'high-risk'})"),future=ui.run('visitCard(visits[0])');
  assert.match(past,/已过计划日.*2026\/10\/15/);assert.match(past,/自主巡田 · 未关联异常候选/);
  assert.doesNotMatch(past,/优先核查/);
  assert.match(today,/计划今天.*2026\/10\/18/);assert.match(today,/优先核查/);assert.match(today,/异常候选核查/);
  assert.doesNotMatch(future,/已过计划日|计划今天/);
  assert.match(ui.run('fieldVisits()'),/本机日期/);
});

test('same-day order is deterministic and missing plan dates are never labelled overdue',()=>{
  const ui=taskUi();ui.run("visits=[{id:'z',parcel_id:'p1',status:'pending',due_date:'2026-10-18',created_at:'2026-10-01T00:00:00Z'},{id:'a',parcel_id:'p1',status:'pending',due_date:'2026-10-18',created_at:'2026-10-01T00:00:00Z'},{id:'old',parcel_id:'p1',status:'pending',due_date:'2026-10-18',created_at:'2026-09-01T00:00:00Z'},{id:'unknown',parcel_id:'p1',status:'pending'}]");
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(pendingVisits().map(v=>v.id))')),['old','a','z','unknown']);
  assert.doesNotMatch(ui.run('visitCard(visits[3])'),/已过计划日|计划今天/);
});
