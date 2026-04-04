import { useLoaderData, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Badge,
  DataTable, Select, Modal,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchOrders, groupOrdersByDay, calcKPI } from "../utils/shopify.server";
import { getPrevPeriod, formatCurrency, formatDate, formatStatus, daysAgo } from "../utils/format";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const start = url.searchParams.get("start") || daysAgo(30);
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  const prev = getPrevPeriod(start, end);

  const [orders, prevOrders] = await Promise.all([
    fetchOrders(admin, { startDate: start, endDate: end }),
    fetchOrders(admin, { startDate: prev.start, endDate: prev.end }),
  ]);

  const kpi = calcKPI(orders, prevOrders);
  const byDay = groupOrdersByDay(orders);

  return json({ orders, kpi, byDay, start, end, currency: kpi.currency });
};

function DateRangePicker({ start, end }) {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const presets = [
    { label: "7 giorni", start: daysAgo(7), end: today },
    { label: "30 giorni", start: daysAgo(30), end: today },
    { label: "90 giorni", start: daysAgo(90), end: today },
    { label: "Anno", start: `${new Date().getFullYear()}-01-01`, end: today },
  ];
  return (
    <InlineStack gap="200" blockAlign="center" wrap>
      <Text as="span" variant="bodySm" tone="subdued">Periodo:</Text>
      {presets.map((p) => (
        <Button key={p.label} size="slim"
          variant={start === p.start && end === p.end ? "primary" : "plain"}
          onClick={() => navigate(`?start=${p.start}&end=${p.end}`)}>
          {p.label}
        </Button>
      ))}
      <Text as="span" variant="bodySm" tone="subdued">{formatDate(start)} — {formatDate(end)}</Text>
    </InlineStack>
  );
}

function RevenueTooltip({ active, payload, label, currency }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "8px 12px" }}>
      <p style={{ margin: 0, fontWeight: 600, fontSize: 12 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ margin: "2px 0", fontSize: 12, color: p.color }}>
          {p.name}: {p.name === "Fatturato" ? formatCurrency(p.value, currency) : p.value}
        </p>
      ))}
    </div>
  );
}

function exportCSV(rows, filename) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportExcel(rows, filename) {
  import("xlsx").then((XLSX) => {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Vendite");
    XLSX.writeFile(wb, filename);
  });
}

