import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import clsx from "clsx";
import { Archive, ArchiveRestore, ArrowLeft, Inbox as InboxIcon, Search, Send, ShieldAlert } from "lucide-react";
import { post, useAction, useGet } from "../lib/api";
import { ago, dateTime } from "../lib/format";
import { Badge, Button, Callout, EmptyState, ErrorState, Input, Loading, PageHeader, RuleTag, Spinner, Textarea } from "../components/ui";
import { IntentBadge } from "../components/badges";

interface ThreadRow {
  id: string;
  subject: string;
  counterpart: string;
  lastMessageAt: string;
  classification: string | null;
  intent: string | null;
  unread: boolean;
  needsReview: boolean;
  archived: boolean;
  snippet: string;
  mailbox: { address: string; state: string };
  domain: { name: string; state: string } | null;
  prospect: { firstName: string | null; lastName: string | null; company: string | null; title: string | null } | null;
}

interface ThreadDetail {
  thread: ThreadRow & { mailboxId: string };
  messages: { id: string; direction: "in" | "out"; fromAddr: string; toAddr: string; subject: string; bodyText: string; createdAt: string; classification: string | null; intent: string | null }[];
  mailbox: { address: string; state: string; connection: string; firstName: string; lastName: string };
  domain: { name: string; state: string } | null;
  prospect: { email: string; firstName: string | null; lastName: string | null; company: string | null; title: string | null; recipientProvider: string | null } | null;
}

const FILTERS = [
  { value: "replies", label: "Replies" },
  { value: "positive", label: "Positive", countKey: "positive" },
  { value: "review", label: "Needs review", countKey: "review" },
  { value: "unread", label: "Unread", countKey: "unread" },
  { value: "auto", label: "Auto & bounces" },
  { value: "all", label: "All" },
] as const;

const KEPT_STATES = ["relay", "layover", "retired"];

const nameOf = (t: { prospect: ThreadRow["prospect"]; counterpart: string }) => [t.prospect?.firstName, t.prospect?.lastName].filter(Boolean).join(" ") || t.counterpart;

