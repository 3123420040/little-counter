/* ═══════════════════════════════════════════════════════
   @medusa-snus/ui — Design System & Component Library
   Retail operations register · Tailwind CSS v3
   ═══════════════════════════════════════════════════════ */

// ── CSS Tokens ──
// Import once in app root: import "@medusa-snus/ui/tokens.css"
// Component styles are Tailwind utilities in JSX — no JS-string CSS exports.

// ── Components ──
export { StatusPill } from "./components/StatusPill";
export type { StatusPillProps, StatusTone } from "./components/StatusPill";

export { Panel } from "./components/Panel";
export type { PanelProps } from "./components/Panel";

export { MetricCell } from "./components/MetricCell";
export type { MetricCellProps } from "./components/MetricCell";

export { EmptyState } from "./components/EmptyState";
export type { EmptyStateProps } from "./components/EmptyState";

export { OperationalTable } from "./components/OperationalTable";
export type { OperationalTableProps } from "./components/OperationalTable";
export { ListPagination, loadedListPaginationMeta, localListPaginationMeta, paginateListItems } from "./components/ListPagination";
export type { ListPaginationMeta, ListPaginationProps, ExactListPaginationMeta } from "./components/ListPagination";
export { PaginatedListFrame } from "./components/PaginatedListFrame";
export type { PaginatedListFrameProps } from "./components/PaginatedListFrame";

export { Button } from "./components/Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./components/Button";

export { SearchBox } from "./components/SearchBox";
export type { SearchBoxProps } from "./components/SearchBox";

export { Badge } from "./components/Badge";
export type { BadgeProps } from "./components/Badge";

export { TableSkeleton } from "./components/TableSkeleton";
export { PageHeader } from "./components/PageHeader";
export { InlineError } from "./components/InlineError";
export type { InlineErrorProps } from "./components/InlineError";
export { ConfirmDialog } from "./components/ConfirmDialog";
export type { ConfirmDialogProps } from "./components/ConfirmDialog";
export { Drawer } from "./components/Drawer";
export type { DrawerProps } from "./components/Drawer";
export { FilterBar } from "./components/FilterBar";
export type { FilterBarProps } from "./components/FilterBar";
export { MutationBanner } from "./components/MutationBanner";
export type { MutationBannerProps, MutationBannerTone } from "./components/MutationBanner";
export { ResponsiveMetricGrid } from "./components/ResponsiveMetricGrid";
export { ScreenState } from "./components/ScreenState";
export type { ScreenStateProps } from "./components/ScreenState";

// ── Layout ──
export { AppShell } from "./layout/AppShell";
export type { AppShellProps } from "./layout/AppShell";

export { Sidebar } from "./layout/Sidebar";
export type { SidebarProps, NavItem, NavGroup } from "./layout/Sidebar";

export { Topbar } from "./layout/Topbar";
export type { TopbarProps } from "./layout/Topbar";
