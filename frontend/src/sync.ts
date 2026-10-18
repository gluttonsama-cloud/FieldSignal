import { api, post, ApiError } from './api.ts';
import { saveDraft, clearDraft } from './drafts.ts';
import type { VerificationDraft, Verification } from './types.ts';

export function verificationNoteError(note: string) {
  return note.trim() ? '' : '请填写现场备注，不能只输入空格或换行。';
}

/** Explicit user-triggered upload only. Persist each acknowledged step before moving on. */
export async function uploadVerificationDraft(draft: VerificationDraft): Promise<Verification> {
  const noteError=verificationNoteError(draft.note);if(noteError)throw new Error(noteError);
  for (const id of [...(draft.pending_delete_photo_ids || [])]) {
    await api<void>(`/visits/${encodeURIComponent(draft.visit_id)}/photos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    draft.pending_delete_photo_ids = (draft.pending_delete_photo_ids || []).filter(value => value !== id);
    await saveDraft(draft);
  }
  for (const [index, photo] of draft.photos.entries()) {
    if (!photo.uploaded_id) {
      let uploadedId: string;
      try {
        const result = await api<{ id: string }>(`/visits/${encodeURIComponent(draft.visit_id)}/photos`, {
          method: 'POST', headers: { 'Content-Type': photo.blob.type }, body: photo.blob,
        });
        if (!result?.id) throw new Error('服务未确认照片编号。');
        uploadedId = result.id;
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
  const result = await post<Verification>(`/visits/${encodeURIComponent(draft.visit_id)}/verifications`, {
    client_submission_id: draft.client_submission_id,
    observed_at: draft.observed_at,
    label: draft.label,
    note: draft.note,
    photo_ids: draft.photos.map(photo => photo.uploaded_id),
  });
  if (!result.id || result.visit_id !== draft.visit_id) throw new Error('服务返回未确认核查记录，草稿已保留，请重试。');
  await clearDraft(draft);
  return result;
}
