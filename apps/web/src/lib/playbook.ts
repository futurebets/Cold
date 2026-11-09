/** The 14 rules the product enforces (SPEC Appendix B), used for "Rule n" tags and tooltips. */
export const RULES: Record<number, { title: string; text: string }> = {
  1: { title: "Protect your primary domain", text: "Send cold email from separate domains that resemble your brand." },
  2: { title: "Google Workspace or Microsoft only", text: "Avoid cheap SMTP providers. They tend to fail when spam filters change." },
  3: { title: "Microsoft is cheaper, Google is easier", text: "Microsoft is five to six times cheaper, while Google is easier to manage." },
  4: { title: "Limit domain volume", text: "Google: ~15 from each of 3 inboxes (45/domain/day). Microsoft: 3 from each of up to 50 inboxes (150/domain/day)." },
  5: { title: "Authenticate every domain", text: "Confirm SPF, DKIM and DMARC, then send yourself a test email and inspect the headers." },
  6: { title: "Warm every inbox", text: "At least two weeks, a month is better. Never start sending immediately." },
  7: { title: "Two infrastructure sets", text: "Keep one sending and one warming. Hypertide's Recovery Pool warms replacements without paying for them as active." },
  8: { title: "Clean your list", text: "Validate every address, separate catch-alls, remove prospects behind Proofpoint, Barracuda or Mimecast, and mix recipient providers." },
  9: { title: "Short, plain-text emails", text: "No images, formatting, links, long signatures or corporate language. Simple offer, soft CTA like “Interested?”" },
  10: { title: "No open tracking", text: "The data is unreliable and the pixel adds deliverability risk. Track replies and bounces instead." },
  11: { title: "Stagger your sending", text: "Business hours, randomized start times so inboxes don't fire together. Test Saturdays for SMB and mid-market." },
  12: { title: "Measure enough volume", text: "At least 1,000 emails, wait 48 hours, compare to the domain's baseline. Reply < 1% plus bounce > 3% is a clear warning." },
  13: { title: "Diagnose before replacing", text: "Test neutral control copy against campaign copy from the same inbox. Only campaign fails → rewrite. Both fail → replace infrastructure." },
  14: { title: "Rotate without stopping", text: "Swap in warmed domains, use Relay to preserve replies, and use the 15-day Layover if replacements need more time." },
};
