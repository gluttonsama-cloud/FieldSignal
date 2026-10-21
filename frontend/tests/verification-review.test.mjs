import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.ts';
import { reviewContentKey } from '../src/verification-review.ts';
import { harness, verificationResult, deferred, turn } from './helpers/ui-harness.mjs';

async function reviewUi() {
  const ui=harness({pathname:'/field'}),uploads=[],writes=[],reads=[];
  Object.assign(ui.context,display);
  ui.context.api=async path=>{reads.push(path);return {};};
  ui.context.saveDraft=async draft=>{writes.push(structuredClone(draft));draft.revision=(draft.revision||0)+1;};
  ui.context.uploadVerificationDraft=async draft=>{uploads.push(structuredClone(draft));return verificationResult(draft);};
  await ui.click('verify',{id:'v2'});
  ui.context.photoA={key:'one',name:'A <field>.png',blob:new Blob(['photo one'],{type:'image/png'}),uploaded_id:'staged-one'};
  ui.context.photoB={key:'two',name:'B.png',blob:new Blob(['photo two'],{type:'image/png'})};
  ui.run("currentDraft.parcel_name='Same <name>';currentDraft.observed_at='2026-10-18T12:34:56.123Z';currentDraft.label='uncertain';currentDraft.note='  Original <report>\\nSecond line  ';currentDraft.photos=[photoA,photoB];currentDraft.pending_delete_photo_ids=['removed-staged'];");
  writes.length=0;
  return {...ui,uploads,writes,reads};
}

test('the first submit only reviews exact identities, full text and ordered photos without writes or network requests',async()=>{
  const ui=await reviewUi(),before=structuredClone(ui.run('currentDraft'));
  await ui.review();
  assert.equal(ui.modal.form.id,'verification-review-form');
  assert.match(ui.modal.innerHTML,/Same &lt;name&gt;/);
  assert.match(ui.modal.innerHTML,/<dd>p2<\/dd>/);
  assert.match(ui.modal.innerHTML,/<dd>v2<\/dd>/);
  assert.match(ui.modal.innerHTML,/2026-2027/);
  assert.match(ui.modal.innerHTML,/2026-10-18T12:34:56.123Z/);
  assert.match(ui.modal.innerHTML,/暂不能判断.*非确诊/);
  assert.match(ui.modal.innerHTML,/  Original &lt;report&gt;\nSecond line  /);
  assert.ok(ui.modal.innerHTML.indexOf('A &lt;field&gt;.png')<ui.modal.innerHTML.indexOf('B.png'));
  assert.match(ui.modal.innerHTML,/先前已上传 · 等待核查提交/);
  assert.match(ui.modal.innerHTML,/先移除 1 张/);
  assert.match(ui.modal.innerHTML,/不支持修改已提交记录/);
  assert.match(ui.modal.innerHTML,/确认提交并完成巡田/);
  assert.doesNotMatch(ui.modal.innerHTML,/data-action="remove-photo"|id="photo-input"/);
  assert.equal(ui.writes.length,0);assert.equal(ui.reads.length,0);assert.equal(ui.uploads.length,0);
  assert.deepEqual(structuredClone(ui.run('currentDraft')),before);
});

test('returning to edit preserves evidence and invalidates the old confirmation; only a newly reviewed edit is sent',async()=>{
  const ui=await reviewUi(),identity=ui.run('currentDraft.client_submission_id');
  await ui.review();const oldReview=ui.modal.form;
  await ui.click('edit-verification-review');
  assert.equal(ui.modal.form.id,'verification-form');
  assert.equal(ui.run('verificationReview'),undefined);
  assert.equal(ui.run('currentDraft.client_submission_id'),identity);
  assert.equal(await ui.run('currentDraft.photos[0].blob.text()'),'photo one');
  assert.deepEqual(Array.from(ui.run('currentDraft.pending_delete_photo_ids')),['removed-staged']);
  assert.doesNotMatch(ui.modal.saveStatus.textContent,/已保存到本机/);
  ui.run("currentDraft.note='Edited report'");
  await ui.review(oldReview);
  assert.equal(ui.uploads.length,0);
  await ui.review();await ui.submit();
  assert.equal(ui.uploads.length,1);assert.equal(ui.uploads[0].note,'Edited report');
  assert.equal(ui.uploads[0].client_submission_id,identity);
  assert.equal(ui.run('selectedId'),'p2');assert.equal(ui.run('fieldTab'),'records');
});