export default function InboxPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("replies");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const qs = `${filter === "replies" ? "" : `filter=${filter}`}${debounced ? `${filter === "replies" ? "" : "&"}search=${encodeURIComponent(debounced)}` : ""}`;
  const list = useGet<{ threads: ThreadRow[]; counts: { positive: number; review: number; unread: number } }>(`/threads${qs ? `?${qs}` : ""}`, { refetchInterval: 30_000, placeholderData: (p) => p });

  return (
    <div>
      <PageHeader
        title="Inbox"
        rules={[14]}
        description="Every reply from every inbox in one place, including domains you've rotated out. Conversations are never dropped when infrastructure changes."
      />
      <div className="flex h-[calc(100vh-13rem)] min-h-[520px] overflow-hidden rounded-xl border border-ink-200 bg-white shadow-xs">
        <div className={clsx("flex w-full flex-col border-r border-ink-200 md:w-[380px] md:shrink-0", id && "hidden md:flex")}>
          <div className="space-y-2.5 border-b border-ink-100 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people or subjects" className="h-9 pl-8" />
            </div>
            <div className="flex gap-1 overflow-x-auto pb-0.5">
              {FILTERS.map((f) => {
                const count = "countKey" in f ? list.data?.counts?.[f.countKey] : undefined;
                return (
                  <button
                    key={f.value}
                    onClick={() => setFilter(f.value)}
                    className={clsx(
                      "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                      filter === f.value ? "bg-brand-600 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200",
                    )}
                  >
                    {f.label}
                    {count ? <span className={clsx("rounded-full px-1 text-[10px]", filter === f.value ? "bg-white/25" : "bg-white")}>{count}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {list.isLoading ? (
              <Loading />
            ) : list.error ? (
              <div className="p-4">
                <ErrorState error={list.error} />
              </div>
            ) : !list.data?.threads.length ? (
              <EmptyState icon={<InboxIcon className="size-6" />} title={debounced ? "No matches" : "Nothing here yet"}>
                {debounced ? "Try another name or subject." : filter === "replies" ? "Replies from prospects land here as inboxes sync (every couple of minutes)." : "No conversations in this view."}
              </EmptyState>
            ) : (
              <ul>
                {list.data.threads.map((t) => (
                  <li key={t.id}>
                    <button
                      onClick={() => navigate(`/inbox/${t.id}`)}
                      className={clsx("block w-full border-b border-ink-100 px-4 py-3 text-left transition-colors", id === t.id ? "bg-brand-50/70" : "hover:bg-ink-50")}
                    >
                      <div className="flex items-center gap-2">
                        {t.unread && <span className="size-2 shrink-0 rounded-full bg-brand-600" />}
                        <span className={clsx("min-w-0 flex-1 truncate text-sm", t.unread ? "font-semibold text-ink-900" : "font-medium text-ink-800")}>{nameOf(t)}</span>
                        <span className="shrink-0 text-xs text-ink-400">{ago(t.lastMessageAt)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        {t.prospect?.company && <span className="truncate text-xs text-ink-500">{t.prospect.company}</span>}
                        <span className="flex-1" />
                        {t.needsReview && <Badge tone="amber">Review</Badge>}
                        {t.classification === "bounce" ? <Badge tone="red">Bounce</Badge> : t.classification === "auto_reply" ? <Badge tone="gray">Auto-reply</Badge> : <IntentBadge intent={t.intent} />}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-ink-500">{t.snippet || t.subject}</p>
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-400">
                        <span className="truncate">via {t.mailbox.address}</span>
                        {t.domain && KEPT_STATES.includes(t.domain.state) && (
                          <Badge tone="violet" className="py-0 text-[10px]" title="This domain was rotated out. Replies still arrive here.">
                            Kept via Relay
                          </Badge>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className={clsx("min-w-0 flex-1 flex-col", id ? "flex" : "hidden md:flex")}>
          {id ? (
            <ThreadView id={id} onBack={() => navigate("/inbox")} />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState icon={<InboxIcon className="size-6" />} title="Select a conversation">
                Reply in-thread from the original inbox. Cold sends it as plain text.
              </EmptyState>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function splitQuoted(body: string): { main: string; quoted: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex((l, i) => /^\s*>/.test(l) || /^On .{5,200}wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || (i > 0 && /^From:\s.+/i.test(l.trim())));
  if (idx <= 0) return { main: body.trim(), quoted: "" };
  return { main: lines.slice(0, idx).join("\n").trim(), quoted: lines.slice(idx).join("\n").trim() };
}

function ThreadView({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useGet<ThreadDetail>(`/threads/${id}`);
  const [reply, setReply] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [t.data?.messages.length]);
  const send = useAction(() => post(`/threads/${id}/reply`, { body: reply }), {
    invalidate: ["/threads"],
    success: "Reply sent from the original inbox",
    onSuccess: () => setReply(""),
  });
  const review = useAction((suppress: boolean) => post(`/threads/${id}/review`, { suppress }), {
    invalidate: ["/threads", "/suppressions"],
    success: (_r) => "Review saved",
  });
  const archive = useAction((archived: boolean) => post(`/threads/${id}/archive`, { archived }), { invalidate: ["/threads"], success: (_r) => "Updated" });

  if (t.isLoading) return <Loading />;
  if (t.error || !t.data) return <div className="p-6"><ErrorState error={t.error} /></div>;
  const { thread, messages, mailbox, domain, prospect } = t.data;
  const kept = domain && KEPT_STATES.includes(domain.state);
  const canReply = mailbox && mailbox.state !== "decommissioned" && mailbox.connection === "connected";
  const who = [prospect?.firstName, prospect?.lastName].filter(Boolean).join(" ") || thread.counterpart;

  return (
    <>
      <div className="flex items-start gap-3 border-b border-ink-100 px-5 py-3.5">
        <button className="mt-0.5 rounded-md p-1 text-ink-500 hover:bg-ink-100 md:hidden" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink-900">{thread.subject || "(no subject)"}</p>
          <p className="mt-0.5 truncate text-xs text-ink-500">
            {who}
            {prospect?.title ? ` · ${prospect.title}` : ""}
            {prospect?.company ? ` · ${prospect.company}` : ""} — via {mailbox?.address}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IntentBadge intent={thread.intent} />
          <Button size="sm" variant="ghost" icon={thread.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />} loading={archive.isPending} onClick={() => archive.mutate(!thread.archived)}>
            {thread.archived ? "Unarchive" : "Archive"}
          </Button>
        </div>
      </div>

      {(thread.needsReview || kept) && (
        <div className="space-y-2 border-b border-ink-100 px-5 py-3">
          {thread.needsReview && (
            <Callout
              tone="amber"
              title="Possible opt-out"
              action={
                <div className="flex gap-2">
                  <Button size="sm" variant="danger" icon={<ShieldAlert className="size-3.5" />} loading={review.isPending} onClick={() => review.mutate(true)}>
                    Suppress
                  </Button>
                  <Button size="sm" onClick={() => review.mutate(false)}>
                    Keep
                  </Button>
                </div>
              }
            >
              This reads like “not interested”. The sequence already stopped. Suppress the address everywhere, or keep them for future campaigns.
            </Callout>
          )}
          {kept && (
            <Callout tone="gray">
              <span className="flex flex-wrap items-center gap-1.5">
                {domain!.name} was rotated out ({domain!.state}). Its replies are still collected here so no conversation is lost. <RuleTag n={14} />
              </span>
            </Callout>
          )}
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto bg-ink-50/50 px-5 py-5">
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        <div ref={bottom} />
      </div>

      <div className="border-t border-ink-200 bg-white p-4">
        {canReply ? (
          <>
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={`Reply to ${prospect?.firstName ?? who} as ${mailbox.firstName || mailbox.address}…`}
              className="min-h-24"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && reply.trim()) send.mutate();
              }}
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-xs text-ink-500">
                Plain text, in-thread, from {mailbox.address}. Signature added automatically. <span className="kbd">⌘</span> <span className="kbd">Enter</span> to send.
              </p>
              <Button variant="primary" icon={send.isPending ? <Spinner className="size-4 text-white" /> : <Send className="size-4" />} disabled={!reply.trim() || send.isPending} onClick={() => send.mutate()}>
                Send
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-500">
            {mailbox?.state === "decommissioned" ? "This inbox has been decommissioned. The conversation history is kept, but it can't send." : "This inbox is disconnected. Reconnect it under Domains to reply."}
          </p>
        )}
      </div>
    </>
  );
}

function Message({ m }: { m: ThreadDetail["messages"][number] }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const { main, quoted } = splitQuoted(m.bodyText);
  const out = m.direction === "out";
  const system = m.classification === "bounce" || m.classification === "auto_reply";
  return (
    <div className={clsx("flex", out ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[85%] rounded-2xl px-4 py-3 shadow-xs",
          out ? "rounded-br-md bg-brand-600 text-white" : system ? "rounded-bl-md border border-dashed border-ink-300 bg-white text-ink-600" : "rounded-bl-md border border-ink-200 bg-white text-ink-800",
        )}
      >
        <div className={clsx("mb-1 flex items-center gap-2 text-[11px]", out ? "text-brand-100" : "text-ink-400")}>
          <span className="truncate">{out ? `You (${m.fromAddr})` : m.fromAddr}</span>
          <span>·</span>
          <span className="shrink-0">{dateTime(m.createdAt)}</span>
          {m.classification === "bounce" && <Badge tone="red">Bounce</Badge>}
          {m.classification === "auto_reply" && <Badge tone="gray">Auto-reply</Badge>}
        </div>
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{main || "(empty message)"}</p>
        {quoted && (
          <>
            <button onClick={() => setShowQuoted(!showQuoted)} className={clsx("mt-2 text-xs font-medium", out ? "text-brand-100 hover:text-white" : "text-ink-400 hover:text-ink-600")}>
              {showQuoted ? "Hide quoted text" : "··· Show quoted text"}
            </button>
            {showQuoted && <p className={clsx("mt-1 border-l-2 pl-3 text-xs whitespace-pre-wrap", out ? "border-brand-300 text-brand-100" : "border-ink-200 text-ink-500")}>{quoted}</p>}
          </>
        )}
      </div>
    </div>
  );
}
