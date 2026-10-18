import { api, post } from './api.ts';
import { saveDraft, clearDraft } from './drafts.ts';
import type { VerificationDraft, Verification } from './types.ts';

/** Explicit user-triggered upload only. Persist each acknowledged step before moving on. */
export async function uploadVerificationDraft(draft: VerificationDraft): Promise<Verification> {
  for (const id of [...(draft.pending_delete_photo_ids || [])]) {
    await api<void>(`/visits/${encodeURIComponent(draft.visit_id)}/photos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    draft.pending_delete_photo_ids = (draft.pending_delete_photo_ids || []).filter(value => value !== id);
    await saveDraft(draft);
  }
  for (const photo of draft.photos) {
    if (!photo.uploaded_id) {
      const result = await api<{ id: string }>(`/visits/${encodeURIComponent(draft.visit_id)}/photos`, {
        method: 'POST', headers: { 'Content-Type': photo.blob.type }, body: photo.blob,
      });
      if (!result.id) throw new Error('服务未确认照片编号，草稿已保留，请重试。');
      photo.uploaded_id = result.id;
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
