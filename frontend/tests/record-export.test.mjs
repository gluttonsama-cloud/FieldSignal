import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { verificationCsv } from '../src/record-export.ts';
import * as display from '../src/display.ts';
import { harness } from './helpers/ui-harness.mjs';

const record={id:'r1',visit_id:'v1',parcel_id:'p1',observed_at:'2025-10-18T12:34:56.123456+08:00',created_at:'2026-10-18T10:00:00.654321Z',label:'uncertain',note:'油菜, "现场"\r\n第二行',photo_ids:['private-photo-id'],client_submission_id:'private-retry-id'};
const parcels=[{id:'p1',name:'一号田',season:'2025-2026',data_origin:'fixture'}];
function parse(csv){
  assert.equal(csv.charCodeAt(0),0xFEFF);
  const rows=[];let row=[],value='',quoted=false;
  for(let i=1;i<csv.length;i++){
    const c=csv[i];
    if(c==='"'){if(quoted&&csv[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&c===','){row.push(value);value='';}
    else if(!quoted&&c==='\r'&&csv[i+1]==='\n'){row.push(value);rows.push(row);row=[];value='';i++;}
    else value+=c;
  }
  assert.equal(quoted,false);assert.equal(value,'');assert.deepEqual(row,[]);return rows;
}

test('CSV is an explicit projection with exact API timestamps, Chinese/multiline text and no photo or retry identities',()=>{
  const input=structuredClone(record),before=JSON.stringify(input);
  const csv=verificationCsv([input],parcels,display.labels,'全部已加载地块','已加载快照，不保证全库完整。'),rows=parse(csv);
  assert.equal(rows.length,2);assert.equal(rows[0].length,15);assert.equal(rows[1].length,15);
  assert.deepEqual(rows[1],['全部已加载地块','已加载快照，不保证全库完整。','r1','v1','p1','一号田','2025-2026','开发模拟数据',record.observed_at,record.created_at,'uncertain','暂不能判断','人工现场报告，未经裁定，非确诊',record.note,'1']);
  assert.equal(JSON.stringify(input),before);assert.doesNotMatch(csv,/private-photo-id|private-retry-id|photo_ids|client_submission_id/);
  const origins=parse(verificationCsv([{...record,parcel_id:'user'},{...record,parcel_id:'missing'},{...record,parcel_id:'odd'}],[{id:'user',data_origin:'user'},{id:'odd',data_origin:'unexpected'}],{},'scope','loaded')).slice(1);
  assert.deepEqual(origins.map(row=>row[7]),['用户录入','来源未知','来源未知']);
  assert.deepEqual(origins[1].slice(5,7),['','']);
});

test('every dynamic CSV string resists formula-leading characters, including whitespace/control, full-width and escaping variants',()=>{
  for(const value of ['=1+2','+1','-2','@SUM(A1)','＝1','＋1','－1','＠X','\t=1','\r=1','\n=1',' =1','\uFEFF=1','\u200B=1','\0=1',"'=1",'"=1',' =1,\"\r\n@SUM(A1)']){
    const unsafe={...record,id:value,visit_id:value,parcel_id:value,observed_at:value,created_at:value,label:value,note:value};
    const row=parse(verificationCsv([unsafe],[{id:value,name:value,season:value,data_origin:'fixture'}],{[value]:value},value,value))[1];
    for(const index of [0,1,2,3,4,5,6,8,9,10,11,13])assert.equal(row[index],`文本：${value}`);
    assert.equal(row.length,15);assert.ok(row.every(cell=>!/^[=+\-@＝＋－＠\s\p{Cc}\p{Cf}'"]/u.test(cell)));
  }
  const row=parse(verificationCsv([{...record,label:'__proto__'}],parcels,{},'scope','loaded'))[1];
  assert.equal(row[11],'__proto__');
});

function exportUi(){
  const ui=harness({pathname:'/field'}),downloads=[];
  Object.assign(ui.context,display,{verificationCsv,downloadVerificationCsv:csv=>downloads.push(csv),api:()=>{throw new Error('Export must not read API');},post:()=>{throw new Error('Export must not submit');},listDrafts:()=>{throw new Error('Export must not read drafts');},saveDraft:()=>{throw new Error('Export must not write drafts');}});
  ui.context.rows=[record,{...record,id:'r2',parcel_id:'p2',created_at:'2026-10-18T11:00:00Z',note:'Other parcel'}];
  ui.run('verifications=structuredClone(rows);loading=false;dashboard.verification_count=4;');return {...ui,downloads};
}

test('views state loaded range/count and incomplete status; only an explicit scoped click downloads without changing selection or records',async()=>{
  const ui=exportUi(),before=ui.run('JSON.stringify(verifications)');
  const admin=ui.run('recordsPanel()'),field=ui.run('fieldRecords()');
  assert.match(admin,/全部已加载地块 · 2 条/);assert.match(admin,/尚未全部加载/);
  assert.match(field,/当前地块：Parcel one（p1） · 1 条/);assert.match(field,/data-parcel="p1"/);
  assert.match(field,/不含本机草稿、农事或照片文件/);assert.match(field,/公式样文本/);
  await ui.click('field-tab',{tab:'records'});assert.equal(ui.downloads.length,0);
  await ui.click('export-records',{parcel:'p1'});assert.deepEqual(parse(ui.downloads[0]).slice(1).map(row=>row[2]),['r1']);
  assert.match(ui.toast.textContent,/已发起 1 条/);assert.doesNotMatch(ui.toast.textContent,/已保存|成功/);
  ui.run("selectedId='p2';loading=true");await ui.click('export-records',{parcel:'p1'});
  assert.deepEqual(parse(ui.downloads[1]).slice(1).map(row=>row[2]),['r1'],'button scope never silently follows a newer selection');
  assert.match(parse(ui.downloads[1])[1][1],/正在读取/);
  ui.run("selectedId='missing';loading=false;loadError='offline'");assert.match(ui.run('fieldRecords()'),/全部已加载地块 · 2 条/);
  await ui.click('export-records');const all=parse(ui.downloads[2]);assert.deepEqual(all.slice(1).map(row=>row[2]),['r2','r1']);assert.match(all[1][1],/读取失败/);
  assert.equal(ui.run('selectedId'),'missing');assert.equal(ui.run('JSON.stringify(verifications)'),before);
  ui.run('verifications=[]');assert.match(ui.run('recordsPanel()'),/data-action="export-records"[^>]*disabled/);
  await ui.click('export-records');assert.equal(ui.downloads.length,3);
});

test('download uses a local UTF-8 CSV Blob and cleans its temporary anchor and object URL, also on creation/click failure',async()=>{
  const source=stripTypeScriptTypes(readFileSync(new URL('../src/record-export.ts',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
  for(const fail of ['', 'create', 'click']){
    let blob,appended=0,clicked=0,removed=0;const released=[],timers=[];
    const anchor={click(){clicked++;if(fail==='click')throw new Error('download blocked');},remove(){removed++;}};
    const context=vm.createContext({Blob,URL:{createObjectURL(value){blob=value;return 'blob:synthetic-export';},revokeObjectURL(value){released.push(value);}},document:{body:{append(a){assert.equal(a,anchor);appended++;}},createElement(tag){assert.equal(tag,'a');if(fail==='create')throw new Error('creation blocked');return anchor;}},setTimeout(fn,delay){assert.equal(delay,60_000);timers.push(fn);}});
    vm.runInContext(source,context);
    if(fail)assert.throws(()=>vm.runInContext("downloadVerificationCsv('\\uFEFFsynthetic')",context),/blocked/);
    else vm.runInContext("downloadVerificationCsv('\\uFEFFsynthetic')",context);
    assert.equal(blob.type,'text/csv;charset=utf-8');assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())).slice(0,3),[239,187,191]);
    assert.equal(appended,fail==='create'?0:1);assert.equal(clicked,fail==='create'?0:1);assert.equal(removed,fail==='create'?0:1);
    if(!fail){assert.equal(anchor.download,'fieldsignal-loaded-verifications.csv');assert.equal(anchor.href,'blob:synthetic-export');assert.equal(anchor.hidden,true);}
    assert.deepEqual(released,[]);assert.equal(timers.length,1);timers[0]();assert.deepEqual(released,['blob:synthetic-export']);
  }
});