export default function Vendite() {
  const { orders, kpi, byDay, start, end, currency } = useLoaderData();
  const [filterStatus, setFilterStatus] = useState("");
  const [selectedOrder, setSelectedOrder] = useState(null);

  const filtered = filterStatus
    ? orders.filter((o) => o.financialStatus === filterStatus)
    : orders;

  const maxOrder = orders.length > 0
    ? Math.max(...orders.map((o) => parseFloat(o.totalPriceSet.shopMoney.amount)))
    : 0;
  const avgDaily = byDay.length > 0
    ? byDay.reduce((s, d) => s + d.revenue, 0) / byDay.length
    : 0;
  const totalDiscount = orders.reduce((s, o) => s + parseFloat(o.totalDiscountsSet?.shopMoney?.amount || 0), 0);

  const statusOptions = [
    { label: "Tutti gli stati", value: "" },
    { label: "Pagato", value: "PAID" },
    { label: "In attesa", value: "PENDING" },
    { label: "Rimborsato", value: "REFUNDED" },
    { label: "Parz. rimborsato", value: "PARTIALLY_REFUNDED" },
    { label: "Autorizzato", value: "AUTHORIZED" },
  ];

  const tableRows = filtered.map((o) => [
    formatDate(o.createdAt),
    o.name,
    o.customer ? `${o.customer.firstName || ""} ${o.customer.lastName || ""}`.trim() || o.customer.email || "—" : "—",
    <Badge key={o.id} tone={o.financialStatus === "PAID" ? "success" : o.financialStatus === "REFUNDED" ? "critical" : "attention"}>
      {formatStatus(o.financialStatus)}
    </Badge>,
    <Badge key={o.id + "f"} tone={o.fulfillmentStatus === "FULFILLED" ? "success" : "attention"}>
      {formatStatus(o.fulfillmentStatus || "UNFULFILLED")}
    </Badge>,
    formatCurrency(parseFloat(o.totalPriceSet.shopMoney.amount), currency),
    <Button key={o.id + "b"} size="slim" plain onClick={() => setSelectedOrder(o)}>Dettagli</Button>,
  ]);

  const exportRows = filtered.map((o) => ({
    Data: formatDate(o.createdAt),
    Ordine: o.name,
    Cliente: o.customer ? `${o.customer.firstName || ""} ${o.customer.lastName || ""}`.trim() || o.customer.email || "" : "",
    "Stato pagamento": formatStatus(o.financialStatus),
    "Stato consegna": formatStatus(o.fulfillmentStatus || "UNFULFILLED"),
    Totale: parseFloat(o.totalPriceSet.shopMoney.amount).toFixed(2),
    Valuta: currency,
  }));

  return (
    <Page title="Vendite">
      <TitleBar title="Vendite" />
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <DateRangePicker start={start} end={end} />
          <InlineStack gap="200">
            <Button size="slim" onClick={() => exportCSV(exportRows, `vendite_${start}_${end}.csv`)}>CSV</Button>
            <Button size="slim" onClick={() => exportExcel(exportRows, `vendite_${start}_${end}.xlsx`)}>Excel</Button>
            <Button size="slim" onClick={() => window.print()}>Stampa</Button>
          </InlineStack>
        </InlineStack>

        {/* KPI */}
        <Layout>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Fatturato totale</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(kpi.revenue, currency)}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Media giornaliera</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(avgDaily, currency)}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Ordine più alto</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(maxOrder, currency)}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Sconti totali</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(totalDiscount, currency)}</Text>
            </BlockStack></Card>
          </Layout.Section>
        </Layout>

        {/* Grafico fatturato */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Fatturato nel periodo</Text>
            {byDay.length === 0 ? (
              <Text as="p" tone="subdued">Nessun ordine nel periodo.</Text>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={byDay} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorRev2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#008060" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#008060" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `€${v.toFixed(0)}`} width={65} />
                  <Tooltip content={<RevenueTooltip currency={currency} />} />
                  <Area type="monotone" dataKey="revenue" name="Fatturato" stroke="#008060" fill="url(#colorRev2)" strokeWidth={2} />
                  <Area type="monotone" dataKey="orders" name="Ordini" stroke="#1E90FF" fill="none" strokeWidth={1.5} strokeDasharray="4 4" yAxisId={1} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </BlockStack>
        </Card>

        {/* Tabella ordini */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Ordini ({filtered.length})</Text>
              <div style={{ minWidth: 200 }}>
                <Select label="" labelHidden options={statusOptions} value={filterStatus} onChange={setFilterStatus} />
              </div>
            </InlineStack>
            {tableRows.length === 0 ? (
              <Text as="p" tone="subdued">Nessun ordine trovato.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text", "numeric", "text"]}
                headings={["Data", "Ordine", "Cliente", "Pagamento", "Consegna", "Totale", ""]}
                rows={tableRows}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* Modal dettaglio ordine */}
      {selectedOrder && (
        <Modal open title={`Ordine ${selectedOrder.name}`} onClose={() => setSelectedOrder(null)} large>
          <Modal.Section>
            <BlockStack gap="400">
              <InlineStack gap="300" wrap>
                <Badge tone={selectedOrder.financialStatus === "PAID" ? "success" : "attention"}>
                  {formatStatus(selectedOrder.financialStatus)}
                </Badge>
                <Badge>{formatStatus(selectedOrder.fulfillmentStatus || "UNFULFILLED")}</Badge>
                <Text as="span" variant="bodySm" tone="subdued">{formatDate(selectedOrder.createdAt)}</Text>
              </InlineStack>
              {selectedOrder.customer && (
                <Text as="p" variant="bodySm">
                  Cliente: {selectedOrder.customer.firstName} {selectedOrder.customer.lastName} — {selectedOrder.customer.email}
                  {selectedOrder.customer.numberOfOrders > 1 && ` (${selectedOrder.customer.numberOfOrders} ordini totali)`}
                </Text>
              )}
              <DataTable
                columnContentTypes={["text", "numeric", "numeric"]}
                headings={["Prodotto", "Quantità", "Totale"]}
                rows={selectedOrder.lineItems.edges.map((e) => [
                  e.node.title,
                  e.node.quantity,
                  formatCurrency(parseFloat(e.node.originalTotalSet?.shopMoney?.amount || 0), currency),
                ])}
              />
              <InlineStack align="end" gap="400">
                <Text as="p" variant="bodySm" tone="subdued">
                  Sconto: {formatCurrency(parseFloat(selectedOrder.totalDiscountsSet?.shopMoney?.amount || 0), currency)}
                </Text>
                <Text as="p" variant="headingMd" fontWeight="bold">
                  Totale: {formatCurrency(parseFloat(selectedOrder.totalPriceSet.shopMoney.amount), currency)}
                </Text>
              </InlineStack>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
