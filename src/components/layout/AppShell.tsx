"use client";
import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import Sidebar from "./Sidebar";
import DegradedBanner from "./DegradedBanner";
import GlobalComposer from "@/components/chat/GlobalComposer";
import ChatEngine from "@/components/chat/ChatEngine";
import { PlaidConnectProvider } from "@/components/portfolio/PlaidConnectProvider";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [prevPath, setPrevPath] = useState(pathname);

  // Close the drawer whenever the route changes (render-phase reset, no effect).
  if (pathname !== prevPath) {
    setPrevPath(pathname);
    setMobileOpen(false);
  }

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  const isLogin = pathname === "/login";
  const isLanding = pathname === "/";
  const isSettings = pathname === "/settings";
  // Legal pages are public marketing-style pages — no app chrome.
  const isLegal = pathname === "/privacy" || pathname === "/terms";

  // Marketing landing is always full-bleed, even mid auth-resolution, so the
  // sidebar never flashes for an authed user before the /chat redirect lands.
  if (isLanding || isLegal) {
    return <main className="h-full w-full overflow-y-auto">{children}</main>;
  }

  // Auth still resolving — render nothing to avoid flashing protected content.
  if (loading) {
    return <div className="h-full w-full" />;
  }

  // Login route or unauthenticated (mid-redirect): no app chrome at all.
  if (isLogin || !user) {
    return <main className="h-full w-full overflow-y-auto">{children}</main>;
  }

  return (
    <PlaidConnectProvider>
    <div className="h-full flex flex-col md:flex-row overflow-hidden">
      {/* Mobile top bar */}
      <header
        className="md:hidden flex items-center gap-3 h-12 px-3 flex-shrink-0"
        style={{ background: "var(--color-sidebar)", borderBottom: "1px solid var(--color-border)" }}
      >
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="w-9 h-9 flex items-center justify-center rounded-[8px] text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)] transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span
          className="text-[18px] font-black uppercase leading-none select-none text-[var(--color-text)]"
          style={{ fontFamily: "var(--font-serif)", letterSpacing: "0.16em" }}
        >
          FINAVA
        </span>
      </header>

      {/* Desktop sidebar rail — hidden on settings, which has its own nav rail */}
      {!isSettings && (
        <div className="hidden md:flex h-full flex-shrink-0">
          <Sidebar />
        </div>
      )}

      {/* Mobile off-canvas drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-[var(--color-scrim)] fade-in"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <div
            className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw]"
            style={{ boxShadow: "var(--shadow-pop)" }}
          >
            <Sidebar mobile onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      {/* Content column — relative so the persistent composer can float over it,
          aligned to the content area (right of the resizable sidebar) via layout. */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        <DegradedBanner />
        {/* Main content — keyed by route so it re-mounts and re-runs the subtle
            route-fade on each navigation (disabled under prefers-reduced-motion). */}
        <main key={pathname} className="flex-1 flex flex-col min-h-0 overflow-hidden route-fade">{children}</main>
        {/* Persistent floating composer — outside the keyed <main>, never unmounts. */}
        {!isSettings && <GlobalComposer />}
        {/* Headless streaming engine — drives all chat streams, survives navigation
            so multiple conversations can generate concurrently. */}
        <ChatEngine />
      </div>
    </div>
    </PlaidConnectProvider>
  );
}
