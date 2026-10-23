import { esc, fixture, fmtTime, labels } from './display.ts';
import type { VerificationDraft } from './types';

// Storage revisions and upload status may change while the user reads the
// summary. Only the content and identities being confirmed belong in this key.
export function reviewContentKey(draft: VerificationDraft): string {
  return JSON.stringify({
    visit_id: draft.visit_id, parcel_id: draft.parcel_id,
    parcel_name: draft.parcel_name, parcel_season: draft.parcel_season,
    data_origin: draft.data_origin, client_submission_id: draft.client_submission_id,
    observed_at: draft.observed_at, label: draft.label, note: draft.note,
    photos: draft.photos.map(photo => ({ key: photo.key, name: photo.name, uploaded_id: photo.uploaded_id })),
    pending_delete_photo_ids: draft.pending_delete_photo_ids || [],
  });
}

export function verificationReviewBody(draft: VerificationDraft, season: string | undefined, photoUrls: readonly string[]): string {
  return `<form id="verification-review-form"><fieldset id="verification-fields">
    <div class="verification-review workflow-content"><div class="workflow-steps"><span>1 记录现场</span><strong>2 核对提交</strong></div>
      <section aria-label="核查对象" class="review-subject"><h3>${esc(draft.parcel_name)}</h3><p>${esc(season || '尚未读取，确认时将先核对')} ${fixture(draft)}</p><p class="review-finding"><strong>${esc(labels[draft.label] || draft.label)}</strong> <span class="badge reported">用户报告 · 非确诊</span></p><p class="subtle">观察于 ${esc(fmtTime(draft.observed_at,true))}（本机时区）</p></section>
      <section aria-label="核对现场备注"><h3>现场备注</h3><p class="verification-review-note">${esc(draft.note)}</p></section>
      <section aria-label="核对现场照片"><h3>现场照片 · ${draft.photos.length} 张</h3>
        ${draft.photos.length ? `<div class="draft-photos">${draft.photos.map((photo,index) => `<figure class="draft-photo"><img src="${esc(photoUrls[index])}" alt="第 ${index+1} 张待提交照片 ${esc(photo.name)}"><figcaption>${index+1}. ${esc(photo.name || '未命名照片')}<br>${photo.uploaded_id?'先前已上传 · 等待核查提交':'待手动确认上传'}</figcaption></figure>`).join('')}</div>` : '<p class="notice">未附现场照片。本次仅提交文字记录。</p>'}
        ${draft.pending_delete_photo_ids?.length?`<p class="caption">确认时会先移除 ${draft.pending_delete_photo_ids.length} 张先前已上传、现已从草稿移出的暂存照片，再提交当前列表。已归档核查照片不在此范围。</p>`:''}
      </section>
      <p class="notice warning">提交成功后将完成此巡田任务，但报告仍待复核，不代表问题已解决。当前版本不支持修改已提交记录；“暂不能判断”也可如实提交，不代表确诊。</p>
      <details class="identity-details"><summary>核对完整编号与提交说明</summary><dl><dt>完整地块 ID</dt><dd>${esc(draft.parcel_id)}</dd><dt>巡田任务 ID</dt><dd>${esc(draft.visit_id)}</dd><dt>种植季</dt><dd>${esc(season || '尚未读取，确认时将先核对')}</dd><dt>原始观察时间</dt><dd>${esc(draft.observed_at)}</dd></dl><p class="caption">本次核对不会上传照片或提交核查；返回修改不会丢弃当前草稿。确认后才上传至本地服务。</p></details>
      <div id="draft-save" class="draft-save" role="status">核对中 · 尚未提交。确认时将先检查本机保存，再上传至本地服务。</div>
      <button type="button" id="retry-draft-save" class="text-button" data-action="retry-draft-save" hidden>重试保存到本机</button>
    </div>
    <div class="dialog-actions workflow-actions"><button type="button" class="button secondary" data-action="edit-verification-review">返回修改</button><button type="submit" class="button primary">确认提交并完成巡田</button></div>
  </fieldset></form>`;
}
