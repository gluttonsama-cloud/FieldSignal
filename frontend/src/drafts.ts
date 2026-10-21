import type { VerificationDraft } from './types';
const DB_NAME = 'fieldsignal-local-drafts';
const STORE = 'verifications';
type RemovedDraft = { visit_id: string; client_submission_id: string; revision: number; removed: true };
type StoredDraft = VerificationDraft | RemovedDraft;
let connection: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if(connection)return connection;
  const opening=new Promise<IDBDatabase>((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('浏览器不支持本地草稿存储，请换用支持 IndexedDB 的浏览器。'));
    const request = indexedDB.open(DB_NAME, 2);
    let blocked=false;
    request.onupgradeneeded = () => {
      if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE, { keyPath: 'visit_id' });
    };
    request.onsuccess = () => {
      const database=request.result;
      // A previously blocked request may complete after the caller has retried.
      // Close that orphan connection rather than leaking or replacing the retry.
      if(blocked){database.close();return;}
      const invalidate=()=>{ if(connection===opening)connection=undefined; };
      database.onclose=invalidate;
      database.onversionchange=()=>{ database.close();invalidate(); };
      resolve(database);
    };
    request.onerror = () => { if(connection===opening)connection=undefined; reject(new Error('无法打开本地草稿，请检查浏览器存储权限，或关闭旧版页面后刷新重试。')); };
    request.onblocked = () => {
      blocked=true;if(connection===opening)connection=undefined;
      reject(new Error('本地草稿升级被旧窗口占用，请关闭其他 FieldSignal 页面后重试。'));
    };
  });
  connection=opening;return opening;
}
export async function listDrafts(): Promise<VerificationDraft[]> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll();
    tx.oncomplete = () => resolve((request.result as StoredDraft[]).filter((draft): draft is VerificationDraft => !('removed' in draft)));
    tx.onerror = () => reject(new Error('无法读取本地草稿，请重试。'));
    tx.onabort = () => reject(new Error('本地草稿读取被中断，请重试。'));
  });
}
export class DraftConflictError extends Error {}

/** Compare-and-swap: never overwrite another tab's newer draft. */
export async function saveDraft(draft: VerificationDraft, startNew = false): Promise<void> {
  const snapshot = structuredClone(draft);
  const expectedRevision = snapshot.revision || 0;
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.get(snapshot.visit_id);
    let conflict = false;
    request.onsuccess = () => {
      const existing = request.result as StoredDraft | undefined;
      const removed = existing && 'removed' in existing;
      // Replacing a tombstone is allowed only by an explicit new-draft action,
      // with a fresh submission identity. Ordinary/stale autosaves cannot do it.
      const restart = removed && startNew && expectedRevision === 0 && existing.client_submission_id !== snapshot.client_submission_id;
      if (!restart && (removed || (existing?.revision || 0) !== expectedRevision || (existing && existing.client_submission_id !== snapshot.client_submission_id))) {
        conflict = true;
        tx.abort();
        return;
      }
      snapshot.revision = (restart ? existing.revision : expectedRevision) + 1;
      store.put(snapshot);
    };
    tx.oncomplete = () => { draft.revision = snapshot.revision; resolve(); };
    tx.onerror = () => reject(new Error('草稿保存失败，可能是浏览器空间不足。请保留当前页面并重试。'));
    tx.onabort = () => reject(conflict ? new DraftConflictError('另一页面已更新此草稿。当前内容未覆盖已保存版本，请复制当前备注后刷新页面，再打开已保存的最新草稿。') : new Error('草稿写入被中断，尚未确认保存。'));
  });
}

/** Delete only the exact revision whose verification was acknowledged by the service. */
export function clearDraft(draft: VerificationDraft): Promise<void> {
  return deleteDraft(draft, true);
}

/** Called only after the user confirms removal of this browser's saved copy. */
export function removeDraft(draft: VerificationDraft): Promise<void> {
  return deleteDraft(draft, false);
}

async function deleteDraft(draft: VerificationDraft, submitted: boolean): Promise<void> {
  const { visit_id, revision, client_submission_id } = draft;
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.get(visit_id);
    let conflict = false;
    request.onsuccess = () => {
      const existing = request.result as StoredDraft | undefined;
      if (existing && 'removed' in existing && existing.client_submission_id === client_submission_id)return;
      if (existing && (existing.revision !== revision || existing.client_submission_id !== client_submission_id)) {
        conflict = true;
        tx.abort();
        return;
      }
      // Keep only an identity/version barrier, never the discarded content.
      store.put({visit_id,client_submission_id,revision:(revision||0)+1,removed:true} satisfies RemovedDraft);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(submitted ? '提交已确认，但本地草稿尚未清理。再次提交会核验同一提交编号。' : '本机草稿移除失败，尚未确认删除，请重试。'));
    tx.onabort = () => reject(conflict
      ? new DraftConflictError(submitted ? '核查提交已确认，但另一页面更新了草稿。新草稿已保留，请先在记录页核对已提交内容。' : '另一页面已更新此草稿，本次未删除。请关闭此窗口，重新查看最新草稿后再决定。')
      : new Error(submitted ? '提交已确认，本地草稿清理被中断。' : '本机草稿移除被中断，尚未确认删除，请重试。'));
  });
}
