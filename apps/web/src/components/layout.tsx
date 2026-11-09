import { useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import clsx from "clsx";
import {
  Activity,
  Bell,
  Calculator,
  FlaskConical,
  Globe,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Megaphone,
  RefreshCcw,
  Settings,
  ShieldCheck,
  Users,
  ScrollText,
  X,
} from "lucide-react";
import { post, useGet } from "../lib/api";
import { Badge } from "./ui";
import { ago } from "../lib/format";
import { useQueryClient } from "@tanstack/react-query";

export function Logo({ className }: { className?: string }) {
  return (
    <div className={clsx("flex items-center gap-2", className)}>
      <svg viewBox="0 0 32 32" className="size-7">
        <rect width="32" height="32" rx="8" fill="#1e3a8a" />
        <path d="M16 6v20M7.3 11l17.4 10M7.3 21l17.4-10" stroke="#bfdbfe" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <span className="text-[17px] font-semibold tracking-tight text-ink-900">Cold</span>
    </div>
  );
}

const NAV: { group?: string; items: { to: string; label: string; icon: ReactNode; end?: boolean }[] }[] = [
  { items: [{ to: "/", label: "Overview", icon: <LayoutDashboard />, end: true }] },
  {
    group: "Infrastructure",
    items: [
      { to: "/domains", label: "Domains", icon: <Globe /> },
      { to: "/reserve", label: "Reserve", icon: <ShieldCheck /> },
      { to: "/planner", label: "Planner", icon: <Calculator /> },
    ],
  },
  {
    group: "Outreach",
    items: [
      { to: "/lists", label: "Lists", icon: <Users /> },
      { to: "/campaigns", label: "Campaigns", icon: <Megaphone /> },
      { to: "/inbox", label: "Inbox", icon: <Inbox /> },
    ],
  },
  {
    group: "Deliverability",
    items: [
      { to: "/health", label: "Health", icon: <Activity /> },
      { to: "/diagnoses", label: "Diagnoses", icon: <FlaskConical /> },
      { to: "/rotations", label: "Rotations", icon: <RefreshCcw /> },
      { to: "/activity", label: "Send log", icon: <ScrollText /> },
    ],
  },
  { group: "Workspace", items: [{ to: "/settings", label: "Settings", icon: <Settings /> }] },
];

export function Layout({ user }: { user: { name: string; email: string; role: string } }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const overview = useGet<any>("/overview", { refetchInterval: 60_000 });
  const threads = useGet<any>("/threads?filter=unread", { refetchInterval: 60_000 });
  const alertCount = overview.data?.alerts?.filter((a: any) => a.severity !== "info").length ?? 0;
  const unread = threads.data?.counts?.unread ?? 0;

  const sidebar = (
    <nav className="flex h-full flex-col">
      <div className="flex h-14 items-center px-5">
        <Logo />
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {NAV.map((g, i) => (
          <div key={i}>
            {g.group && <p className="mb-1 px-2 text-[11px] font-semibold tracking-wider text-ink-400 uppercase">{g.group}</p>}
            <ul className="space-y-0.5">
              {g.items.map((it) => (
                <li key={it.to}>
                  <NavLink
                    to={it.to}
                    end={it.end}
                    onClick={() => setMobileOpen(false)}
                    className={({ isActive }) =>
                      clsx(
                        "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors [&>svg]:size-4",
                        isActive ? "bg-brand-50 text-brand-700 [&>svg]:text-brand-600" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900 [&>svg]:text-ink-400",
                      )
                    }
                  >
                    {it.icon}
                    <span className="flex-1">{it.label}</span>
                    {it.to === "/inbox" && unread > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{unread}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <UserFooter user={user} />
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/30" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-200 bg-white/80 px-4 backdrop-blur lg:px-8">
          <button className="rounded-md p-1.5 text-ink-500 hover:bg-ink-100 lg:hidden" onClick={() => setMobileOpen(true)}>
            {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <span className="truncate text-sm font-medium text-ink-700">{overview.data?.workspace?.name}</span>
          {overview.data?.workspace?.simulation && (
            <Badge tone="violet" title="Mailboxes, DNS and validation are simulated. Nothing is really sent.">
              Simulation mode
            </Badge>
          )}
          <div className="flex-1" />
          <AlertsBell count={alertCount} alerts={overview.data?.alerts ?? []} />
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1280px] px-4 py-6 lg:px-8 lg:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function AlertsBell({ count, alerts }: { count: number; alerts: any[] }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="relative rounded-lg p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-800" aria-label="Alerts">
        <Bell className="size-5" />
        {count > 0 && <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">{count > 9 ? "9+" : count}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="animate-in absolute right-0 z-40 mt-2 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-ink-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
              <p className="text-sm font-semibold">Needs attention</p>
              <ListChecks className="size-4 text-ink-400" />
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {alerts.length === 0 && <p className="px-4 py-8 text-center text-sm text-ink-500">All clear.</p>}
              {alerts.map((a) => (
                <button
                  key={a.id}
                  className="block w-full border-b border-ink-100 px-4 py-3 text-left last:border-0 hover:bg-ink-50"
                  onClick={() => {
                    setOpen(false);
                    if (a.actionHref) navigate(a.actionHref);
                  }}
                >
                  <div className="flex items-start gap-2">
                    <span className={clsx("mt-1.5 size-2 shrink-0 rounded-full", a.severity === "critical" ? "bg-red-500" : a.severity === "warning" ? "bg-amber-500" : "bg-brand-400")} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink-800">{a.title}</p>
                      <p className="mt-0.5 text-xs text-ink-500">{ago(a.createdAt)}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UserFooter({ user }: { user: { name: string; email: string; role: string } }) {
  const qc = useQueryClient();
  return (
    <div className="flex items-center gap-2.5 border-t border-ink-200 p-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">{(user.name || user.email).slice(0, 1).toUpperCase()}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink-800">{user.name || user.email}</p>
        <p className="truncate text-xs text-ink-500 capitalize">{user.role}</p>
      </div>
      <button
        title="Sign out"
        className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
        onClick={async () => {
          await post("/auth/logout");
          qc.clear();
          window.location.href = "/";
        }}
      >
        <LogOut className="size-4" />
      </button>
    </div>
  );
}
