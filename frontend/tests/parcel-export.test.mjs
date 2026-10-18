import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as display from '../src/display.ts';
import { parcelBoundaryFile } from '../src/parcel-export.ts';
import { harness } from './helpers/ui-harness.mjs';

const polygon=()=>({type:'Polygon',coordinates:[[[-0,30],[0.002,30],[0.002,30.002],[-0,30.002],[-0,30]]]});
const parcel=()=>({id:'parcel-export-one',data_origin:'user',name:'Private name',season:'2026-2027',geometry:polygon(),boundary_reference:'Private reference',note:'Private note'});

test('boundary export projects only Polygon fields while preserving coordinate order, precision, closure and signed zero',()=>{
  const p=parcel(),original=structuredClone(p),file=parcelBoundaryFile(p),decoded=JSON.parse(file.content);
  assert.equal(file.name,'fieldsignal-parcel-export-one.geojson');assert.deepEqual(Object.keys(decoded),['type','coordinates']);
  assert.deepEqual(decoded,p.geometry);assert.deepEqual(p,original);assert.ok(Object.is(decoded.coordinates[0][0][0],-0));assert.match(file.content,/-0\.0/);
  assert.doesNotMatch(file.content,/Private|season|parcel-export-one|bbox|crs|properties/);
  for(const value of [Number.MIN_VALUE,1e-7,-1e-7,0,0.1+0.2,112.12345678901235]){
    const next=parcel();next.geometry.coordinates[0]=[[value,30],[value+0.002,30],[value+0.002,30.002],[value,30.002],[value,30]];
    assert.deepEqual(JSON.parse(parcelBoundaryFile(next).content),next.geometry);
  }
  assert.throws(()=>parcelBoundaryFile({...p,data_origin:'fixture'}),/开发模拟边界/);
  assert.throws(()=>parcelBoundaryFile({...p,geometry:{type:'Polygon',coordinates:[[[NaN,30],[1,30],[1,31],[NaN,30]]]}}),/有限数值/);
  assert.match(parcelBoundaryFile({...p,id:'../../private?name'}).name,/^fieldsignal-[_A-Za-z0-9-]+\.geojson$/);
});

test('both parcel details disclose local coordinate download; only explicit clicks export the button-bound user parcel without API or draft effects',async()=>{
  for(const pathname of ['/admin','/field']){
    const ui=harness({pathname}),downloads=[];Object.assign(ui.context,display,{downloadParcelBoundary:file=>downloads.push(file),api:()=>{throw new Error('No API');},post:()=>{throw new Error('No write');},saveDraft:()=>{throw new Error('No draft write');},inputParcel:parcel()});
    ui.run('Object.assign(dashboard.parcels[0],inputParcel);selectedId=inputParcel.id');
    const html=ui.run(pathname==='/admin'?'parcelDetail(selected())':'fieldParcels()');
    assert.match(html,/下载边界 GeoJSON/);assert.match(html,/含当前已加载边界的地理坐标/);assert.match(html,/点击后下载到本机，不外发/);assert.match(html,/不代表测绘或权属认证/);assert.equal(downloads.length,0);
    const before=ui.run('JSON.stringify(dashboard.parcels)');ui.run("selectedId='p2'");
    await ui.click('export-parcel-boundary',{id:'parcel-export-one'});assert.equal(downloads.length,1);assert.equal(downloads[0].name,'fieldsignal-parcel-export-one.geojson');assert.equal(ui.run('selectedId'),'p2');assert.equal(ui.run('JSON.stringify(dashboard.parcels)'),before);assert.match(ui.toast.textContent,/已发起.*本机下载/);
    ui.run("dashboard.parcels[0].data_origin='fixture'");assert.doesNotMatch(ui.run('parcelIdentity(dashboard.parcels[0])'),/export-parcel-boundary/);
    await ui.click('export-parcel-boundary',{id:'parcel-export-one'});assert.equal(downloads.length,1);assert.match(ui.toast.textContent,/开发模拟边界/);
    await ui.click('export-parcel-boundary',{id:'missing'});assert.equal(downloads.length,1);assert.match(ui.toast.textContent,/尚未读取/);
  }
});

test('download creates only a local GeoJSON Blob and releases its anchor and object URL even when blocked',async()=>{
  const source=stripTypeScriptTypes(readFileSync(new URL('../src/parcel-export.ts',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
  for(const blocked of [false,true]){
    let blob,removed=0;const released=[],timers=[],file=parcelBoundaryFile(parcel());
    const anchor={click(){if(blocked)throw new Error('Download blocked');},remove(){removed++;}};
    const context=vm.createContext({file,Blob,URL:{createObjectURL(value){blob=value;return 'blob:local-boundary';},revokeObjectURL(value){released.push(value);}},document:{body:{append(value){assert.equal(value,anchor);}},createElement(tag){assert.equal(tag,'a');return anchor;}},setTimeout(fn,delay){assert.equal(delay,60_000);timers.push(fn);}});
    vm.runInContext(source,context);if(blocked)assert.throws(()=>vm.runInContext('downloadParcelBoundary(file)',context),/blocked/);else vm.runInContext('downloadParcelBoundary(file)',context);
    assert.equal(blob.type,'application/geo+json;charset=utf-8');assert.equal(await blob.text(),file.content);assert.equal(anchor.download,file.name);assert.equal(anchor.href,'blob:local-boundary');assert.equal(removed,1);assert.equal(timers.length,1);timers[0]();assert.deepEqual(released,['blob:local-boundary']);
  }
});