test('a stale review cannot submit changed content or different photo bytes even when names and sizes match',async()=>{
  for(const change of [
    "currentDraft.note='Changed after review'",
    "currentDraft.photos[0].blob=new Blob(['different'],{type:'image/png'})",
    "currentDraft.pending_delete_photo_ids.push('another-staged')",
  ]){
    const ui=await reviewUi();ui.context.Blob=Blob;await ui.review();ui.run(change);await ui.submit();
    assert.equal(ui.uploads.length,0);assert.equal(ui.writes.length,0);
    assert.equal(ui.modal.form.id,'verification-form');
    assert.match(ui.modal.error.textContent,/草稿内容已变化.*重新核对/);
  }
});

test('storage revision changes during review are not mistaken for content changes but final submission still saves',async()=>{
  const ui=await reviewUi();await ui.review();const key=ui.run('verificationReview.contentKey');
  ui.run("currentDraft.revision+=1;currentDraft.updated_at='2026-10-20T00:00:00Z';currentDraft.state='draft'");
  assert.equal(reviewContentKey(ui.run('currentDraft')),key);
  await ui.submit();assert.equal(ui.uploads.length,1);assert.ok(ui.writes.length>=1);
});

test('no-photo and uncertain observations stay valid and blank notes remain in the editor',async()=>{
  const ui=await reviewUi();ui.run("currentDraft.photos=[];currentDraft.pending_delete_photo_ids=[]");
  await ui.review();assert.match(ui.modal.innerHTML,/未附现场照片.*仅提交文字/);
  await ui.submit();assert.equal(ui.uploads.length,1);assert.equal(ui.uploads[0].label,'uncertain');
  const empty=await reviewUi();empty.run("currentDraft.note=' \\n '");await empty.review();
  assert.equal(empty.modal.form.id,'verification-form');assert.match(empty.modal.error.textContent,/请填写现场备注/);
  assert.equal(empty.writes.length,0);assert.equal(empty.uploads.length,0);
});

test('failed durable saving returns the retained editor without uploading or falsely reporting a saved draft',async()=>{
  const ui=await reviewUi();await ui.review();
  ui.context.saveDraft=async()=>{throw new Error('Synthetic storage unavailable');};
  await ui.submit();
  assert.equal(ui.modal.form.id,'verification-form');assert.equal(ui.uploads.length,0);
  assert.match(ui.modal.error.textContent,/Synthetic storage unavailable.*尚未发送核查/);
  assert.match(ui.modal.saveStatus.textContent,/尚未确认保存/);
  assert.equal(ui.modal.retrySave.hidden,false);
  assert.equal(await ui.run('currentDraft.photos[1].blob.text()'),'photo two');
});

test('uncertain upload returns to an editable draft and requires another review before manual retry',async()=>{
  const ui=await reviewUi();let attempts=0;
  ui.context.uploadVerificationDraft=async()=>{attempts++;throw new Error('Synthetic response lost');};
  await ui.review();await ui.submit();
  assert.equal(ui.modal.form.id,'verification-form');assert.equal(attempts,1);
  assert.match(ui.modal.error.textContent,/草稿和照片未删除/);
  assert.match(ui.modal.innerHTML,/重试核对并提交/);
  await ui.review();assert.equal(attempts,1);
  await ui.submit();assert.equal(attempts,2);
});

test('confirmation is single-flight and a late completion does not replace a newer interaction',async()=>{
  const ui=await reviewUi(),pending=deferred();await ui.review();
  ui.context.uploadVerificationDraft=async draft=>{ui.uploads.push(structuredClone(draft));await pending.promise;return verificationResult(draft);};
  const done=ui.submit();await turn();await ui.submit();assert.equal(ui.uploads.length,1);
  await ui.click('field-tab',{tab:'parcels'});await ui.click('new-event');const replacement=ui.modal.form;
  replacement.values.note='A different task';
  pending.resolve();await done;
  assert.equal(ui.modal.form,replacement);assert.equal(ui.modal.open,true);
  assert.equal(replacement.values.note,'A different task');assert.equal(ui.run('fieldTab'),'parcels');
});

