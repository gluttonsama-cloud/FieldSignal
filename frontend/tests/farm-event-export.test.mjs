import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { farmEventCsv } from '../src/farm-event-export.ts';

const parcel={id:'p1',name:'一号田',season:'2025-2026',data_origin:'fixture',geometry:{private_boundary:'not-for-export'}};
const event={id:'e1',parcel_id:'p1',occurred_on:'2025-10-18',created_at:'2026-10-18T10:00:00.654321+08:00',kind:'spraying',note:'植保, "现场"\r\n第二行\n保留空格  ',photo_ids:['private-photo-id'],client_submission_id:'private-retry-id',visit_id:'private-visit-id'};
const kinds={spraying:'植保作业'};
const completeness='当前地块已加载快照，不保证全库完整。';
const header=['导出范围','加载范围说明','农事记录ID','地块ID','地块名称','种植季','地块数据来源','农事日期（API原值）','服务端保存时间（API原值含时区）','农事类型代码','农事类型','记录性质','原始备注'];
const nature='用户录入的农事活动，仅供对照，非诊断或异常成因结论';

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

test('farm-event CSV has explicit columns, provenance, exact API dates and original Chinese/multiline notes only',()=>{
  const csv=farmEventCsv([event],parcel,kinds,completeness),rows=parse(csv);
  assert.deepEqual(rows,[header,['当前地块',completeness,'e1','p1','一号田','2025-2026','开发模拟数据',event.occurred_on,event.created_at,'spraying','植保作业',nature,event.note]]);
  assert.doesNotMatch(csv,/private-photo-id|private-retry-id|private-visit-id|private_boundary|photo_ids|client_submission_id|geometry/);
  for(const [data_origin,label] of [['user','用户录入'],['unexpected','来源未知'],[undefined,'来源未知']]){
    const row=parse(farmEventCsv([event],{...parcel,data_origin},kinds,completeness))[1];
    assert.equal(row[6],label);
    assert.equal(row[11],nature);
  }
  assert.deepEqual(parse(farmEventCsv([],parcel,kinds,completeness)),[header]);
});

test('farm-event CSV retains loaded order without mutating frozen records, parcel or kind labels',()=>{
  const frozenEvents=Object.freeze([
    Object.freeze({...event,id:'later',occurred_on:'2026-10-20',photo_ids:Object.freeze(['private-photo-id'])}),
    Object.freeze({...event,id:'earlier',occurred_on:'2025-01-01',photo_ids:Object.freeze(['private-photo-id'])}),
  ]);
  const frozenParcel=Object.freeze({...parcel,geometry:Object.freeze({...parcel.geometry})}),frozenKinds=Object.freeze({...kinds});
  const before=JSON.stringify({frozenEvents,frozenParcel,frozenKinds});
  const rows=parse(farmEventCsv(frozenEvents,frozenParcel,frozenKinds,completeness));
  assert.deepEqual(rows.slice(1).map(row=>[row[2],row[7]]),[['later','2026-10-20'],['earlier','2025-01-01']]);
  assert.equal(JSON.stringify({frozenEvents,frozenParcel,frozenKinds}),before);
});

test('farm-event CSV leaves legacy timestamps empty and keeps unknown/prototype kind codes rather than inherited labels',()=>{
  const inherited=Object.create({inherited:'Do not use this inherited label'});
  inherited.spraying='植保作业';
  for(const kind of ['__proto__','constructor','toString','inherited','unknown-kind']){
    const legacy={...event,kind};delete legacy.created_at;
    const row=parse(farmEventCsv([legacy],parcel,inherited,completeness))[1];
    assert.equal(row[8],'');assert.equal(row[9],kind);assert.equal(row[10],kind);
  }
  const owned=Object.create(null);owned.__proto__='自有类型说明';
  assert.equal(parse(farmEventCsv([{...event,kind:'__proto__',created_at:null}],parcel,owned,completeness))[1][10],'自有类型说明');
  const legacy={...event};delete legacy.created_at;delete legacy.kind;delete legacy.note;
  const row=parse(farmEventCsv([legacy],parcel,{},completeness))[1];
  assert.deepEqual([row[8],row[9],row[10],row[12]],['','','','']);
});

