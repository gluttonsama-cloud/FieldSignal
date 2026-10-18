import test from 'node:test';
import assert from 'node:assert/strict';
import { parseParcelGeometry, parcelGeometrySummary } from '../src/parcel-geometry.ts';
import { boundaryMap, esc } from '../src/display.ts';
import { harness, deferred } from './helpers/ui-harness.mjs';

const polygon={type:'Polygon',coordinates:[[[112,30],[112.01,30],[112.01,30.01],[112,30]]]};
const changed={type:'Polygon',coordinates:[[[113,31],[113.01,31],[113.01,31.01],[113,31]]]};
const wrappers=p=>[p,{type:'Feature',properties:{name:'Do not fill'},geometry:p},{type:'FeatureCollection',features:[{type:'Feature',properties:{season:'1900-1901'},geometry:p}]}];
function parcelUi() {
  const ui=harness(),calls=[];Object.assign(ui.context,{boundaryMap,esc});
  ui.context.post=async(path,body,key)=>{calls.push({path,body:JSON.parse(JSON.stringify(body)),key});return {id:'saved-parcel'};};
  ui.context.FormData=class {constructor(form){this.values=form.fields?.disabled?{}:{...form.values};}get(key){return this.values[key]??null;}};
  return {...ui,calls};
}
function openForm(ui) {
  ui.run('parcelModal()');const form=ui.modal.form,query=form.querySelector.bind(form);
  form.values={name:'My field',region:'other',season:'2026-2027',sowing_date:'',cultivar:'',geometry:JSON.stringify(polygon)};
  form.fields={disabled:false};form.fileStatus={textContent:'',set innerHTML(_){assert.fail('status is text only');}};
  form.preview={innerHTML:''};form.summary={textContent:'',set innerHTML(_){assert.fail('summary is text only');}};
  form.geometry={name:'geometry',get value(){return form.values.geometry;},set value(v){form.values.geometry=v;},closest:s=>s==='#parcel-form'?form:null};
  form.fileInput={id:'parcel-file',value:'',files:[],closest:s=>s==='#parcel-form'?form:null};
  form.querySelector=s=>s==='#parcel-fields'?form.fields:s==='textarea[name="geometry"]'?form.geometry:s==='#parcel-file-status'?form.fileStatus:s==='#parcel-geometry-preview'?form.preview:s==='#parcel-geometry-summary'?form.summary:query(s);
  return form;
}
const file=(raw,name='boundary.geojson',size=100)=>({name,size,text:async()=>raw});
const choose=(ui,form,selected)=>{form.fileInput.files=selected?[selected]:[];form.fileInput.value=selected?selected.name:'';return ui.modal.listeners.change({target:form.fileInput});};
const edit=(ui,form,raw)=>{form.geometry.value=raw;ui.modal.listeners.input({target:form.geometry});};

test('Polygon, Feature and one-Feature collection retain exact coordinates and discard only non-boundary metadata',()=>{
  for(const value of wrappers(polygon))assert.deepEqual(parseParcelGeometry(JSON.stringify(value)),polygon);
  assert.deepEqual(parseParcelGeometry(JSON.stringify({...polygon,bbox:[0,0,0,0]})),polygon);
  const clockwise={...polygon,coordinates:[polygon.coordinates[0].slice().reverse()]};
  assert.deepEqual(parseParcelGeometry(JSON.stringify(clockwise)),clockwise);
  assert.match(parcelGeometrySummary(polygon),/3 个坐标点（不含闭合点）/);
  assert.match(parcelGeometrySummary(polygon),/经度 112 至 112.01/);
});

test('ambiguous wrappers and unsupported coordinate structure fail without repairing or coercing',()=>{
  const invalid=[null,[],{type:'Feature',geometry:null},{type:'MultiPolygon',coordinates:[]},{type:'FeatureCollection',features:[]},{type:'FeatureCollection',features:[...wrappers(polygon).slice(1,2),{type:'Feature',geometry:{type:'Point',coordinates:[112,30]}}]},
    {...polygon,coordinates:[polygon.coordinates[0],polygon.coordinates[0]]},
    {...polygon,coordinates:[polygon.coordinates[0].map(p=>[...p,20])]},
    {...polygon,coordinates:[[[112,30],[112.01,30],[112.01,30.01],[112.02,30]]]},
    {...polygon,coordinates:[Array.from({length:1001},()=>[112,30])]},
    {...polygon,coordinates:[[[112,30],['112.01',30],[112.01,30.01],[112,30]]]},
    {...polygon,coordinates:[[[112,30],[true,30],[112.01,30.01],[112,30]]]},
    {...polygon,coordinates:[[[112,30],[181,30],[112.01,30.01],[112,30]]]},
    {...polygon,coordinates:[[[112,30],[112.01,86],[112.01,30.01],[112,30]]]},
    {...polygon,coordinates:[[[112,30],[114,30],[112.01,30.01],[112,30]]]},
    {...polygon,srid:3857},
  ];
  for(const value of invalid)assert.throws(()=>parseParcelGeometry(JSON.stringify(value)));
  assert.throws(()=>parseParcelGeometry('{"type":"Polygon","coordinates":[[[112,30],[1e999,30],[112.01,30.01],[112,30]]]}'),/有限数值/);
  for(const value of [{...polygon,crs:null},{type:'Feature',crs:{name:'EPSG:3857'},geometry:polygon},{type:'FeatureCollection',crs:{name:'EPSG:4326'},features:[{type:'Feature',geometry:polygon}]},{type:'FeatureCollection',features:[{type:'Feature',crs:{name:'EPSG:3857'},geometry:polygon}]}])assert.throws(()=>parseParcelGeometry(JSON.stringify(value)),/不转换坐标系/);
});

