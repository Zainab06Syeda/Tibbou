import { Link, useLocation } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import TibbouLockup from "@/components/auth/TibbouLockup";
import TibbouMark from "@/components/auth/TibbouMark";
import { navItemsFor, workspaceInitials } from "@/components/navigation";
import { useOrganization } from "@/contexts/OrganizationContext";
import { ROLE_INFO } from "@/lib/members";
import { cn } from "@/lib/utils";

const COLLAPSED_KEY = "tibbou.sidebarCollapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export default function Sidebar({ mobileOpen = false, onNavigate }) {
  const location = useLocation();
  const { organization } = useOrganization();
  const [storedCollapsed, setStoredCollapsed] = useState(readCollapsed);
  // The phone drawer is always full width, whatever the desktop setting.
  const collapsed = storedCollapsed && !mobileOpen;
  const items = navItemsFor(organization?.role);
  const sections = [...new Set(items.map((item) => item.section))];

  function toggle() {
    const next = !storedCollapsed;
    setStoredCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // Not remembered across reloads; nothing else depends on it.
    }
  }

  return (
    <aside
      className={cn(
        // Below md it is a slide-out drawer (opened from the top bar's menu
        // button) so it doesn't squeeze the page; from md up it sits inline.
        "fixed inset-y-0 left-0 z-40 flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300 md:sticky md:top-0 md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
        collapsed ? "w-[240px] md:w-[68px]" : "w-[240px]"
      )}
    >
      <div className={cn("flex h-16 shrink-0 items-center border-b border-sidebar-border", collapsed ? "justify-center px-2" : "px-4")}>
        {collapsed ? (
          <TibbouMark size={6} theme="dark" className="flex-shrink-0" forceDot />
        ) : (
          <div className="min-w-0">
            <TibbouLockup size={9} theme="dark" className="text-foreground" />
            <p className="mt-0.5 truncate text-[11px] text-sidebar-foreground">Data lineage and cost visibility</p>
          </div>
        )}
      </div>

      {organization ? (
        <div className={cn("shrink-0 border-b border-sidebar-border py-3", collapsed ? "px-2" : "px-3")}>
          <div
            className={cn("flex items-center gap-3 rounded-lg", collapsed ? "justify-center" : "bg-sidebar-accent px-2.5 py-2")}
            title={collapsed ? `${organization.name} · ${ROLE_INFO[organization.role]?.label || organization.role}` : undefined}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/15 text-xs font-semibold text-primary">
              {workspaceInitials(organization.name)}
            </span>
            {!collapsed ? (
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{organization.name}</p>
                <p className="text-[11px] text-sidebar-foreground">{ROLE_INFO[organization.role]?.label || organization.role}</p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <nav className={cn("flex-1 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")} aria-label="Main">
        {sections.map((section, index) => (
          <div key={section} className={cn(index > 0 && "mt-5")}>
            {collapsed ? (
              index > 0 ? <div className="mx-2 mb-3 border-t border-sidebar-border" aria-hidden="true" /> : null
            ) : (
              <p className="mb-2 px-3 text-[10px] font-medium uppercase tracking-[0.18em] text-sidebar-foreground/70">{section}</p>
            )}
            <div className="space-y-1">
              {items
                .filter((item) => item.section === section)
                .map((item) => {
                  const isActive = location.pathname === item.path;
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      onClick={onNavigate}
                      title={collapsed ? item.label : undefined}
                      aria-label={collapsed ? item.label : undefined}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium transition-colors duration-200",
                        collapsed ? "justify-center px-0" : "px-3",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
                      )}
                    >
                      {isActive ? (
                        <span className={cn("absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary", collapsed ? "-left-2" : "-left-3")} aria-hidden="true" />
                      ) : null}
                      <item.icon className="h-5 w-5 flex-shrink-0" />
                      {!collapsed ? <span className="whitespace-nowrap">{item.label}</span> : null}
                    </Link>
                  );
                })}
            </div>
          </div>
        ))}
      </nav>

      <div className="hidden shrink-0 border-t border-sidebar-border p-3 md:block">
        <button
          onClick={toggle}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg py-2 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
            collapsed ? "justify-center" : "px-3"
          )}
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : undefined}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!collapsed ? <span>Collapse</span> : null}
        </button>
      </div>
    </aside>
  );
}
