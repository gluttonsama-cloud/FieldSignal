import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { bindRecordPhotoEvents, retryRecordPhoto, zoomRecordPhoto } from '../src/record-photos.ts';
import { harness } from './helpers/ui-harness.mjs';

test('both record views expose numbered photos and a read-only viewer bound to the clicked record, including close and Escape',async()=>{
  for(const pathname of ['/admin','/field']){
    const ui=harness({pathname});let reads=0,renders=0;Object.assign(ui.context,display,{post:()=>{throw new Error('No write allowed');},saveDraft:()=>{throw new Error('No draft write allowed');},listDrafts:async()=>{reads++;return [];},trackRender:()=>{renders++;}});ui.run('render=trackRender');
    ui.run(`verifications=[{id:'record-<one>',visit_id:'v1',parcel_id:'p1',observed_at:'2025-10-18T12:30:00Z',created_at:'2026-10-18T12:00:00Z',label:'uncertain',note:'Keep original evidence',photo_ids:['photo/one','photo"two']}];dashboard.parcels[0].name='Parcel <one>'`);
    const before=ui.run('JSON.stringify(verifications)'),card=ui.run('recordCard(verifications[0])');
    assert.match(card,/2 张现场照片/);assert.match(card,/查看第 2 \/ 2 张核查照片/);assert.match(card,/等待读取照片/);assert.match(card,/photo%2Fone/);assert.match(card,/photo%22two/);
    assert.match(card,/data-record="record-&lt;one&gt;"/);assert.doesNotMatch(ui.run('recordCard({...verifications[0],photo_ids:[]})'),/data-record-image/);
    ui.run("selectedId='p2'");await ui.click('view-record-photo',{record:'record-<one>',photo:'photo"two'});
    assert.match(ui.modal.innerHTML,/核查照片 2 \/ 2/);assert.match(ui.modal.innerHTML,/Parcel &lt;one&gt;/);assert.match(ui.modal.innerHTML,/现场观察：[^<]*2025/);assert.match(ui.modal.innerHTML,/核查记录 record-&lt;one&gt;/);assert.match(ui.modal.innerHTML,/用户报告 · 非确诊/);assert.match(ui.modal.innerHTML,/在新标签页打开照片/);assert.match(ui.modal.innerHTML,/原尺寸查看/);assert.equal(ui.modal.form,undefined);
    await ui.click('close-dialog');assert.equal(ui.modal.open,false);
    await ui.click('view-record-photo',{record:'record-<one>',photo:'photo/one'});
    let prevented=false;ui.modal.listeners.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,false,'native Escape is permitted');ui.modal.close();
    await ui.click('view-record-photo',{record:'record-<one>',photo:'not-attached'});assert.equal(ui.modal.open,false);assert.match(ui.toast.textContent,/未列出这张照片/);
    assert.equal(ui.run('JSON.stringify(verifications)'),before);assert.equal(ui.run('selectedId'),'p2');
    assert.equal(reads,0,'read-only close must not read drafts');assert.equal(renders,0,'read-only close must preserve the original record list DOM');assert.equal(ui.run('storageError'),'');
  }
});

// Small DOM boundary for the production capture listeners. These checks cannot
// establish actual browser image decoding, zoom layout or visual acceptance.
function photoDom(){
  const root={listeners:{},figures:[],addEventListener(type,fn,capture){assert.equal(capture,true);this.listeners[type]=fn;},contains(node){return this.figures.some(f=>node===f||Object.values(f.nodes).includes(node));}};
  const makeFigure=()=>{
    const classes=new Set(),figure={dataset:{},nodes:{},classList:{remove:s=>classes.delete(s),toggle(s){if(classes.has(s)){classes.delete(s);return false;}classes.add(s);return true;}},querySelector(selector){return this.nodes[selector]||null;}};
    const node=()=>({hidden:false,disabled:false,textContent:'',attrs:{},closest:()=>figure,setAttribute(name,value){this.attrs[name]=value;}});
    function image(){return {...node(),tagName:'IMG',src:'/api/v1/photos/synthetic',loading:'lazy',hasAttribute:name=>name==='data-record-image',cloneNode(){return image();},replaceWith(next){assert.equal(figure.nodes['[data-record-image]'],this);figure.nodes['[data-record-image]']=next;}};}
    figure.nodes={'[data-record-image]':image(),'[data-photo-status]':node(),'[data-action="retry-record-photo"]':node(),'[data-action="zoom-record-photo"]':node()};
    root.figures.push(figure);return figure;
  };
  bindRecordPhotoEvents(root);return {root,makeFigure};
}

test('failed photo reads retain attachment identity, retry only that image on explicit action and ignore late events from replaced images',()=>{
  const {root,makeFigure}=photoDom(),first=makeFigure(),second=makeFigure(),old=first.nodes['[data-record-image]'],retry=first.nodes['[data-action="retry-record-photo"]'];
  root.listeners.error({target:old});assert.equal(first.dataset.photoState,'error');assert.equal(old.hidden,true);assert.equal(retry.hidden,false);assert.match(first.nodes['[data-photo-status]'].textContent,/原因尚未确认/);assert.equal(second.dataset.photoState,undefined);
  retryRecordPhoto(retry,root);const replacement=first.nodes['[data-record-image]'];assert.notEqual(replacement,old);assert.equal(replacement.src,old.src);assert.equal(replacement.loading,'eager');assert.equal(replacement.hidden,false);assert.equal(first.dataset.photoState,'loading');assert.equal(retry.hidden,true);
  retryRecordPhoto(retry,root);assert.equal(first.nodes['[data-record-image]'],replacement,'duplicate retry cannot replace an in-flight image');
  root.listeners.error({target:old});assert.equal(first.dataset.photoState,'loading');
  root.listeners.load({target:replacement});assert.equal(first.dataset.photoState,'ready');assert.equal(retry.hidden,true);assert.match(first.nodes['[data-photo-status]'].textContent,/已读取/);
  root.listeners.load({target:{tagName:'IMG',hasAttribute:()=>false}});assert.equal(first.dataset.photoState,'ready');
});

test('viewer zoom is available only after a successful read; events and controls from a closed viewer cannot alter its replacement',()=>{
  const {root,makeFigure}=photoDom(),old=makeFigure(),image=old.nodes['[data-record-image]'],zoom=old.nodes['[data-action="zoom-record-photo"]'];
  zoomRecordPhoto(zoom,root);assert.equal(zoom.attrs['aria-pressed'],undefined);
  root.listeners.load({target:image});assert.equal(zoom.disabled,false);zoomRecordPhoto(zoom,root);assert.equal(zoom.attrs['aria-pressed'],'true');assert.equal(zoom.textContent,'适应窗口');zoomRecordPhoto(zoom,root);assert.equal(zoom.attrs['aria-pressed'],'false');
  root.listeners.error({target:image});assert.equal(zoom.disabled,true);assert.equal(zoom.textContent,'原尺寸查看');
  root.figures=[];const current=makeFigure();root.listeners.error({target:image});retryRecordPhoto(old.nodes['[data-action="retry-record-photo"]'],root);zoomRecordPhoto(zoom,root);
  assert.equal(current.dataset.photoState,undefined);assert.equal(current.nodes['[data-record-image]'].hidden,false);
});
