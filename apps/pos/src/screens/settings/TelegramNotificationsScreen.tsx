import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  PaginatedListFrame,
  loadedListPaginationMeta,
  MutationBanner,
  OperationalTable,
  PageHeader,
  Panel,
  ScreenState,
  StatusPill,
  TableSkeleton,
} from "@medusa-snus/ui";
import { BellRing, CheckCircle2, MessageSquareText, PlusCircle, Send, ToggleLeft, ToggleRight } from "lucide-react";
import {
  createTelegramNotificationRecipient,
  createTelegramNotificationRule,
  fetchStores,
  fetchTelegramNotificationSettings,
  sendTelegramNotificationRecipientTest,
  updateTelegramNotificationRecipient,
  updateTelegramNotificationRule,
  type CreateTelegramNotificationRecipientInput,
  type CreateTelegramNotificationRuleInput,
  type TelegramNotificationRecipientDto,
  type TelegramNotificationRuleDto,
  type TelegramRecipientKind,
} from "../../api/settings-endpoints";
import { SelectField, TextArea, TextField } from "./FormField";
import { useSettingsOwner } from "./useSettingsOwner";

const ALL_ORDER_EVENTS = [
  "telegram_sales_request_created",
  "sale.created",
  "sale.cancelled",
  "order.shipping_adjusted",
  "order.corrected",
  "refund.created",
];
const TELEGRAM_SALES_EVENTS = ["telegram_sales_request_created"];
const POS_ORDER_EVENTS = ["sale.created", "sale.cancelled", "order.shipping_adjusted", "order.corrected", "refund.created", "shift.discrepancy_alert"];

const KIND_LABEL: Record<TelegramRecipientKind, string> = {
  owner: "Chủ shop",
  manager: "Quản lý",
  sales_staff: "Sale",
  ops: "Vận hành",
  custom: "Khác",
};

function initialRecipientForm(): CreateTelegramNotificationRecipientInput {
  return {
    displayName: "",
    telegramUserId: "",
    telegramChatId: "",
    telegramUsername: "",
    linkedOperatorId: "",
    recipientKind: "sales_staff",
    status: "active",
  };
}

type RuleForm = Omit<CreateTelegramNotificationRuleInput, "eventTypes"> & { eventTypesText: string };

function initialRuleForm(recipientId = ""): RuleForm {
  return {
    recipientId,
    name: "",
    enabled: true,
    eventScope: "orders",
    channelFilter: "telegram",
    templateProfile: "default",
    eventTypesText: TELEGRAM_SALES_EVENTS.join(", "),
  };
}

function parseEventTypes(value: string): string[] {
  return Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
}

function recipientTelegramLabel(recipient: TelegramNotificationRecipientDto): string {
  const username = recipient.telegramUsername ? `@${recipient.telegramUsername}` : "";
  return [recipient.telegramUserId, username].filter(Boolean).join(" · ");
}

function eventSummary(rule: TelegramNotificationRuleDto): string {
  if (rule.eventTypes.length === 0) return "Tất cả sự kiện";
  if (rule.eventTypes.length <= 2) return rule.eventTypes.join(", ");
  return `${rule.eventTypes.slice(0, 2).join(", ")} +${rule.eventTypes.length - 2}`;
}

function pickRecipient(recipients: TelegramNotificationRecipientDto[], kind: TelegramRecipientKind): TelegramNotificationRecipientDto | undefined {
  return recipients.find((recipient) => recipient.status === "active" && recipient.recipientKind === kind)
    || recipients.find((recipient) => recipient.status === "active");
}

