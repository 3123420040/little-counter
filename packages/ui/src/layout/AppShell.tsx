import type { ReactNode } from "react";

export type AppShellProps = {
  /** Sidebar component */
  sidebar: ReactNode;
  /** Topbar component */
  topbar?: ReactNode;
  /** Main content */
  children: ReactNode;
};

/**
 * Root layout: sidebar + topbar + main content area.
 * Grid and responsive CSS lives in app.css @layer components.
 *
 * @example
 * <AppShell
 *   sidebar={<Sidebar items={navItems} activeId="pos" onSelect={setView} />}
 *   topbar={<Topbar title="POS" actions={[...]} />}
 * >
 *   <PosScreen />
 * </AppShell>
 */
export function AppShell({ sidebar, topbar, children }: AppShellProps) {
  return (
    <div className="snus-shell">
      <aside className="snus-sidebar" aria-label="Primary navigation">
        {sidebar}
      </aside>
      <main className="snus-main">
        {topbar && <header className="snus-topbar">{topbar}</header>}
        <div className="snus-content">{children}</div>
      </main>
    </div>
  );
}
