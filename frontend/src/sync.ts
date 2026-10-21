import { api, post, ApiError } from './api.ts';
import { saveDraft, clearDraft } from './drafts.ts';
import { validatePhotoReceipt, validateVerificationReceipt } from './record-receipts.ts';
import type { VerificationDraft, Verification } from './types.ts';

export function verificationNoteError(note: string) {
  return note.trim() ? '' : '请填写现场备注，不能只输入空格或换行。';
}

/** Explicit user-triggered upload only. Persist each acknowledged step before moving on. */
export async function uploadVerificationDraft(draft: VerificationDraft): Promise<Verification> {
  const noteError=verificationNoteError(draft.note);if(noteError)throw new Error(noteError);
  // Older drafts may queue a shared upload ID after only one duplicate image
  // was removed. Never delete a server photo still referenced by a kept image.
  const retainedIds=new Set(draft.photos.map(photo=>photo.uploaded_id).filter(Boolean));
  const pending=draft.pending_delete_photo_ids||[];
  const reconciled=[...new Set(pending)].filter(id=>!retainedIds.has(id));
  if(reconciled.length!==pending.length){
    draft.pending_delete_photo_ids=reconciled;
    // Commit the correction before any remote DELETE or upload. A failed/CAS
    // write must leave the durable version intact and stop this submission.
    try { await saveDraft(draft); }
    catch(error){
      // Preserve the fence for a retry using this same in-memory draft too.
      if(draft.pending_delete_photo_ids===reconciled)draft.pending_delete_photo_ids=pending;
      throw error;
    }
  }
  for (const id of [...(draft.pending_delete_photo_ids || [])]) {
    await api<void>(`/visits/${encodeURIComponent(draft.visit_id)}/photos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    draft.pending_delete_photo_ids = (draft.pending_delete_photo_ids || []).filter(value => value !== id);
    await saveDraft(draft);
  }
  for (const [index, photo] of draft.photos.entries()) {
    if (!photo.uploaded_id) {
      let uploadedId: string;
      try {
        const visitId=draft.visit_id, origin=draft.data_origin;
        const result = await api<unknown>(`/visits/${encodeURIComponent(visitId)}/photos`, {
          method: 'POST', headers: { 'Content-Type': photo.blob.type }, body: photo.blob,
        });
        uploadedId = validatePhotoReceipt(result,visitId,origin).id;
      } catch (error) {
        const advice=error instanceof ApiError&&[415,422].includes(error.status)?'请检查或更换这张照片，再手动重试。':error instanceof ApiError&&error.status<500?'请保留草稿，按提示处理后再手动重试。':'这张照片的服务端结果尚未确认，请保留草稿后手动重试。';
        const message=`第 ${index+1}/${draft.photos.length} 张照片「${photo.name||'未命名照片'}」：${error instanceof Error?error.message:'请求未完成。'} ${advice}`;
        if(error instanceof ApiError)throw new ApiError(error.status,message);
        throw new Error(message);
      }
      photo.uploaded_id = uploadedId;
      // Keep persistence/CAS failures distinct from photo-request failures.
      await saveDraft(draft);
    }
  }
  const firstPhotoById=new Map<string,number>();
  for(const [index,photo] of draft.photos.entries()){
    const id=photo.uploaded_id!;
    const first=firstPhotoById.get(id);
    if(first!==undefined)throw new Error(`第 ${index+1} 张照片与第 ${first+1} 张经服务处理后为同一张图片。请移除重复照片，仅保留一张，再核对并手动提交；草稿与原图仍保留。`);
    firstPhotoById.set(id,index);
  }
  // Bind both acknowledgment and CAS cleanup to the version actually sent,
  // never to a mutable draft whose content/revision may change during fetch.
  const snapshot=structuredClone(draft);
  const payload={
    client_submission_id:snapshot.client_submission_id,
    observed_at:snapshot.observed_at,
    label:snapshot.label,
    note:snapshot.note,
    photo_ids:snapshot.photos.map(photo=>photo.uploaded_id!),
  };
  const raw=await post<unknown>(`/visits/${encodeURIComponent(snapshot.visit_id)}/verifications`,payload);
  const result=validateVerificationReceipt(raw,snapshot,payload);
  await clearDraft(snapshot);
  return result;
}