export default function TelegramNotificationsScreen() {
  const queryClient = useQueryClient();
  const { merchantId, isOwner } = useSettingsOwner();
  const [recipientForm, setRecipientForm] = useState<CreateTelegramNotificationRecipientInput>(initialRecipientForm);
  const [ruleForm, setRuleForm] = useState<RuleForm>(initialRuleForm());
  const [notice, setNotice] = useState<string | null>(null);
  const [recipientPage, setRecipientPage] = useState(1);
  const [rulePage, setRulePage] = useState(1);

  const settingsQuery = useQuery({
    queryKey: ["telegram-notifications", merchantId],
    queryFn: () => fetchTelegramNotificationSettings(merchantId!),
    enabled: !!merchantId && isOwner,
  });
  const storesQuery = useQuery({
    queryKey: ["settings-stores", merchantId],
    queryFn: () => fetchStores(merchantId!),
    enabled: !!merchantId && isOwner,
  });

  const recipients = settingsQuery.data?.data.recipients || [];
  const rules = settingsQuery.data?.data.rules || [];
  const activeRecipients = useMemo(() => recipients.filter((recipient) => recipient.status === "active"), [recipients]);
  const recipientPageMeta = loadedListPaginationMeta(recipients.length, recipientPage, 20);
  const visibleRecipients = recipients.slice((recipientPageMeta.page - 1) * 20, recipientPageMeta.page * 20);
  const rulePageMeta = loadedListPaginationMeta(rules.length, rulePage, 20);
  const visibleRules = rules.slice((rulePageMeta.page - 1) * 20, rulePageMeta.page * 20);

  useEffect(() => {
    setRecipientPage(1);
    setRulePage(1);
  }, [merchantId]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["telegram-notifications", merchantId] });
  };

  const createRecipientMutation = useMutation({
    mutationFn: (input: CreateTelegramNotificationRecipientInput) => createTelegramNotificationRecipient(merchantId!, input),
    onSuccess: async () => {
      setRecipientForm(initialRecipientForm());
      setNotice("Đã thêm người nhận Telegram.");
      await invalidate();
    },
  });

  const updateRecipientMutation = useMutation({
    mutationFn: ({ recipient, status }: { recipient: TelegramNotificationRecipientDto; status: "active" | "disabled" }) =>
      updateTelegramNotificationRecipient(merchantId!, recipient.id, { status }),
    onSuccess: invalidate,
  });

  const testMutation = useMutation({
    mutationFn: (recipientId: string) => sendTelegramNotificationRecipientTest(merchantId!, recipientId),
    onSuccess: async () => {
      setNotice("Đã đưa tin nhắn test vào hàng đợi Telegram.");
      await invalidate();
    },
  });

  const createRuleMutation = useMutation({
    mutationFn: (input: CreateTelegramNotificationRuleInput) => createTelegramNotificationRule(merchantId!, input),
    onSuccess: async () => {
      setRuleForm(initialRuleForm(ruleForm.recipientId));
      setNotice("Đã tạo rule Telegram notification.");
      await invalidate();
    },
  });

  const updateRuleMutation = useMutation({
    mutationFn: ({ rule, enabled }: { rule: TelegramNotificationRuleDto; enabled: boolean }) =>
      updateTelegramNotificationRule(merchantId!, rule.id, { enabled }),
    onSuccess: invalidate,
  });

  function submitRecipient() {
    setNotice(null);
    createRecipientMutation.mutate({
      ...recipientForm,
      storeId: recipientForm.storeId || null,
      telegramUserId: recipientForm.telegramUserId.trim(),
      telegramChatId: recipientForm.telegramChatId?.trim() || recipientForm.telegramUserId.trim(),
      telegramUsername: recipientForm.telegramUsername?.replace(/^@/, "").trim() || null,
      linkedOperatorId: recipientForm.linkedOperatorId?.trim() || null,
      displayName: recipientForm.displayName.trim(),
    });
  }

  function submitRule(input: RuleForm = ruleForm) {
    setNotice(null);
    createRuleMutation.mutate({
      ...input,
      storeId: input.storeId || null,
      recipientId: input.recipientId,
      name: input.name.trim(),
      eventTypes: parseEventTypes(input.eventTypesText),
      templateProfile: input.templateProfile || "default",
    });
  }

  function createPreset(name: string, kind: TelegramRecipientKind, channelFilter: string, eventTypes: string[]) {
    const recipient = pickRecipient(recipients, kind);
    if (!recipient) {
      setNotice("Cần thêm ít nhất một recipient active trước khi tạo preset rule.");
      return;
    }
    submitRule({
      recipientId: recipient.id,
      name,
      enabled: true,
      eventScope: "orders",
      channelFilter,
      templateProfile: "default",
      eventTypesText: eventTypes.join(", "),
    });
  }

  if (!isOwner) {
    return (
      <div className="p-4">
        <PageHeader title="Telegram notifications" />
        <ScreenState state="error" title="Không có quyền" />
      </div>
    );
  }

  const createRecipientDisabled = !recipientForm.displayName.trim() || !recipientForm.telegramUserId.trim() || createRecipientMutation.isPending;
  const createRuleDisabled = !ruleForm.name.trim() || !ruleForm.recipientId || createRuleMutation.isPending;
  const error = createRecipientMutation.error || createRuleMutation.error || updateRecipientMutation.error || updateRuleMutation.error || testMutation.error;

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Telegram notifications"
        subtitle="Cấu hình người nhận và rule để đơn Telegram/POS được đẩy về đúng nhân viên xử lý."
        status={<StatusPill tone={activeRecipients.length ? "success" : "warning"} label={`${activeRecipients.length} recipient active`} />}
      />

      {notice ? <MutationBanner tone="success" message={notice} /> : null}
      {error ? (
        <MutationBanner tone="error" message={error instanceof Error ? error.message : "Không thể cập nhật Telegram notifications."} />
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <Panel title="Người nhận Telegram">
          {settingsQuery.isLoading ? (
            <TableSkeleton rows={4} cols={6} />
          ) : settingsQuery.error ? (
            <div className="p-4">
              <ScreenState state="error" title="Không thể tải Telegram notifications" actionLabel="Thử lại" onAction={() => settingsQuery.refetch()} />
            </div>
          ) : recipients.length === 0 ? (
            <div className="p-4">
              <ScreenState state="empty" title="Chưa có recipient" body="Thêm Telegram user id hoặc chat id để shop nhận đơn và cảnh báo." />
            </div>
          ) : (
            <>
            <PaginatedListFrame
              label="Phân trang người nhận Telegram"
              rowNoun="người nhận"
              meta={recipientPageMeta}
              onPageChange={setRecipientPage}
            >
              <OperationalTable
                ariaLabel="Người nhận Telegram"
                minWidth={880}
                columns={[
                  { key: "name", label: "Người nhận" },
                  { key: "telegram", label: "Telegram" },
                  { key: "kind", label: "Vai trò" },
                  { key: "scope", label: "Phạm vi" },
                  { key: "status", label: "Trạng thái" },
                  { key: "actions", label: "Thao tác", align: "right" },
                ]}
                rows={visibleRecipients.map((recipient) => ({
                  name: (
                    <div className="min-w-0">
                      <div className="font-medium text-text-primary break-words">{recipient.displayName}</div>
                      <div className="text-xs text-text-muted">
                        {recipient.linkedOperatorId || "Không gắn POS user"}
                      </div>
                    </div>
                  ),
                  telegram: (
                    <span className="font-mono text-xs break-all">{recipientTelegramLabel(recipient)}</span>
                  ),
                  kind: <StatusPill tone="info" label={KIND_LABEL[recipient.recipientKind]} />,
                  scope: (
                    <span className="break-words">
                      {recipient.storeName || recipient.storeId || "Toàn merchant"}
                    </span>
                  ),
                  status: (
                    <StatusPill
                      tone={recipient.status === "active" ? "success" : "danger"}
                      label={recipient.status === "active" ? "Active" : "Disabled"}
                    />
                  ),
                  actions: (
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => testMutation.mutate(recipient.id)}
                        disabled={recipient.status !== "active" || testMutation.isPending}
                      >
                        <Send size={14} />
                        Test
                      </Button>
                      <Button
                        variant={recipient.status === "active" ? "danger" : "secondary"}
                        size="sm"
                        onClick={() =>
                          updateRecipientMutation.mutate({
                            recipient,
                            status: recipient.status === "active" ? "disabled" : "active",
                          })
                        }
                        disabled={updateRecipientMutation.isPending}
                      >
                        {recipient.status === "active" ? <ToggleLeft size={14} /> : <ToggleRight size={14} />}
                        {recipient.status === "active" ? "Tắt" : "Bật"}
                      </Button>
                    </div>
                  ),
                }))}
              />
            </PaginatedListFrame>
            </>
          )}
        </Panel>

        <Panel title="Thêm recipient">
          <div className="space-y-3 p-4">
            <div className="settings-form-grid">
              <TextField label="Tên hiển thị" value={recipientForm.displayName} onChange={(event) => setRecipientForm((current) => ({ ...current, displayName: event.target.value }))} required />
              <SelectField label="Vai trò nhận tin" value={recipientForm.recipientKind} onChange={(event) => setRecipientForm((current) => ({ ...current, recipientKind: event.target.value as TelegramRecipientKind }))}>
                <option value="owner">Chủ shop</option>
                <option value="manager">Quản lý</option>
                <option value="sales_staff">Sale</option>
                <option value="ops">Vận hành</option>
                <option value="custom">Khác</option>
              </SelectField>
              <TextField label="Telegram user id" value={recipientForm.telegramUserId} onChange={(event) => setRecipientForm((current) => ({ ...current, telegramUserId: event.target.value }))} required />
              <TextField label="Telegram chat id" value={recipientForm.telegramChatId || ""} onChange={(event) => setRecipientForm((current) => ({ ...current, telegramChatId: event.target.value }))} hint="Để trống sẽ dùng user id." />
              <TextField label="Username" value={recipientForm.telegramUsername || ""} onChange={(event) => setRecipientForm((current) => ({ ...current, telegramUsername: event.target.value }))} placeholder="@username" />
              <TextField label="POS operator id" value={recipientForm.linkedOperatorId || ""} onChange={(event) => setRecipientForm((current) => ({ ...current, linkedOperatorId: event.target.value }))} />
              <SelectField label="Cửa hàng" value={recipientForm.storeId || ""} onChange={(event) => setRecipientForm((current) => ({ ...current, storeId: event.target.value || null }))}>
                <option value="">Toàn merchant</option>
                {(storesQuery.data?.data || []).map((store) => (
                  <option key={store.storeId} value={store.storeId}>{store.publicName || store.internalName}</option>
                ))}
              </SelectField>
            </div>
            <Button variant="primary" onClick={submitRecipient} disabled={createRecipientDisabled}>
              <PlusCircle size={16} />
              Thêm recipient
            </Button>
          </div>
        </Panel>
      </div>

      <Panel title="Preset rule">
        <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-3">
          <button
            type="button"
            className="rounded-lg border border-border-default bg-surface-panel p-3 text-left transition hover:bg-surface-subtle"
            onClick={() => createPreset("Owner nhận toàn bộ đơn", "owner", "all", ALL_ORDER_EVENTS)}
          >
            <BellRing size={18} className="mb-2 text-action-primary" />
            <div className="font-semibold text-text-primary">Owner · toàn bộ đơn</div>
            <div className="mt-1 text-sm text-text-muted">Nhận đơn Telegram, POS sale, hủy, refund và chỉnh phí ship.</div>
          </button>
          <button
            type="button"
            className="rounded-lg border border-border-default bg-surface-panel p-3 text-left transition hover:bg-surface-subtle"
            onClick={() => createPreset("Sale nhận đơn Telegram", "sales_staff", "telegram", TELEGRAM_SALES_EVENTS)}
          >
            <MessageSquareText size={18} className="mb-2 text-action-primary" />
            <div className="font-semibold text-text-primary">Sale · đơn Telegram</div>
            <div className="mt-1 text-sm text-text-muted">Đẩy yêu cầu mua từ bot về nhân viên sale xử lý trong portal.</div>
          </button>
          <button
            type="button"
            className="rounded-lg border border-border-default bg-surface-panel p-3 text-left transition hover:bg-surface-subtle"
            onClick={() => createPreset("Vận hành nhận đơn POS", "ops", "pos", POS_ORDER_EVENTS)}
          >
            <CheckCircle2 size={18} className="mb-2 text-action-primary" />
            <div className="font-semibold text-text-primary">Vận hành · POS</div>
            <div className="mt-1 text-sm text-text-muted">Theo dõi sale/refund/correction phát sinh từ kênh POS.</div>
          </button>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <Panel title="Notification rules">
          {settingsQuery.isLoading ? (
            <TableSkeleton rows={4} cols={6} />
          ) : rules.length === 0 ? (
            <div className="p-4">
              <ScreenState state="empty" title="Chưa có rule" body="Tạo preset rule hoặc tạo rule thủ công để bắt đầu routing notification." />
            </div>
          ) : (
            <>
            <PaginatedListFrame
              label="Phân trang rule Telegram"
              rowNoun="rule"
              meta={rulePageMeta}
              onPageChange={setRulePage}
            >
              <OperationalTable
                ariaLabel="Telegram notification rules"
                minWidth={920}
                columns={[
                  { key: "name", label: "Rule" },
                  { key: "recipient", label: "Người nhận" },
                  { key: "channel", label: "Kênh" },
                  { key: "events", label: "Sự kiện" },
                  { key: "status", label: "Trạng thái" },
                  { key: "actions", label: "Thao tác", align: "right" },
                ]}
                rows={visibleRules.map((rule) => ({
                  name: (
                    <div className="min-w-0">
                      <div className="font-medium text-text-primary break-words">{rule.name}</div>
                      <div className="text-xs text-text-muted">
                        {rule.eventScope} · {rule.templateProfile}
                      </div>
                    </div>
                  ),
                  recipient: <span className="break-words">{rule.recipientDisplayName}</span>,
                  channel: <StatusPill tone="info" label={rule.channelFilter} />,
                  events: (
                    <span className="text-sm text-text-secondary break-words">{eventSummary(rule)}</span>
                  ),
                  status: (
                    <StatusPill
                      tone={rule.enabled ? "success" : "danger"}
                      label={rule.enabled ? "Enabled" : "Disabled"}
                    />
                  ),
                  actions: (
                    <Button
                      variant={rule.enabled ? "danger" : "secondary"}
                      size="sm"
                      onClick={() => updateRuleMutation.mutate({ rule, enabled: !rule.enabled })}
                      disabled={updateRuleMutation.isPending}
                    >
                      {rule.enabled ? <ToggleLeft size={14} /> : <ToggleRight size={14} />}
                      {rule.enabled ? "Tắt" : "Bật"}
                    </Button>
                  ),
                }))}
              />
            </PaginatedListFrame>
            </>
          )}
        </Panel>

        <Panel title="Tạo rule thủ công">
          <div className="space-y-3 p-4">
            <div className="settings-form-grid">
              <TextField label="Tên rule" value={ruleForm.name} onChange={(event) => setRuleForm((current) => ({ ...current, name: event.target.value }))} required />
              <SelectField label="Recipient" value={ruleForm.recipientId} onChange={(event) => setRuleForm((current) => ({ ...current, recipientId: event.target.value }))} required>
                <option value="">Chọn recipient</option>
                {activeRecipients.map((recipient) => (
                  <option key={recipient.id} value={recipient.id}>{recipient.displayName}</option>
                ))}
              </SelectField>
              <SelectField label="Kênh" value={ruleForm.channelFilter} onChange={(event) => setRuleForm((current) => ({ ...current, channelFilter: event.target.value }))}>
                <option value="telegram">Telegram</option>
                <option value="pos">POS</option>
                <option value="remote">Remote</option>
                <option value="web_pos">Web POS</option>
                <option value="all">Tất cả</option>
              </SelectField>
              <TextField label="Event scope" value={ruleForm.eventScope} onChange={(event) => setRuleForm((current) => ({ ...current, eventScope: event.target.value }))} required />
              <TextArea label="Event types" value={ruleForm.eventTypesText} onChange={(event) => setRuleForm((current) => ({ ...current, eventTypesText: event.target.value }))} hint="Ngăn cách bằng dấu phẩy. Để trống nghĩa là nhận toàn bộ." />
            </div>
            <Button variant="primary" onClick={() => submitRule()} disabled={createRuleDisabled}>
              <PlusCircle size={16} />
              Tạo rule
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
