import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { harness } from './helpers/ui-harness.mjs';

function historyUi(){
  const ui=harness({pathname:'/field'});Object.assign(ui.context,display);
  ui.run(`verifications=[
    {id:'old',visit_id:'v1',parcel_id:'p1',observed_at:'2026-10-17T12:30:00Z',created_at:'2026-10-17T14:00:00Z',label:'uncertain',note:'Earlier saved report',photo_ids:[]},
    {id:'backfill',visit_id:'v2',parcel_id:'p1',observed_at:'2025-10-18T12:30:00Z',created_at:'2026-10-18T13:00:00Z',label:'uncertain',note:'Newly saved historical observation',photo_ids:[]},
    {id:'other',visit_id:'v3',parcel_id:'p2',observed_at:'2026-10-18T12:30:00Z',created_at:'2026-10-18T12:50:00Z',label:'normal',note:'Other parcel report',photo_ids:[]}
  ];`);
  return ui;
}

test('admin and selected-parcel history keep newly saved backfills discoverable without changing stored order or observation dates',()=>{
  const ui=historyUi(),before=ui.run('JSON.stringify(verifications)');
  const admin=ui.run('recordsPanel()'),mobile=ui.run('fieldRecords()');
  for(const html of [admin,mobile]){
    assert.ok(html.indexOf('Newly saved historical observation')<html.indexOf('Earlier saved report'));
    assert.match(html,/最近保存优先/);assert.match(html,/本机时区/);
  }
  assert.match(admin,/Other parcel report/);assert.doesNotMatch(mobile,/Other parcel report/);
  assert.equal(ui.run('JSON.stringify(verifications)'),before);
});

test('record cards label full-year observation and save timestamps separately',()=>{
  const ui=historyUi(),html=ui.run('recordCard(verifications[1])');
  assert.match(html,/观察[^<]*2025/);assert.match(html,/保存[^<]*2026/);
  assert.match(html,/用户报告 · 非确诊/);assert.match(html,/未附现场照片/);
  assert.doesNotMatch(html,/观察[^<]*2026/);
  assert.equal(display.fmtTime('2025-10-18T12:30:00Z').includes('2025'),false,'other short update timestamps remain unchanged');
  assert.equal(display.fmtTime('2025-10-18T12:30:00Z',true).includes('2025'),true);
});

test('same save instants use observation time and id ties consistently, regardless of timestamp offset spelling',()=>{
  const ui=historyUi();ui.run(`verifications=[
    {...verifications[0],id:'z',created_at:'2026-10-18T12:00:00Z',observed_at:'2026-10-17T12:00:00Z'},
    {...verifications[0],id:'a',created_at:'2026-10-18T20:00:00+08:00',observed_at:'2026-10-17T12:00:00Z'},
    {...verifications[0],id:'newer-observation',created_at:'2026-10-18T12:00:00Z',observed_at:'2026-10-18T11:00:00Z'}
  ]`);
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(recentVerifications().map(v=>v.id))')),['newer-observation','a','z']);
});
