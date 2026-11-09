/**
 * Simulated transport: lets the whole system run end-to-end without real mailboxes
 * (demo mode, tests, and training new operators). Outcomes follow each domain's profile.
 */
import { randomUUID } from "node:crypto";
import type { Folder } from "@cold/core";
import { seededRandom } from "@cold/core";
import type { InboundItem, MailboxCtx, OutgoingMessage, SentResult, SimProfile, Transport } from "./types";

interface Queued extends InboundItem {
  availableAt: number;
}

const inboxes = new Map<string, Queued[]>();
const placements = new Map<string, Folder>();
const headerStore = new Map<string, string>();

/** Minutes until simulated replies/bounces arrive. Small by default so demos feel alive. */
const DELAY_MIN = Number(process.env.SIM_DELAY_MINUTES ?? 3);

const REPLIES: { body: string; weight: number }[] = [
  { body: "Interested. Can you send over a bit more detail?", weight: 18 },
  { body: "Sounds interesting, tell me more. What does pricing look like?", weight: 12 },
  { body: "Not interested, thanks.", weight: 20 },
  { body: "We're all set for now.", weight: 10 },
  { body: "Please remove me from your list.", weight: 6 },
  { body: "You should talk to Sam on our ops team, the right person is sam@{domain}", weight: 8 },
  { body: "What would this look like for a team of our size?", weight: 12 },
  { body: "no", weight: 4 },
  { body: "Happy to chat next week. Tuesday works.", weight: 10 },
];

function pick<T extends { weight: number }>(xs: T[], r: number): T {
  const total = xs.reduce((a, x) => a + x.weight, 0);
  let acc = 0;
  for (const x of xs) {
    acc += x.weight / total;
    if (r <= acc) return x;
  }
  return xs[xs.length - 1];
}

function enqueue(mailbox: string, item: Omit<Queued, "providerMessageId" | "receivedAt" | "availableAt"> & { delayMin: number }) {
  const list = inboxes.get(mailbox) ?? [];
  const availableAt = Date.now() + item.delayMin * 60_000;
  list.push({ ...item, providerMessageId: randomUUID(), receivedAt: new Date(availableAt), availableAt });
  inboxes.set(mailbox, list);
}

const DEFAULT_PROFILE: SimProfile = { replyRate: 0.03, bounceRate: 0.01, placement: "good" };

export const simulatedTransport: Transport = {
  async send(m: MailboxCtx, msg: OutgoingMessage): Promise<SentResult> {
    const providerThreadId = msg.providerThreadId ?? `sim-thread-${randomUUID()}`;
    const rfc = msg.messageId;
    const profile = msg.sim?.profile ?? DEFAULT_PROFILE;
    const rand = seededRandom(rfc);
    const kind = msg.sim?.kind;

    if (kind === "seed" || kind === "header_test") {
      const arm = msg.sim?.arm;
      const r = rand();
      let folder: Folder = "inbox";
      // Burned infrastructure: everything from it is filtered, whatever the copy.
      if (profile.placement === "burned") folder = r < 0.85 ? "spam" : "missing";
      else if (profile.placement === "bad_copy" && arm === "campaign") folder = r < 0.9 ? "spam" : "inbox";
      else folder = r < 0.06 ? "promotions" : r < 0.1 ? "spam" : "inbox";
      placements.set(rfc, folder);
      const d = m.domainName;
      headerStore.set(
        rfc,
        [
          `Delivered-To: ${msg.to}`,
          `Authentication-Results: mx.google.com;`,
          `       dkim=pass header.i=@${d} header.s=google header.b=SIM;`,
          `       spf=pass (google.com: domain of ${m.address} designates 203.0.113.7 as permitted sender) smtp.mailfrom=${m.address};`,
          `       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${d}`,
          `From: ${m.displayName} <${m.address}>`,
          `To: ${msg.to}`,
          `Subject: ${msg.subject}`,
          `Message-ID: ${rfc}`,
        ].join("\n"),
      );
      return { providerMessageId: `sim-${randomUUID()}`, providerThreadId, rfcMessageId: rfc };
    }

    if (kind === "first_touch" || kind === "follow_up") {
      const r = rand();
      const recipientDomain = msg.to.split("@")[1] ?? "example.com";
      if (r < profile.bounceRate) {
        const spamBlock = profile.placement === "burned" && rand() < 0.6;
        enqueue(m.id, {
          providerThreadId,
          rfcMessageId: `<${randomUUID()}@mx.sim>`,
          inReplyTo: rfc,
          references: rfc,
          from: "mailer-daemon@googlemail.com",
          fromName: "Mail Delivery Subsystem",
          to: m.address,
          subject: "Delivery Status Notification (Failure)",
          body: spamBlock
            ? `Your message wasn't delivered to ${msg.to}.\n\nThe response was:\n550 5.7.1 Message rejected due to sender reputation (policy).`
            : `Address not found\n\nYour message wasn't delivered to ${msg.to} because the address couldn't be found.\n\n550 5.1.1 The email account that you tried to reach does not exist.`,
          headers: {},
          folder: "inbox",
          delayMin: DELAY_MIN * 0.5,
        });
      } else if (rand() < profile.replyRate) {
        const ooo = rand() < 0.15;
        const reply = pick(REPLIES, rand());
        enqueue(m.id, {
          providerThreadId,
          rfcMessageId: `<${randomUUID()}@${recipientDomain}>`,
          inReplyTo: rfc,
          references: [msg.references, rfc].filter(Boolean).join(" "),
          from: msg.to,
          to: m.address,
          subject: ooo ? `Automatic reply: ${msg.subject}` : `Re: ${msg.subject.replace(/^re:\s*/i, "")}`,
          body: ooo
            ? "I am currently out of the office with limited access to email and will return next Monday."
            : `${reply.body.replace("{domain}", recipientDomain)}\n\nOn ${new Date().toDateString()}, ${m.displayName} wrote:\n> ${msg.text.split("\n").join("\n> ")}`,
          headers: ooo ? { "Auto-Submitted": "auto-replied" } : {},
          folder: "inbox",
          delayMin: DELAY_MIN * (1 + rand() * 4),
        });
      }
    }
    return { providerMessageId: `sim-${randomUUID()}`, providerThreadId, rfcMessageId: rfc };
  },

  async fetchInbound(m: MailboxCtx, cursor: string | null) {
    const list = inboxes.get(m.id) ?? [];
    const now = Date.now();
    const ready = list.filter((x) => x.availableAt <= now);
    inboxes.set(
      m.id,
      list.filter((x) => x.availableAt > now),
    );
    return { items: ready, cursor: cursor ?? "sim" };
  },

  async locate(_seed: MailboxCtx, rfcMessageId: string): Promise<Folder> {
    return placements.get(rfcMessageId) ?? "missing";
  },

  async rawHeaders(_seed: MailboxCtx, rfcMessageId: string) {
    return headerStore.get(rfcMessageId) ?? null;
  },

  async test(m: MailboxCtx) {
    return { ok: true, detail: `Simulated mailbox ${m.address}` };
  },
};
