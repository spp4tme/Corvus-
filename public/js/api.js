// Client API : cookie de session HttpOnly + en-tête anti-CSRF X-Corvus.
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(method, url, body, { signal, raw } = {}) {
  const headers = { 'X-Corvus': '1' };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    payload = body;
    headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Serveur Corvus injoignable (réseau ou Tailscale coupé ?)');
  }
  if (raw && res.ok) return res;
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const e = data?.error || {};
    if (res.status === 401 && e.code === 'UNAUTHENTICATED') onUnauthorized();
    throw new ApiError(res.status, e.code || 'HTTP', e.message || `Erreur HTTP ${res.status}`, e.details);
  }
  return data;
}

export const get = (url, opts) => api('GET', url, undefined, opts);
export const post = (url, body, opts) => api('POST', url, body ?? {}, opts);
export const patch = (url, body) => api('PATCH', url, body);
export const put = (url, body) => api('PUT', url, body);
export const del = (url, body) => api('DELETE', url, body);

/** Upload avec progression (fetch ne fournit pas de progression d'envoi). */
export function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Corvus', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code || 'HTTP', data?.error?.message || `Erreur HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Envoi interrompu'));
    xhr.send(file);
  });
}

export const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)).toString();
