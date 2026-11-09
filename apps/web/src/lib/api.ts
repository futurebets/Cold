import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { useToast } from "../components/toast";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-cold-csrf": "1" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
  return data as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });
export const put = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: "PUT", body });
export const patch = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: "PATCH", body });
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE", body: {} });

/** GET with react-query. The path is the cache key, so invalidate by path prefix. */
export function useGet<T = any>(path: string | null, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => get<T>(path!),
    enabled: !!path,
    ...opts,
  });
}

/**
 * Mutation with toasts and cache invalidation.
 * `invalidate` entries are path prefixes, e.g. ["/domains"] refreshes "/domains" and "/domains/123".
 */
export function useAction<TArgs = void, TRes = any>(
  fn: (args: TArgs) => Promise<TRes>,
  opts: { invalidate?: string[]; success?: string | ((r: TRes) => string | null); onSuccess?: (r: TRes) => void; onError?: (e: ApiError) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TRes, ApiError, TArgs>({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const p of opts.invalidate ?? []) qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith(p) });
      qc.invalidateQueries({ queryKey: ["/overview"] });
      const msg = typeof opts.success === "function" ? opts.success(r) : opts.success;
      if (msg) toast.show({ tone: "success", title: msg });
      opts.onSuccess?.(r);
    },
    onError: (e) => {
      if (opts.onError) opts.onError(e);
      else toast.show({ tone: "error", title: e.message, body: blockerText(e) });
    },
  });
}

export function blockerText(e: ApiError): string | undefined {
  const b = e.details?.blockers as { message: string }[] | undefined;
  if (b && b.length > 1) return b.slice(1).map((x) => x.message).join(" ");
  return undefined;
}
