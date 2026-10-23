import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Activity, Check, ChevronRight, ChevronsUpDown, LogOut, Menu, Search, ServerCrash } from "lucide-react";

import { getHealth, listConnections } from "@/api/tibbou";
import CommandPalette from "@/components/CommandPalette";
import { pageTitle, workspaceInitials } from "@/components/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import { ROLE_INFO, initials } from "@/lib/members";
import { hasPermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Closes a menu on outside click or Escape.
function useDismiss(open, setOpen) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(event) {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);
  return ref;
}

function WorkspaceSwitcher() {
  const { organization, organizations, selectOrganization } = useOrganization();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, setOpen);
  if (!organization) return null;

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Workspace: ${organization.name}. Switch workspace`}
        className="flex min-w-0 max-w-[11rem] items-center gap-2 rounded-lg border border-border bg-background/60 py-1 pl-1 pr-2 text-sm transition-colors hover:bg-secondary/40 sm:max-w-[16rem]"
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/15 text-[10px] font-semibold text-primary">
          {workspaceInitials(organization.name)}
        </span>
        <span className="truncate font-medium">{organization.name}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-2xl duration-150 animate-in fade-in zoom-in-95 sm:left-0 sm:right-auto">
          <p className="px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Workspaces</p>
          <ul role="listbox" aria-label="Workspaces">
            {organizations.map((item) => {
              const current = item.id === organization.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={current}
                    onClick={() => {
                      setOpen(false);
                      if (!current) selectOrganization(item.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-secondary/50",
                      current && "bg-secondary/30"
                    )}
                  >
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-secondary text-[10px] font-semibold text-foreground">
                      {workspaceInitials(item.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{item.name}</span>
                      <span className="block text-[11px] text-muted-foreground">{ROLE_INFO[item.role]?.label || item.role}</span>
                    </span>
                    {current ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const { organization } = useOrganization();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, setOpen);
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name || "";
  const email = user?.email || "";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="grid h-8 w-8 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-primary/40"
      >
        {initials(name, email)}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl duration-150 animate-in fade-in zoom-in-95">
          <div className="border-b border-border px-4 py-3">
            {name ? <p className="truncate text-sm font-medium text-foreground">{name}</p> : null}
            <p className="truncate text-xs text-muted-foreground">{email}</p>
            {organization ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {ROLE_INFO[organization.role]?.label || organization.role} in{" "}
                <span className="text-foreground">{organization.name}</span>
              </p>
            ) : null}
          </div>
          <div className="p-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function TopBar({ onMenu }) {
  const { pathname } = useLocation();
  const { organization } = useOrganization();
  const [status, setStatus] = useState({ state: "loading", message: "Checking connection" });
  const [searchOpen, setSearchOpen] = useState(false);
  const canManageConnection = hasPermission(organization?.role, "manage_connection");

  // The pill describes the Snowflake connection, not just whether our own
  // server answers: "connected" only when this workspace has one enabled.
  useEffect(() => {
    let active = true;
    async function loadStatus() {
      try {
        await getHealth();
        const connections = organization?.id ? await listConnections() : [];
        if (!active) return;
        setStatus(
          connections.some((row) => row.enabled)
            ? { state: "healthy", message: "Snowflake connected" }
            : { state: "degraded", message: "Snowflake not connected" }
        );
      } catch {
        if (active) setStatus({ state: "error", message: "Service unavailable" });
      }
    }
    loadStatus();
    return () => {
      active = false;
    };
  }, [organization?.id]);

  useEffect(() => {
    function onKey(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tone =
    status.state === "healthy"
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
      : status.state === "error"
        ? "border-red-500/20 bg-red-500/10 text-red-300"
        : "border-amber-500/20 bg-amber-500/10 text-amber-300";
  const statusContent = (
    <>
      {status.state === "healthy" ? (
        <span className="live-dot mx-0.5" aria-hidden="true" />
      ) : status.state === "error" ? (
        <ServerCrash className="h-3.5 w-3.5" />
      ) : (
        <Activity className="h-3.5 w-3.5" />
      )}
      <span>{status.message}</span>
    </>
  );
  const statusClass = `hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs lg:flex ${tone}`;
  const title = pageTitle(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-border bg-card/70 px-4 backdrop-blur sm:px-6">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open menu"
          className="rounded-md border border-border p-2 text-muted-foreground hover:text-foreground md:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>
        <WorkspaceSwitcher />
        {title ? (
          <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-2 text-sm sm:flex">
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
            <span className="truncate font-medium text-foreground" aria-current="page">
              {title}
            </span>
          </nav>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="Search pages and datasets"
          className="flex items-center gap-2 rounded-lg border border-border bg-background/60 px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
        >
          <Search className="h-4 w-4" />
          <span className="hidden md:inline">Search…</span>
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[10px] md:inline">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
        {canManageConnection ? (
          <Link to="/settings/connection" className={cn(statusClass, "transition hover:brightness-125")}>
            {statusContent}
          </Link>
        ) : (
          <div className={statusClass}>{statusContent}</div>
        )}
        <UserMenu />
      </div>
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