test('file read previews only selected geometry, retains user fields, and sends nothing until explicit Save',async()=>{
  const ui=parcelUi(),form=openForm(ui),danger='<img src=x onerror=alert(1)>';
  const value={type:'Feature',properties:{name:danger,season:'1900-1901'},geometry:{...changed,bbox:[0,0,0,0]}};
  await choose(ui,form,file(JSON.stringify(value),danger,1024*1024));
  assert.equal(form.fileInput.value,'');assert.equal(ui.calls.length,0);assert.equal(form.values.name,'My field');assert.equal(form.values.season,'2026-2027');
  assert.deepEqual(JSON.parse(form.values.geometry),changed);assert.ok(form.fileStatus.textContent.includes(danger));
  assert.match(form.preview.innerHTML,/<svg/);assert.equal(form.preview.innerHTML.includes('<img'),false);
  assert.match(form.summary.textContent,/未核实位置、权属或面积/);
  await ui.submit(form);assert.equal(ui.calls.length,1);assert.deepEqual(ui.calls[0].body.geometry,changed);
  assert.equal(ui.calls[0].body.name,'My field');assert.equal(ui.calls[0].body.season,'2026-2027');
});

test('invalid, unreadable and oversized files preserve existing geometry and cannot trigger network writes',async()=>{
  for(const selected of [file('{broken'),file(JSON.stringify({type:'FeatureCollection',features:[]})),{name:'unreadable',size:10,text:async()=>{throw new Error('Read failed');}},{name:'large',size:1024*1024+1,text(){assert.fail('oversized file must not be read');}}]){
    const ui=parcelUi(),form=openForm(ui),before={...form.values};await choose(ui,form,selected);
    assert.equal(form.fileInput.value,'');assert.deepEqual(form.values,before);assert.equal(ui.modal.error.hidden,false);assert.equal(form.submit.disabled,false);assert.equal(ui.calls.length,0);
  }
});

test('newer file wins; late success or error cannot overwrite it or unlock its pending read',async()=>{
  for(const lateFailure of [false,true]){
    const ui=parcelUi(),form=openForm(ui),first=deferred(),second=deferred();
    const firstDone=choose(ui,form,file(first.promise));const secondDone=choose(ui,form,file(second.promise));
    if(lateFailure)first.reject(new Error('Old read failed'));else first.resolve(JSON.stringify(changed));
    await firstDone;assert.equal(form.submit.disabled,true);await ui.submit(form);assert.equal(ui.calls.length,0);
    second.resolve(JSON.stringify(polygon));await secondDone;assert.deepEqual(JSON.parse(form.values.geometry),polygon);
    assert.equal(form.submit.disabled,false);assert.equal(ui.modal.error.hidden,true);
  }
});

test('manual editing and clearing selection supersede pending file reads without changing other inputs',async()=>{
  for(const manual of [false,true]){
    const ui=parcelUi(),form=openForm(ui),pending=deferred();const done=choose(ui,form,file(pending.promise));
    if(manual)edit(ui,form,JSON.stringify(changed));else await choose(ui,form,undefined);
    pending.resolve(JSON.stringify(polygon));await done;
    assert.deepEqual(JSON.parse(form.values.geometry),manual?changed:polygon);
    assert.equal(form.values.name,'My field');assert.equal(form.submit.disabled,false);assert.equal(ui.calls.length,0);
  }
});

test('closed or cancelled dialog file completion cannot change a new parcel form',async()=>{
  for(const close of ['close-dialog','cancel']){
    const ui=parcelUi(),old=openForm(ui),pending=deferred();const done=choose(ui,old,file(pending.promise));
    if(close==='cancel')ui.modal.listeners.cancel({preventDefault(){}});else await ui.click('close-dialog');
    const current=openForm(ui);edit(ui,current,JSON.stringify(changed));
    pending.resolve(JSON.stringify(polygon));await done;
    assert.equal(ui.modal.form,current);assert.deepEqual(JSON.parse(current.values.geometry),changed);assert.equal(ui.calls.length,0);
  }
});

test('Save snapshots before disabling controls, blocks changes and duplicate submits, then safely retries',async()=>{
  const ui=parcelUi(),form=openForm(ui),pending=deferred();
  await choose(ui,form,file(JSON.stringify(changed)));
  ui.context.post=async(path,body,key)=>{ui.calls.push({path,body:JSON.parse(JSON.stringify(body)),key});return pending.promise;};
  const submitted=ui.submit(form);assert.equal(form.fields.disabled,true);await ui.submit(form);
  await choose(ui,form,file(JSON.stringify(polygon)));assert.equal(ui.calls.length,1);assert.deepEqual(ui.calls[0].body.geometry,changed);
  pending.reject(new Error('Response lost'));await submitted;
  assert.equal(form.fields.disabled,false);assert.equal(form.submit.disabled,false);assert.equal(ui.modal.open,true);
  ui.context.post=async(path,body,key)=>{ui.calls.push({path,body:JSON.parse(JSON.stringify(body)),key});return{id:'saved'};};
  await ui.submit(form);assert.deepEqual(ui.calls[0],ui.calls[1]);
});
