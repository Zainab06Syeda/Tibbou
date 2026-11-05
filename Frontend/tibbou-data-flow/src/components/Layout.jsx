import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { useOrganization } from "@/contexts/OrganizationContext";

import PendingInvitations from "./PendingInvitations";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";

export default function Layout() {
  const { organization } = useOrganization();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="app-shell flex min-h-screen bg-background text-foreground">
      <Sidebar mobileOpen={menuOpen} onNavigate={() => setMenuOpen(false)} />
      {menuOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col overflow-auto">
        <TopBar onMenu={() => setMenuOpen(true)} />
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col p-4 sm:p-6 lg:p-8">
          <PendingInvitations />
          {/* Keyed by workspace: switching remounts the page so it reloads
              that workspace's data instead of showing the previous one's.
              The wrapper is keyed by page too, so each page fades in. */}
          <div key={pathname} className="motion-page flex flex-1 flex-col">
            <Outlet key={organization?.id} />
          </div>
        </div>
      </main>
    </div>
  );
}
