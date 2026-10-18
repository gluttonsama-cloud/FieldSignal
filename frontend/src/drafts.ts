import type { VerificationDraft } from './types';
const DB_NAME = 'fieldsignal-local-drafts';
const STORE = 'verifications';
let connection: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return connection ??= new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('浏览器不支持本地草稿存储，请换用支持 IndexedDB 的浏览器。'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'visit_id' });
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connection = undefined; }; resolve(request.result); };
    request.onerror = () => { connection = undefined; reject(new Error('无法打开本地草稿，请检查浏览器存储权限。')); };
    request.onblocked = () => reject(new Error('本地草稿存储被其他窗口占用，请关闭旧窗口后重试。'));
  });
}
export async function listDrafts(): Promise<VerificationDraft[]> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll();
    tx.oncomplete = () => resolve(request.result as VerificationDraft[]);
    tx.onerror = () => reject(new Error('无法读取本地草稿。'));
  });
}
export class DraftConflictError extends Error {}

/** Compare-and-swap: never overwrite another tab's newer draft. */
export async function saveDraft(draft: VerificationDraft): Promise<void> {
  const snapshot = structuredClone(draft);
  const expectedRevision = snapshot.revision || 0;
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.get(snapshot.visit_id);
    let conflict = false;
    request.onsuccess = () => {
      const existing = request.result as VerificationDraft | undefined;
      if ((existing?.revision || 0) !== expectedRevision || (existing && existing.client_submission_id !== snapshot.client_submission_id)) {
        conflict = true;
        tx.abort();
        return;
      }
      snapshot.revision = expectedRevision + 1;
      store.put(snapshot);
    };
    tx.oncomplete = () => { draft.revision = snapshot.revision; resolve(); };
    tx.onerror = () => reject(new Error('草稿保存失败，可能是浏览器空间不足。请保留当前页面并重试。'));
    tx.onabort = () => reject(conflict ? new DraftConflictError('另一页面已更新此草稿。当前内容未覆盖已保存版本，请复制当前备注后刷新页面，再打开已保存的最新草稿。') : new Error('草稿写入被中断，尚未确认保存。'));
  });
}

/** Delete only the exact revision whose verification was acknowledged by the service. */
export async function clearDraft(draft: VerificationDraft): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.get(draft.visit_id);
    let conflict = false;
    request.onsuccess = () => {
      const existing = request.result as VerificationDraft | undefined;
      if (existing && (existing.revision !== draft.revision || existing.client_submission_id !== draft.client_submission_id)) {
        conflict = true;
        tx.abort();
        return;
      }
      store.delete(draft.visit_id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('提交已确认，但本地草稿尚未清理。再次提交会核验同一提交编号。'));
    tx.onabort = () => reject(conflict ? new DraftConflictError('核查提交已确认，但另一页面更新了草稿。新草稿已保留，请先在记录页核对已提交内容。') : new Error('提交已确认，本地草稿清理被中断。'));
  });
}
