import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button, Drawer, InlineError, PaginatedListFrame, loadedListPaginationMeta, MutationBanner, OperationalTable,
  PageHeader, Panel, SearchBox, TableSkeleton,
} from "@medusa-snus/ui";
import { useCustomers, useCreateCustomer } from "../hooks/useCustomers";
import { Users } from "lucide-react";
import { useI18n } from "../i18n";

export default function CustomersScreen() {
  const PAGE_SIZE = 20;
  const navigate = useNavigate();
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const customerQuery = search.length === 0 ? undefined : search;
  const waitingForMoreSearch = search.length > 0 && search.length < 3;
  const { data: customers, isLoading, error, refetch } = useCustomers(customerQuery);
  const [showCreate, setShowCreate] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [newName, setNewName] = useState("");
  const [mutationNotice, setMutationNotice] = useState<{ tone: "success" | "error" | "pending"; message: string } | null>(null);
  const createMutation = useCreateCustomer();
  const customerRows = customers || [];
  const pageMeta = loadedListPaginationMeta(customerRows.length, page, PAGE_SIZE);
  const visibleCustomers = customerRows.slice(
    (pageMeta.page - 1) * PAGE_SIZE,
    pageMeta.page * PAGE_SIZE,
  );

  useEffect(() => {
    setPage(1);
  }, [search]);

  async function handleCreate() {
    if (!newPhone.trim() || !newName.trim()) return;
    setMutationNotice({ tone: "pending", message: "Đang tạo khách hàng..." });
    try {
      await createMutation.mutateAsync({ phone: newPhone.trim(), firstName: newName.trim(), lastName: "" });
      setMutationNotice({ tone: "success", message: "Đã tạo khách hàng." });
      setShowCreate(false);
      setNewPhone("");
      setNewName("");
    } catch (err) {
      setMutationNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Không thể tạo khách hàng.",
      });
    }
  }

  if (error) {
    return (
      <div className="p-4">
        <InlineError message="Không thể tải danh sách khách hàng" onRetry={() => refetch()} stale />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title={t("customers.title")}
        actions={
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            {t("customers.create")}
          </Button>
        }
      />

      {/* Search */}
      <SearchBox
        value={search}
        onChange={setSearch}
        placeholder={t("customers.searchPlaceholder")}
      />

      {mutationNotice && (
        <MutationBanner
          tone={mutationNotice.tone}
          message={mutationNotice.message}
          actionLabel={mutationNotice.tone === "error" ? t("state.close") : undefined}
          onAction={() => setMutationNotice(null)}
        />
      )}

      <Panel title={t("customers.title")}>
        {waitingForMoreSearch ? (
          <div className="p-6 text-center">
            <Users size={32} className="text-text-muted mb-3 mx-auto" />
            <p className="text-sm text-text-muted">Nhập ít nhất 3 ký tự để tìm khách hàng.</p>
          </div>
        ) : isLoading ? (
          <TableSkeleton rows={6} cols={3} />
        ) : customerRows.length === 0 ? (
          <div className="p-6 text-center">
            <Users size={32} className="text-text-muted mb-3 mx-auto" />
            <p className="text-sm text-text-muted">
              {search ? `Không tìm thấy "${search}"` : t("customers.empty")}
            </p>
            {!search && (
              <Button variant="primary" className="mt-3" onClick={() => setShowCreate(true)}>
                {t("customers.createFirst")}
              </Button>
            )}
          </div>
        ) : (
          <>
            <PaginatedListFrame
              label="Phân trang khách hàng"
              rowNoun="khách hàng"
              meta={pageMeta}
              onPageChange={setPage}
            >
              <OperationalTable
                columns={[
                  { key: "name", label: "Khách hàng" },
                  { key: "phone", label: "ĐT" },
                  { key: "tier", label: t("customers.tier") },
                ]}
                rows={visibleCustomers.map((c) => ({
                  name: (
                    <span className="font-medium text-text-primary">
                      {`${c.last_name} ${c.first_name}`.trim() || "-"}
                    </span>
                  ),
                  phone: <span className="font-mono text-xs">{c.phone || "-"}</span>,
                  tier: <span className="text-xs text-text-muted">Chưa có hạng</span>,
                }))}
                onRowClick={(_, idx) => {
                  const customer = idx === undefined ? undefined : visibleCustomers[idx];
                  if (customer) navigate(`/customers/${customer.id}`);
                }}
              />
            </PaginatedListFrame>
          </>
        )}
      </Panel>

      {/* ── Create Drawer ── */}
      <Drawer
        open={showCreate}
        title={t("customers.create")}
        onClose={() => setShowCreate(false)}
        actions={
          <>
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={!newPhone.trim() || !newName.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? t("state.loading") : t("state.confirm")}
            </Button>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>{t("state.cancel")}</Button>
          </>
        }
      >
            <div className="space-y-4">
              <input
                type="text"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="Số điện thoại"
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                           focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                autoFocus
              />
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Tên khách hàng"
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                           focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
              />

            </div>
      </Drawer>
    </div>
  );
}
