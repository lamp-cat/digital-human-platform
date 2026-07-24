import type {
  AssetEntry,
  AvatarDetail,
  AvatarSummary,
  ImportRecord,
  ImportReport,
  Job,
  User,
} from './types';

/** API client：fetch 封装 + Bearer 鉴权 + 统一错误（code/requestId）。 */

const BASE = '/api/v1';
export const AUTH_STORAGE_KEY = 'dhp.auth';

function getToken(): string | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? (JSON.parse(raw).token as string) : null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status, 'INTERNAL_ERROR', '响应解析失败');
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data.code as string) ?? 'INTERNAL_ERROR',
      (data.message as string) ?? `请求失败（${res.status}）`,
      data.requestId as string | undefined,
      data.details,
    );
  }
  return data as T;
}

function qs(params?: Record<string, string | undefined>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const api = {
  // 认证
  register: (email: string, password: string, displayName?: string) =>
    request<{ token: string; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<{ user: User }>('/auth/me'),

  // 数字人
  createAvatar: (name: string) =>
    request<{ avatar: AvatarDetail }>('/avatars', { method: 'POST', body: JSON.stringify({ name }) }),
  listAvatars: () => request<{ avatars: AvatarSummary[] }>('/avatars'),
  getAvatar: (id: string) => request<{ avatar: AvatarDetail }>(`/avatars/${id}`),
  patchAvatar: (id: string, body: { expectedVersion: number; profile: unknown; name?: string }) =>
    request<{ avatar: AvatarDetail }>(`/avatars/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  duplicateAvatar: (id: string) =>
    request<{ avatar: AvatarDetail }>(`/avatars/${id}/duplicate`, { method: 'POST' }),
  deleteAvatar: (id: string) => request<void>(`/avatars/${id}`, { method: 'DELETE' }),
  uploadCover: (id: string, imageBase64: string) =>
    request<{ avatar: AvatarDetail }>(`/avatars/${id}/cover`, {
      method: 'POST',
      body: JSON.stringify({ imageBase64 }),
    }),

  // 资产目录
  listAssets: (params?: { type?: string; status?: string }) =>
    request<{ assets: AssetEntry[] }>(`/assets${qs(params)}`),
  getAsset: (id: string) => request<{ asset: AssetEntry }>(`/assets/${id}`),

  // 管理端
  adminListAssets: () => request<{ assets: AssetEntry[] }>('/admin/assets'),
  adminImportAsset: (manifest: unknown) =>
    request<{ job: Job }>('/admin/assets/import', { method: 'POST', body: JSON.stringify({ manifest }) }),
  adminPublishAsset: (id: string) => request<unknown>(`/admin/assets/${id}/publish`, { method: 'POST' }),
  adminArchiveAsset: (id: string) => request<unknown>(`/admin/assets/${id}/archive`, { method: 'POST' }),

  // 导入与任务
  getImport: (id: string) => request<{ importRecord: ImportRecord }>(`/imports/${id}`),
  getImportReport: (id: string) => request<{ report: ImportReport }>(`/imports/${id}/report`),
  activateImport: (id: string, name: string) =>
    request<{ avatar: AvatarDetail }>(`/imports/${id}/activate`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  deleteImport: (id: string) => request<void>(`/imports/${id}`, { method: 'DELETE' }),
  getJob: (id: string) => request<{ job: Job }>(`/jobs/${id}`),
};

/** 带进度的导入上传（XMLHttpRequest，可取消）。 */
export function uploadImport(
  file: File,
  rightsConfirmed: boolean,
  onProgress: (ratio: number) => void,
): { promise: Promise<{ importRecord: ImportRecord; job: Job }>; cancel: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ importRecord: ImportRecord; job: Job }>((resolve, reject) => {
    xhr.open('POST', `${BASE}/imports`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          reject(new ApiError(xhr.status, data.code ?? 'INTERNAL_ERROR', data.message ?? '上传失败', data.requestId, data.details));
        }
      } catch {
        reject(new ApiError(xhr.status, 'INTERNAL_ERROR', '上传响应解析失败'));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'INTERNAL_ERROR', '网络错误，上传失败'));
    xhr.onabort = () => reject(new ApiError(0, 'INTERNAL_ERROR', '上传已取消'));
    const form = new FormData();
    form.append('model', file);
    form.append('rightsConfirmed', String(rightsConfirmed));
    xhr.send(form);
  });
  return { promise, cancel: () => xhr.abort() };
}

/** 带鉴权下载为 ObjectURL（封面 / 私有导入模型等）。 */
export async function fetchAuthedObjectUrl(url: string): Promise<string> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url.startsWith('/api') ? url : url, { headers });
  if (!res.ok) throw new ApiError(res.status, 'INTERNAL_ERROR', `文件下载失败（${res.status}）`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