test('all dynamic farm-event CSV strings use the existing formula protection without changing their source text',()=>{
  for(const value of ['=1+2','+1','-2','@SUM(A1)','＝1','＋1','－1','＠X','\t=1','\r=1','\n=1',' =1','\uFEFF=1','\u200B=1','\0=1',"'=1",'"=1',' =1,\"\r\n@SUM(A1)']){
    const input={...event,id:value,parcel_id:value,occurred_on:value,created_at:value,kind:value,note:value};
    const current={...parcel,id:value,name:value,season:value};
    const row=parse(farmEventCsv([input],current,{[value]:value},value))[1];
    for(const index of [1,2,3,4,5,7,8,9,10,12])assert.equal(row[index],`文本：${value}`);
    assert.equal(row.length,13);assert.ok(row.every(cell=>!/^[=+\-@＝＋－＠\s\p{Cc}\p{Cf}'"]/u.test(cell)));
    assert.equal(input.note,value);assert.equal(current.id,value);
  }
});

test('farm-event CSV rejects non-arrays, malformed identities and mixed/wrong parcels rather than exporting partial data',()=>{
  for(const input of [null,undefined,{},'events',new Set([event])]){
    assert.throws(()=>farmEventCsv(input,parcel,kinds,completeness),/农事导出已取消/);
  }
  for(const invalid of [null,undefined,[],{...event,id:undefined},{...event,id:null},{...event,id:1},{...event,id:''},{...event,id:' \t\r\n'},{...event,parcel_id:undefined},{...event,parcel_id:1},{...event,parcel_id:''},{...event,parcel_id:'p2'},Object.create(event)]){
    assert.throws(()=>farmEventCsv([event,invalid],parcel,kinds,completeness),/农事导出已取消/);
  }
  const sparse=[];sparse.length=1;
  assert.throws(()=>farmEventCsv(sparse,parcel,kinds,completeness),/农事导出已取消/);
  for(const invalid of [null,undefined,[],{},Object.create(parcel),{...parcel,id:1},{...parcel,id:''},{...parcel,id:' \t'},{...parcel,id:'p2'}]){
    assert.throws(()=>farmEventCsv([event],invalid,kinds,completeness),/农事导出已取消/);
  }
  assert.deepEqual(parse(farmEventCsv([{...event,id:'__proto__'}],parcel,kinds,completeness))[1].slice(2,4),['__proto__','p1']);
});

test('farm-event download uses the shared local UTF-8 CSV Blob and cleans its URL on anchor creation, append or click failure',async()=>{
  const source=['record-export.ts','farm-event-export.ts'].map(file=>stripTypeScriptTypes(readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')).join('\n');
  for(const fail of ['', 'create', 'append', 'click']){
    let blob,appended=0,clicked=0,removed=0;const released=[],timers=[];
    const anchor={click(){clicked++;if(fail==='click')throw new Error('download blocked');},remove(){removed++;}};
    const context=vm.createContext({Blob,URL:{createObjectURL(value){blob=value;return 'blob:synthetic-events';},revokeObjectURL(value){released.push(value);}},document:{body:{append(a){assert.equal(a,anchor);appended++;if(fail==='append')throw new Error('append blocked');}},createElement(tag){assert.equal(tag,'a');if(fail==='create')throw new Error('creation blocked');return anchor;}},setTimeout(fn,delay){assert.equal(delay,60_000);timers.push(fn);}});
    vm.runInContext(source,context);
    if(fail)assert.throws(()=>vm.runInContext("downloadFarmEventCsv('\\uFEFFsynthetic\\r\\n')",context),/blocked/);
    else assert.equal(vm.runInContext("downloadFarmEventCsv('\\uFEFFsynthetic\\r\\n')",context),undefined);
    assert.equal(blob.type,'text/csv;charset=utf-8');
    const bytes=Array.from(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual(bytes.slice(0,3),[239,187,191]);assert.equal(Buffer.from(bytes).toString('utf8'),'\uFEFFsynthetic\r\n');
    assert.equal(appended,fail==='create'?0:1);assert.equal(clicked,fail==='create'||fail==='append'?0:1);assert.equal(removed,fail==='create'?0:1);
    if(fail!=='create'){assert.equal(anchor.download,'fieldsignal-loaded-farm-events.csv');assert.equal(anchor.href,'blob:synthetic-events');assert.equal(anchor.hidden,true);}
    assert.deepEqual(released,[]);assert.equal(timers.length,1);timers[0]();assert.deepEqual(released,['blob:synthetic-events']);
  }
});

test('farm-event download propagates object-URL creation failure without pretending a download started',()=>{
  const source=['record-export.ts','farm-event-export.ts'].map(file=>stripTypeScriptTypes(readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')).join('\n');
  const context=vm.createContext({Blob,URL:{createObjectURL(){throw new Error('URL creation blocked');},revokeObjectURL(){assert.fail('No URL was created');}},document:{createElement(){assert.fail('No download should start');}},setTimeout(){assert.fail('No URL needs cleanup');}});
  vm.runInContext(source,context);
  assert.throws(()=>vm.runInContext("downloadFarmEventCsv('synthetic')",context),/URL creation blocked/);
});
