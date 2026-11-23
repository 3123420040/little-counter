import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Building2, Store, Package, Puzzle, AlertCircle, UserCheck, FileSearch, UsersRound } from "lucide-react";

const PLATFORM_TABS = [
  { id: "merchants", label: "Merchants", path: "/platform/merchants", icon: Building2 },
  { id: "operators", label: "Operators", path: "/platform/operators", icon: UsersRound },
  { id: "stores", label: "Cửa hàng", path: "/platform/stores", icon: Store },
  { id: "packages-billing", label: "Gói & Billing", path: "/platform/packages-billing", icon: Package },
  { id: "integrations", label: "Tích hợp", path: "/platform/integrations", icon: Puzzle },
  { id: "payment-exceptions", label: "Ngoại lệ thanh toán", path: "/platform/payment-exceptions", icon: AlertCircle },
  { id: "signup-identity", label: "Đăng ký", path: "/platform/signup-identity", icon: UserCheck },
  { id: "audit", label: "Lịch sử", path: "/platform/audit", icon: FileSearch },
];

export function PlatformLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <div className="settings-layout">
      <nav className="settings-tabs" aria-label="Platform Admin">
        {PLATFORM_TABS.map((tab) => {
          const isActive = location.pathname.startsWith(tab.path);
          const Icon = tab.icon;
          return (
            <NavLink key={tab.id} to={tab.path} className={["settings-tab-item", isActive ? "settings-tab-item--active" : ""].filter(Boolean).join(" ")} aria-current={isActive ? "page" : undefined}>
              <Icon size={15} aria-hidden="true" />
              <span>{tab.label}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="settings-content">{children}</div>
    </div>
  );
}
