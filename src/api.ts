import type { BulkPatch, Design, DuplicateGroup, Filters, Meta } from './types.ts';
import { t, language } from './i18n.ts';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...init?.headers, 'X-UI-Language': language } });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? t('Could not reach the server'));
  }
  return response.json();
}

function sendJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const fileUrl = (id: number) => `/api/designs/${id}/file`;
export const downloadUrl = (id: number) => `/api/designs/${id}/file?download=1`;
export const thumbUrl = (design: Design) => `/api/designs/${design.id}/thumb?v=${design.thumb_version}`;

export function filtersToParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.project) params.set('project', String(filters.project));
  if (filters.product) params.set('product', String(filters.product));
  if (filters.types.length) params.set('type', filters.types.join(','));
  if (filters.cats.length) params.set('cat', filters.cats.join(','));
  if (filters.ext) params.set('ext', filters.ext);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.sort !== 'date') params.set('sort', filters.sort);
  return params;
}

export const api = {
  meta: () => request<Meta>('/api/meta'),

  designs: (filters: Filters, page: number, signal?: AbortSignal) => {
    const params = filtersToParams(filters);
    params.set('page', String(page));
    return request<{ items: Design[]; total: number; pageSize: number }>(`/api/designs?${params}`, { signal });
  },
  design: (id: number) => request<Design>(`/api/designs/${id}`),
  updateDesign: (id: number, patch: Partial<Design>) => sendJson<Design>('PATCH', `/api/designs/${id}`, patch),
  deleteDesign: (id: number) => sendJson('DELETE', `/api/designs/${id}`),
  matchingIds: (filters: Filters) => request<number[]>(`/api/designs/ids?${filtersToParams(filters)}`),
  bulkUpdate: (ids: number[], patch: BulkPatch) => sendJson('POST', '/api/designs/bulk', { ids, ...patch }),
  bulkDelete: (ids: number[]) => sendJson('POST', '/api/designs/bulk-delete', { ids }),
  merge: (targetId: number, ids: number[]) => sendJson<Design>('POST', '/api/designs/merge', { target_id: targetId, ids }),

  deleteFile: (id: number, fileId: number) => sendJson<Design>('DELETE', `/api/designs/${id}/files/${fileId}`),
  splitFile: (id: number, fileId: number) =>
    sendJson<{ design: Design; created: Design }>('POST', `/api/designs/${id}/files/${fileId}/split`),
  openFile: (id: number, fileId: number | null) => sendJson('POST', `/api/designs/${id}/open`, { file_id: fileId }),
  revealFile: (id: number, fileId: number | null) => sendJson('POST', `/api/designs/${id}/reveal`, { file_id: fileId }),

  duplicates: () => request<{ pending: number; groups: DuplicateGroup[] }>('/api/duplicates'),
  removeDuplicates: (designIds: number[], fileIds: number[]) =>
    sendJson('POST', '/api/duplicates/remove', { design_ids: designIds, file_ids: fileIds }),

  createProject: (name: string) => sendJson<{ id: number; name: string }>('POST', '/api/projects', { name }),
  renameProject: (id: number, name: string) => sendJson('PATCH', `/api/projects/${id}`, { name }),
  deleteProject: (id: number) => sendJson('DELETE', `/api/projects/${id}`),

  createProduct: (projectId: number, name: string) =>
    sendJson<{ id: number; name: string }>('POST', '/api/products', { project_id: projectId, name }),
  renameProduct: (id: number, name: string) => sendJson('PATCH', `/api/products/${id}`, { name }),
  deleteProduct: (id: number) => sendJson('DELETE', `/api/products/${id}`),

  createType: (name: string) => sendJson<{ id: number; name: string }>('POST', '/api/types', { name }),
  renameType: (id: number, name: string) => sendJson('PATCH', `/api/types/${id}`, { name }),
  deleteType: (id: number) => sendJson('DELETE', `/api/types/${id}`),

  putThumb: (id: number, blob: Blob) =>
    request<Design>(`/api/designs/${id}/thumb`, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: blob }),
  thumbFailed: (id: number) => sendJson('POST', `/api/designs/${id}/thumb-failed`),
};

export interface UploadFields {
  project_id: number;
  product_id: number | null;
  type_id: string;
  design_date: string;
  name: string;
  /** Set for a file arriving with others, to keep it in its folder on disk. */
  rel_path?: string;
}

export function uploadDesign(file: File, fields: UploadFields, onProgress: (fraction: number) => void) {
  const form = new FormData();
  form.set('project_id', String(fields.project_id));
  if (fields.product_id) form.set('product_id', String(fields.product_id));
  form.set('type_id', fields.type_id);
  form.set('design_date', fields.design_date);
  form.set('name', fields.name);
  if (fields.rel_path) form.set('rel_path', fields.rel_path);
  form.set('file', file, file.name);
  return send('/api/designs', form, onProgress);
}

export function uploadDesignFile(designId: number, file: File, relPath: string, onProgress: (fraction: number) => void) {
  const form = new FormData();
  form.set('rel_path', relPath);
  form.set('file', file, file.name);
  return send(`/api/designs/${designId}/files`, form, onProgress);
}

/** Uses XHR because fetch cannot report upload progress. */
function send(url: string, form: FormData, onProgress: (fraction: number) => void) {
  const xhr = new XMLHttpRequest();
  const done = new Promise<Design>((resolve, reject) => {
    xhr.open('POST', url);
    xhr.setRequestHeader('X-UI-Language', language);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error(xhr.response?.error ?? t('Upload failed')));
    };
    xhr.onerror = () => reject(new Error(t('The connection to the server was lost')));
    xhr.onabort = () => reject(new Error(t('Cancelled')));
    xhr.send(form);
  });
  return { done, abort: () => xhr.abort() };
}
