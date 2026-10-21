import { syntheticRecordReceipt } from './helpers/record-receipts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { harness, deferred } from './helpers/ui-harness.mjs';

function parcelUi(){
  const ui=harness({pathname:'/field'});Object.assign(ui.context,display,{boundaryMap:()=>'',trend:()=>''});
  ui.run(`dashboard.parcels=[
    {id:'parcel_111111111111aaaa12345678',name:'北侧<一号田>',season:'2025-2026',region:'other',area_ha:1,data_origin:'user'},
    {id:'parcel_222222222222bbbb12345678',name:'北侧<一号田>',season:'2026-2027',region:'other',area_ha:1,data_origin:'user'},
    {id:'parcel_333333333333cccc12345678',name:'北侧<一号田>',season:'2026-2027',region:'other',area_ha:1,data_origin:'user'}
  ];selectedId=dashboard.parcels[1].id`);
  return ui;
}

test('same-name parcels remain distinguishable across seasons and colliding short IDs without changing selection or displaying full IDs in every row',()=>{
  const ui=parcelUi(),before=ui.run('JSON.stringify(dashboard.parcels)'),selected=ui.run('selectedId');
  const options=[...ui.run('parcelPicker()').matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)];
  assert.equal(options.length,3);assert.equal(new Set(options.map(match=>match[2])).size,3);
  assert.match(options[0][2],/2025-2026 · #aaaa12345678/);assert.match(options[1][2],/2026-2027 · #bbbb12345678/);assert.match(options[2][2],/2026-2027 · #cccc12345678/);
  const rows=[...ui.run('adminOverview()').matchAll(/<button class="parcel-row[^>]+>([\s\S]*?)<\/button>/g)].map(match=>match[1]);assert.equal(rows.length,3);assert.equal(new Set(rows).size,3);
  for(const html of [...rows,ui.run('parcelPicker()')]){assert.match(html,/北侧&lt;一号田&gt;/);assert.doesNotMatch(html,/<一号田>/);}
  for(const row of rows){assert.match(row,/202[56]-202[67]/);assert.doesNotMatch(row,/parcel_[123]{12}/);assert.match(row,/其他区域 · 1.00 ha/);}
  for(const html of [ui.run('parcelDetail(selected())'),ui.run('fieldParcels()')]){assert.ok(html.includes(selected));assert.match(html,/完整地块 ID/);assert.match(html,/data-action="copy-parcel-id"/);}
  assert.equal(ui.run('JSON.stringify(dashboard.parcels)'),before);assert.equal(ui.run('selectedId'),selected);
  ui.run("dashboard.parcels[2].data_origin='fixture'");assert.match(ui.run('parcelPicker()'),/开发模拟数据/);
  assert.equal(display.shortParcelId('parcel_unique_12345678',[{id:'parcel_unique_12345678'}]),'12345678');
  const suffixChain=['12345678','x12345678','yx12345678'].map(id=>({id}));assert.equal(new Set(suffixChain.map(p=>display.shortParcelId(p.id,suffixChain))).size,3);
});

test('farm-event confirmation shows the exact season and full ID while the submission stays bound to the opening parcel',async()=>{
  const ui=parcelUi(),target=ui.run('selectedId'),calls=[];ui.context.post=async(path,body)=>{calls.push({path,body});return syntheticRecordReceipt(path,body,'event-synthetic');};
  await ui.click('new-event');const form=ui.modal.form;assert.equal(form.dataset.parcel,target);assert.match(ui.modal.innerHTML,/种植季 2026-2027/);assert.ok(ui.modal.innerHTML.includes(target));assert.match(ui.modal.innerHTML,/北侧&lt;一号田&gt;/);
  Object.assign(form.values,{occurred_on:'2026-10-18',kind:'drainage',note:'Synthetic event'});ui.run('selectedId=dashboard.parcels[2].id');await ui.submit(form);
  assert.equal(calls.length,1);assert.equal(calls[0].path,`/parcels/${encodeURIComponent(target)}/events`);assert.equal(calls[0].body.note,'Synthetic event');
});

test('copy is explicit and uses the clicked full ID; unavailable or rejected clipboard access leaves selectable text with honest guidance',async()=>{
  const ui=parcelUi(),target=ui.run('selectedId'),pending=deferred(),copied=[];
  ui.context.navigator.clipboard={writeText:async value=>{copied.push(value);await pending.promise;}};
  ui.run('parcelDetail(selected())');assert.deepEqual(copied,[]);
  const copy=ui.click('copy-parcel-id',{id:target});ui.run('selectedId=dashboard.parcels[0].id');pending.resolve();await copy;
  assert.deepEqual(copied,[target]);assert.match(ui.toast.textContent,/完整 ID 已复制/);
  for(const capability of [undefined,{writeText:async()=>{throw new Error('NotAllowedError');}}]){
    ui.context.navigator.clipboard=capability;await ui.click('copy-parcel-id',{id:target});assert.match(ui.toast.textContent,/未能自动复制.*选择完整地块 ID 手动复制/);assert.ok(ui.run('parcelIdentity(dashboard.parcels[1])').includes(target));
  }
  ui.context.navigator.clipboard={writeText:async value=>copied.push(value)};await ui.click('copy-parcel-id',{id:'not-loaded'});assert.equal(copied.length,1);assert.match(ui.toast.textContent,/尚未读取/);
});
