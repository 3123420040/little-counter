import { useEffect, useRef, type ReactNode, type ElementType } from "react";

export type NavItem = {
  id: string;
  label: string;
  icon: ElementType;
  badge?: string | number;
};

export type NavGroup = {
  /** Uppercase section label (e.g., "QUẦY", "KHO") */
  label: string;
  items: NavItem[];
};

export type SidebarProps = {
  /** Brand/logo at top of sidebar */
  brand: {
    label: string;
    icon: ElementType;
  };
  /** Navigation groups (v3: replaces flat items) */
  groups: NavGroup[];
  /** Currently active nav item id */
  activeId?: string;
  /** Called when a nav item is clicked */
  onSelect: (id: string) => void;
  /** Optional: extra content at bottom of sidebar (user menu, logout) */
  footer?: ReactNode;
};

/**
 * Sidebar navigation with brand block, grouped nav items, and optional footer.
 * CSS lives in app.css @layer components.
 *
 * @example
 * <Sidebar
 *   brand={{ label: "Snus Ops", icon: Store }}
 *   groups={[
 *     { label: "Quầy", items: [{ id: "pos", label: "Bán hàng", icon: ShoppingCart }] },
 *     { label: "Kho", items: [
 *       { id: "inventory", label: "Tồn kho", icon: Package },
 *       { id: "purchase-orders", label: "Đặt hàng", icon: Truck },
 *     ]},
 *   ]}
 *   activeId="pos"
 *   onSelect={setView}
 * />
 */
export function Sidebar({ brand: Brand, groups, activeId, onSelect, footer }: SidebarProps) {
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <>
      <div className="snus-brand">
        <Brand.icon size={18} aria-hidden="true" />
        <span className="text-sm font-bold">{Brand.label}</span>
      </div>
      <nav className="snus-nav">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="snus-nav-section-label">{group.label}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = item.id === activeId;
              return (
                <button
                  key={item.id}
                  ref={isActive ? activeItemRef : undefined}
                  className={`snus-nav-item${isActive ? " snus-nav-item--active" : ""}`}
                  aria-label={item.label}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => onSelect(item.id)}
                  type="button"
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.badge !== undefined && (
                    <span className="snus-nav-badge">{item.badge}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      {footer && <div className="snus-sidebar-footer">{footer}</div>}
    </>
  );
}
