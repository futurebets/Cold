import type { Transport, TenantCtx } from "./types";
import { graphTransport } from "./graph";
import { gmailTransport } from "./gmail";
import { simulatedTransport } from "./simulated";

export * from "./types";

export function transportFor(tenant: Pick<TenantCtx, "provider" | "transport">): Transport {
  if (tenant.transport === "simulated") return simulatedTransport;
  return tenant.provider === "microsoft" ? graphTransport : gmailTransport;
}
