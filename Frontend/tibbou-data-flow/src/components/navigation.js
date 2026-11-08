import { Database, DollarSign, GitBranch, LayoutDashboard, Plug, Users } from "lucide-react";

import { hasPermission } from "@/lib/permissions";

// Every page in the app, shared by the sidebar, the top bar's page title
// and the search palette so they never disagree.
export const NAV_ITEMS = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard, section: "Explore", keywords: "home overview" },
  { path: "/datasets", label: "Datasets", icon: Database, section: "Explore", keywords: "tables models" },
  { path: "/lineage", label: "Lineage", icon: GitBranch, section: "Explore", keywords: "graph dependencies dbt manifest upload" },
  { path: "/costs", label: "Costs", icon: DollarSign, section: "Explore", keywords: "spend credits snowflake" },
  { path: "/settings/members", label: "Members", icon: Users, section: "Settings", keywords: "invite team roles people", capability: "manage_members" },
  { path: "/settings/connection", label: "Connection", icon: Plug, section: "Settings", keywords: "snowflake sync key", capability: "manage_connection" },
];

export function navItemsFor(role) {
  return NAV_ITEMS.filter((item) => !item.capability || hasPermission(role, item.capability));
}

export function pageTitle(pathname) {
  return NAV_ITEMS.find((item) => item.path === pathname)?.label || "";
}

export function workspaceInitials(name) {
  const words = (name || "?").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
}