test('Close and Escape from review save locally without submission; reopening never reuses the old confirmation',async()=>{
  for(const close of ['button','Escape']){
    const ui=await reviewUi();await ui.review();const oldReview=ui.modal.form;
    if(close==='button')await ui.click('close-dialog');
    else{ui.modal.listeners.cancel({preventDefault(){}});await ui.run('saving');await turn();}
    assert.equal(ui.modal.open,false);assert.equal(ui.uploads.length,0);
    assert.equal(ui.run('verificationReview'),undefined);
    await ui.click('verify',{id:'v1'});await ui.review(oldReview);
    assert.equal(ui.modal.form.id,'verification-form');assert.equal(ui.uploads.length,0);
  }
});

test('failed Close or Escape does not strand a review after local saving recovers',async()=>{
  for(const exit of ['button','Escape']){
    const ui=await reviewUi();await ui.review();const save=ui.context.saveDraft;
    ui.context.saveDraft=async()=>{throw new Error('Synthetic quota failure');};
    if(exit==='button')await ui.click('close-dialog');
    else{ui.modal.listeners.cancel({preventDefault(){}});await ui.run('saving').catch(()=>{});await turn();}
    assert.equal(ui.modal.open,true);assert.equal(ui.run('verificationReview.session'),ui.run('dialogSession'));
    assert.match(ui.modal.error.textContent,/Synthetic quota failure/);
    ui.context.saveDraft=save;await ui.click('retry-draft-save');
    await ui.click('edit-verification-review');assert.equal(ui.modal.form.id,'verification-form');
    await ui.review();await ui.submit();assert.equal(ui.uploads.length,1);
  }
});

test('metadata failure after an unsaved edit cannot restore a false saved status or hide local retry',async()=>{
  const ui=await reviewUi();ui.run("delete currentDraft.parcel_season;delete dashboard.parcels[1].season");
  ui.context.saveDraft=async()=>{throw new Error('Synthetic quota failure');};
  await assert.rejects(ui.run('queueSave()'),/quota/);
  ui.context.api=async()=>{throw new Error('Synthetic offline metadata');};
  await ui.review();await ui.submit();
  assert.equal(ui.modal.form.id,'verification-form');assert.equal(ui.uploads.length,0);
  assert.match(ui.modal.saveStatus.textContent,/quota failure.*尚未确认保存/);
  assert.doesNotMatch(ui.modal.saveStatus.textContent,/已保存到本机/);
  assert.equal(ui.modal.retrySave.hidden,false);
});

test('late photo-save or retry-save repaint cannot revoke active review photo previews',async()=>{
  for(const operation of ['photo','retry','remove']){
    const ui=await reviewUi(),pending=deferred(),revoked=[];let serial=0;
    ui.context.URL={createObjectURL:()=>`blob:synthetic-${++serial}`,revokeObjectURL:url=>revoked.push(url)};
    const save=ui.context.saveDraft;ui.context.saveDraft=async(...args)=>{await pending.promise;return save(...args);};
    let done;
    if(operation==='photo')done=ui.modal.listeners.change({target:{id:'photo-input',files:[new File(['synthetic'],'new.png',{type:'image/png'})],value:'synthetic'}});
    else if(operation==='retry')done=ui.click('retry-draft-save');
    else done=ui.click('remove-photo',{id:'two'});
    await turn();await ui.review();const active=Array.from(ui.run('photoUrls'));
    pending.resolve();await done;
    assert.equal(ui.modal.form.id,'verification-review-form');
    assert.deepEqual(Array.from(ui.run('photoUrls')),active);
    assert.ok(active.every(url=>!revoked.includes(url)),'the active read-only preview must remain usable');
  }
});


test('returning from review preserves the non-retryable cross-tab conflict guidance',async()=>{
  const ui=await reviewUi();
  ui.context.saveDraft=async()=>{throw new ui.context.DraftConflictError('另一页面已更新此草稿');};
  await assert.rejects(ui.run('queueSave()'),/另一页面/);
  assert.equal(ui.modal.retrySave.hidden,true);
  await ui.review();assert.equal(ui.modal.retrySave.hidden,true);
  await ui.click('edit-verification-review');
  assert.equal(ui.modal.retrySave.hidden,true);
  assert.match(ui.modal.saveStatus.textContent,/另一页面.*尚未确认保存/);
  assert.equal(ui.uploads.length,0);
});
