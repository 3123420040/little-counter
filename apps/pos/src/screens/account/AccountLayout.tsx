import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, PageHeader } from "@medusa-snus/ui";
import { KeyRound, Send, UserRound } from "lucide-react";

const tabs = [
  { path: "/account", label: "Hồ sơ", icon: UserRound },
  { path: "/account/password", label: "Mật khẩu", icon: KeyRound },
  { path: "/account/telegram", label: "Telegram", icon: Send },
] as const;

export default function AccountLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <PageHeader title="Tài khoản của tôi" />
      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = location.pathname === tab.path;
          return (
            <Button
              key={tab.path}
              variant={active ? "primary" : "secondary"}
              size="sm"
              onClick={() => navigate(tab.path)}
            >
              <Icon size={15} />
              {tab.label}
            </Button>
          );
        })}
      </div>
      {children}
    </div>
  );
}
