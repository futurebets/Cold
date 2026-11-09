/** Request-shape tests for the real provider adapters, with fetch mocked. */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "test-secret-test-secret-test-secret-123";
const { graphTransport } = await import("../src/adapters/transport/graph");
const { gmailTransport } = await import("../src/adapters/transport/gmail");
const { millionVerifier } = await import("../src/adapters/validation");
const { buildMime, decodeQuotedPrintable, quotedPrintable } = await import("../src/lib/mime");

type Call = { url: string; init: RequestInit };
function mockFetch(responder: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responder(url, init);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("MIME", () => {
  it("builds plain-text only messages with threading headers", () => {
    const mime = buildMime({ from: { address: "jane@getacme.com", name: "Jane Doe" }, to: "bob@x.com", subject: "Re: quick question", text: "Hi Bob,\n\nInterested?\n", messageId: "<a@getacme.com>", inReplyTo: "<b@getacme.com>", references: "<b@getacme.com>" });
    expect(mime).toMatch(/^From: "Jane Doe" <jane@getacme.com>\r\n/);
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain("In-Reply-To: <b@getacme.com>");
    expect(mime).not.toMatch(/text\/html|multipart/i);
  });
  it("round-trips quoted-printable with UTF-8 and long lines", () => {
    const text = "Héllo — " + "x".repeat(200) + " \nline two";
    expect(decodeQuotedPrintable(quotedPrintable(text))).toBe(text.replace(/ \n/, " \n"));
    for (const line of quotedPrintable(text).split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  });
});

const msMailbox = {
  id: "m1",
  address: "jane@getacme.com",
  displayName: "Jane Doe",
  domainName: "getacme.com",
  tenant: { id: "t1", provider: "microsoft" as const, transport: "api" as const, config: { tenantId: "tid", clientId: "cid" }, secret: "s3cret" },
};

describe("Microsoft Graph transport", () => {
  it("gets an app token, creates a MIME draft and sends it", async () => {
    const calls = mockFetch((url) => {
      if (url.includes("login.microsoftonline.com")) return { body: { access_token: "AT", expires_in: 3600 } };
      if (url.endsWith("/messages") ) return { status: 201, body: { id: "draft1", internetMessageId: "<srv@getacme.com>", conversationId: "conv1" } };
      if (url.endsWith("/send")) return { status: 202, body: "" };
      return { status: 404, body: {} };
    });
    const r = await graphTransport.send(msMailbox, { to: "bob@x.com", subject: "quick question", text: "Hi\n", messageId: "<a@getacme.com>" });
    expect(r).toEqual({ providerMessageId: "draft1", providerThreadId: "conv1", rfcMessageId: "<srv@getacme.com>" });
    expect(calls[0].url).toBe("https://login.microsoftonline.com/tid/oauth2/v2.0/token");
    expect(String(calls[0].init.body)).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
    expect(calls[1].url).toBe("https://graph.microsoft.com/v1.0/users/jane%40getacme.com/messages");
    expect((calls[1].init.headers as any)["Content-Type"]).toBe("text/plain");
    expect(Buffer.from(String(calls[1].init.body), "base64").toString()).toContain("Subject: quick question");
    expect(calls[2].url).toBe("https://graph.microsoft.com/v1.0/users/jane%40getacme.com/messages/draft1/send");
  });
  it("surfaces auth failures as ProviderError(auth)", async () => {
    mockFetch(() => ({ status: 400, body: { error_description: "AADSTS7000215: Invalid client secret" } }));
    await expect(graphTransport.send({ ...msMailbox, tenant: { ...msMailbox.tenant, config: { tenantId: "tid2", clientId: "cid2" } } }, { to: "b@x.com", subject: "s", text: "t", messageId: "<x@y>" })).rejects.toMatchObject({ auth: true });
  });
});

describe("Gmail transport", () => {
  it("signs a delegated JWT and sends raw MIME", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = JSON.stringify({ client_email: "cold@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    const calls = mockFetch((url) => {
      if (url.includes("oauth2.googleapis.com")) return { body: { access_token: "GT", expires_in: 3600 } };
      if (url.endsWith("/messages/send")) return { body: { id: "g1", threadId: "th1" } };
      if (url.includes("format=metadata")) return { body: { payload: { headers: [{ name: "Message-ID", value: "<a@getacme.com>" }] } } };
      return { status: 404, body: {} };
    });
    const mb = { ...msMailbox, tenant: { id: "t2", provider: "google" as const, transport: "api" as const, config: {}, secret: sa } };
    const r = await gmailTransport.send(mb, { to: "bob@x.com", subject: "hi", text: "Hi\n", messageId: "<a@getacme.com>", providerThreadId: "th0" });
    expect(r).toEqual({ providerMessageId: "g1", providerThreadId: "th1", rfcMessageId: "<a@getacme.com>" });
    const assertion = new URLSearchParams(String(calls[0].init.body)).get("assertion")!;
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ iss: "cold@proj.iam.gserviceaccount.com", sub: "jane@getacme.com", scope: "https://www.googleapis.com/auth/gmail.modify" });
    const sent = JSON.parse(String(calls[1].init.body));
    expect(sent.threadId).toBe("th0");
    expect(Buffer.from(sent.raw, "base64url").toString()).toContain("To: bob@x.com");
  });
});

describe("MillionVerifier", () => {
  it("maps results", async () => {
    mockFetch((url) => ({ body: { result: url.includes("good") ? "ok" : url.includes("ca") ? "catch_all" : "invalid" } }));
    const r = await millionVerifier("KEY").validate(["good@x.com", "ca@y.com", "bad@z.com"]);
    expect(Object.fromEntries(r)).toEqual({ "good@x.com": "valid", "ca@y.com": "catch_all", "bad@z.com": "invalid" });
  });
});
