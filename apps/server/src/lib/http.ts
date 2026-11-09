export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const forbidden = (msg = "You don't have permission to do that") => new HttpError(403, msg);
export const notFound = (what = "Not found") => new HttpError(404, what);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);

export function assert(cond: unknown, err: HttpError): asserts cond {
  if (!cond) throw err;
}

/** Fetch with a timeout and JSON error surfacing. */
export async function fetchJson<T = any>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; data: T; headers: Headers }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, data, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
    /** 401/403: credentials or permissions problem; mailbox should be marked disconnected. */
    public auth = status === 401 || status === 403,
    public transient = status === 429 || status >= 500 || status === 0,
  ) {
    super(message);
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
