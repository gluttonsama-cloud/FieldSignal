export class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const headers = new Headers(options.headers);
    if (options.body && typeof options.body === 'string') headers.set('Content-Type', 'application/json');
    const response = await fetch(`/api/v1${path}`, { ...options, headers, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const base = data?.error?.message || (typeof data?.detail === 'string' ? data.detail : `请求失败（${response.status}）`);
      const details = Array.isArray(data?.error?.details) ? data.error.details.slice(0, 3).map((d: {field?: string; message?: string}) => `${d.field || ''}：${d.message || ''}`).join('；') : '';
      throw new ApiError(response.status, details ? `${base} ${details}` : base);
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('暂时无法连接本地服务，请确认服务正在运行后重试。');
  } finally { clearTimeout(timer); }
}
export function post<T>(path: string, data: unknown, requestKey?: string) { return api<T>(path, { method: 'POST', body: JSON.stringify(data), ...(requestKey ? { headers: { 'Idempotency-Key': requestKey } } : {}) }); }
