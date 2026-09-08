import { Link, useLocation } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  DollarSign,
  GitBranch,
  LayoutDashboard,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/datasets", label: "Datasets", icon: Database },
  { path: "/lineage", label: "Lineage", icon: GitBranch },
  { path: "/costs", label: "Costs", icon: DollarSign },
];

export default function Sidebar() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "sticky top-0 flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300",
        collapsed ? "w-[68px]" : "w-[240px]"
      )}
    >
      <div className="flex h-16 items-center border-b border-sidebar-border px-4">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/20">
            <GitBranch className="h-4 w-4 text-primary" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <span className="whitespace-nowrap text-lg font-semibold tracking-tight text-foreground">
                Tibbou
              </span>
              <p className="truncate text-[11px] text-sidebar-foreground">
                Data lineage and cost visibility
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="border-b border-sidebar-border px-4 py-3">
        {!collapsed ? (
          <div className="rounded-lg border border-sidebar-border bg-sidebar-accent px-3 py-2">
            <p className="text-xs font-medium text-foreground">Workspace</p>
            <p className="mt-1 text-[11px] leading-5 text-sidebar-foreground">
              Follow datasets, dependencies, and cost activity in one place.
            </p>
          </div>
        ) : (
          <div className="h-9 rounded-lg border border-sidebar-border bg-sidebar-accent" />
        )}
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
              )}
            >
              <item.icon
                className={cn("h-5 w-5 flex-shrink-0", isActive && "text-primary")}
              />
              {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="mx-3 mb-3 rounded-lg border border-sidebar-border bg-sidebar-accent px-3 py-2">
        {!collapsed ? (
          <>
            <p className="text-xs font-medium text-foreground">Overview</p>
            <p className="mt-1 text-[11px] leading-5 text-sidebar-foreground">
              Use these views to explore tracked assets and the latest warehouse activity.
            </p>
          </>
        ) : null}
      </div>

      <div className="border-t border-sidebar-border p-3">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center justify-center rounded-lg py-2 text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          type="button"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  );
}
