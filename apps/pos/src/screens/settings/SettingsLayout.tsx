import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Store, Package, Users, Settings, Puzzle, FileSearch, Building2, BellRing } from "lucide-react";

export interface SettingsTab {
  id: string;
  label: string;
  path: string;
  icon: React.ElementType;
  ownerOnly?: boolean;
  teamAllowed?: boolean;
}

export const SETTINGS_TABS: SettingsTab[] = [
  { id: "overview", label: "Tổng quan", path: "/settings", icon: Settings },
  { id: "merchant", label: "Thương hiệu", path: "/settings/merchant", icon: Building2, ownerOnly: true },
  { id: "stores", label: "Cửa hàng", path: "/settings/stores", icon: Store, ownerOnly: true },
  { id: "team", label: "Nhóm nhân viên", path: "/settings/team", icon: Users, teamAllowed: true },
  { id: "package", label: "Gói dịch vụ", path: "/settings/package", icon: Package, ownerOnly: true },
  { id: "integrations", label: "Tích hợp", path: "/settings/integrations", icon: Puzzle, ownerOnly: true },
  { id: "telegram-notifications", label: "Telegram", path: "/settings/telegram-notifications", icon: BellRing, ownerOnly: true },
  { id: "audit", label: "Lịch sử", path: "/settings/audit", icon: FileSearch },
];

interface SettingsLayoutProps {
  children: ReactNode;
  isOwner: boolean;
  canManageTeam?: boolean;
}

export function SettingsLayout({ children, isOwner, canManageTeam }: SettingsLayoutProps) {
  const location = useLocation();
  const visibleTabs = SETTINGS_TABS.filter((tab) => {
    if (tab.ownerOnly && !isOwner) return false;
    if (tab.teamAllowed && !canManageTeam) return false;
    return true;
  });

  return (
    <div className="settings-layout">
      <nav className="settings-tabs" aria-label="Mục cài đặt">
        {visibleTabs.map((tab) => {
          const isActive = tab.path === "/settings"
            ? location.pathname === "/settings"
            : location.pathname.startsWith(tab.path);
          const Icon = tab.icon;
          return (
            <NavLink
              key={tab.id}
              to={tab.path}
              end={tab.path === "/settings"}
              className={["settings-tab-item", isActive ? "settings-tab-item--active" : ""].filter(Boolean).join(" ")}
              aria-current={isActive ? "page" : undefined}
            >
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
