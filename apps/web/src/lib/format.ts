export function pct(x: number | null | undefined, digits = 1): string {
  if (x == null || !Number.isFinite(x)) return "–";
  return `${(x * 100).toFixed(digits)}%`;
}

export function num(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "–";
  return x.toLocaleString("en-US");
}

export function money(x: number | null | undefined, digits = 0): string {
  if (x == null || !Number.isFinite(x)) return "–";
  return x.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function ago(d: string | Date | null | undefined): string {
  if (!d) return "never";
  const t = new Date(d).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const fmt = (n: number, u: string) => (future ? `in ${n}${u}` : `${n}${u} ago`);
  if (a < 60) return future ? "in a moment" : "just now";
  if (a < 3600) return fmt(Math.round(a / 60), "m");
  if (a < 86400) return fmt(Math.round(a / 3600), "h");
  if (a < 86400 * 30) return fmt(Math.round(a / 86400), "d");
  return date(d);
}

export function date(d: string | Date | null | undefined): string {
  if (!d) return "–";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function dateTime(d: string | Date | null | undefined): string {
  if (!d) return "–";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

export const PROVIDER_LABEL: Record<string, string> = { google: "Google Workspace", microsoft: "Microsoft 365" };
export const PROVIDER_SHORT: Record<string, string> = { google: "Google", microsoft: "Microsoft" };
