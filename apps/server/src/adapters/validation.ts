/**
 * Email validation adapters (SPEC LST-4). Cost control: the list pipeline only calls these
 * for addresses that survive the free checks (syntax, MX, SEG, suppression, disposable)
 * and are not already in the 30-day validation cache.
 */
import type { ValidationStatus } from "@cold/core";
import { hashString } from "@cold/core";
import { fetchJson, mapLimit } from "../lib/http";

export type ValidatorName = "millionverifier" | "zerobounce" | "simulated";

export interface Validator {
  name: ValidatorName;
  validate(emails: string[]): Promise<Map<string, ValidationStatus>>;
}

/** MillionVerifier single-check API: GET /api/v3/?api=KEY&email=EMAIL. One of the cheapest per check. */
export function millionVerifier(apiKey: string): Validator {
  const map: Record<string, ValidationStatus> = { ok: "valid", catch_all: "catch_all", unknown: "unknown", disposable: "disposable", invalid: "invalid" };
  return {
    name: "millionverifier",
    async validate(emails) {
      const out = new Map<string, ValidationStatus>();
      await mapLimit(emails, 8, async (email) => {
        try {
          const res = await fetchJson(`https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=10`, { timeoutMs: 30_000 });
          if (res.status === 200 && res.data?.result) out.set(email, map[res.data.result] ?? "unknown");
          else out.set(email, "unknown");
        } catch {
          out.set(email, "unknown");
        }
      });
      return out;
    },
  };
}

/** ZeroBounce v2 validate. */
export function zeroBounce(apiKey: string): Validator {
  const map: Record<string, ValidationStatus> = {
    valid: "valid",
    "catch-all": "catch_all",
    unknown: "unknown",
    invalid: "invalid",
    spamtrap: "invalid",
    abuse: "invalid",
    do_not_mail: "invalid",
  };
  return {
    name: "zerobounce",
    async validate(emails) {
      const out = new Map<string, ValidationStatus>();
      await mapLimit(emails, 5, async (email) => {
        try {
          const res = await fetchJson(`https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&ip_address=`, { timeoutMs: 30_000 });
          out.set(email, res.status === 200 ? map[String(res.data?.status)] ?? "unknown" : "unknown");
        } catch {
          out.set(email, "unknown");
        }
      });
      return out;
    },
  };
}

/** Deterministic fake validator for demos and tests. */
export const simulatedValidator: Validator = {
  name: "simulated",
  async validate(emails) {
    const out = new Map<string, ValidationStatus>();
    for (const e of emails) {
      const h = hashString(e) % 100;
      const status: ValidationStatus = e.includes("catchall") ? "catch_all" : h < 82 ? "valid" : h < 92 ? "catch_all" : h < 97 ? "invalid" : "unknown";
      out.set(e, status);
    }
    return out;
  },
};
