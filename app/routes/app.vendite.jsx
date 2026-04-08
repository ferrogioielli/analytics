import { useLoaderData, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useEffect, useMemo } from "react";
import {
  Page, Card, BlockStack, InlineStack, Text, Button, Badge,
  DataTable, Select, Modal, TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchOrders, groupOrdersByDay, calcKPI, topProductsByRevenue } from "../utils/shopify.server";
import { getPrevPeriod, formatCurrency, formatDate, formatStatus, daysAgo } from "../utils/format";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const start = url.searchParams.get("start") || daysAgo(30);
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  const prev = getPrevPeriod(start, end);

  // Anno precedente: stesso periodo -1 anno
  const yoyStart = new Date(start); yoyStart.setFullYear(yoyStart.getFullYear() - 1);
  const yoyEnd = new Date(end); yoyEnd.setFullYear(yoyEnd.getFullYear() - 1);

  const [orders, prevOrders, yoyOrders] = await Promise.all([
    fetchOrders(admin, { startDate: start, endDate: end }),
    // Periodi comparativi: solo totali/conteggi → skinny query (no lineItems)
    fetchOrders(admin, { startDate: prev.start, endDate: prev.end, skinny: true }),
    fetchOrders(admin, { startDate: yoyStart.toISOString().slice(0, 10), endDate: yoyEnd.toISOString().slice(0, 10), skinny: true }),
  ]);

  const kpi = calcKPI(orders, prevOrders);
  const byDay = groupOrdersByDay(orders);
  const yoyByDay = groupOrdersByDay(yoyOrders);

  // Unisci per posizione (giorno 1 = primo giorno del periodo)
  const mergedByDay = byDay.map((d, i) => ({
    ...d,
    prevRevenue: yoyByDay[i]?.revenue || 0,
    prevOrders: yoyByDay[i]?.orders || 0,
  }));

  const yoyRevenue = yoyOrders.reduce((s, o) => s + parseFloat(o.totalPriceSet.shopMoney.amount), 0);
  const yoyDelta = yoyRevenue > 0 ? ((kpi.revenue - yoyRevenue) / yoyRevenue) * 100 : null;

  // Canali di vendita presenti negli ordini del periodo
  const channelSet = new Map();
  for (const o of orders) {
    const ch = o.channelInformation;
    const name = ch?.channelDefinition?.channelName || ch?.app?.title || "Sconosciuto";
    const handle = ch?.channelDefinition?.handle || ch?.app?.title || "unknown";
    if (!channelSet.has(handle)) channelSet.set(handle, name);
  }
  const channels = Array.from(channelSet.entries()).map(([handle, name]) => ({ handle, name }));

  // Top prodotti per fatturato e per unità
  const topByRevenue = topProductsByRevenue(orders, 10);
  const topByUnits = [...topByRevenue].sort((a, b) => b.units - a.units).slice(0, 10);

  // Aggregato per brand (vendor): fatturato, pezzi, numero ordini distinti
  const brandMap = new Map();
  for (const order of orders) {
    const brandsInOrder = new Set();
    for (const edge of order.lineItems.edges) {
      const item = edge.node;
      const vendor = item.variant?.product?.vendor;
      if (!vendor) continue;
      brandsInOrder.add(vendor);
      if (!brandMap.has(vendor)) brandMap.set(vendor, { name: vendor, revenue: 0, units: 0, orders: 0 });
      const entry = brandMap.get(vendor);
      entry.revenue += parseFloat(item.originalTotalSet?.shopMoney?.amount || 0);
      entry.units += item.quantity;
    }
    for (const v of brandsInOrder) {
      brandMap.get(v).orders += 1;
    }
  }
  const brands = Array.from(brandMap.values()).sort((a, b) => b.revenue - a.revenue);

  return json({ orders, kpi, byDay: mergedByDay, start, end, currency: kpi.currency, yoyRevenue, yoyDelta, channels, topByRevenue, topByUnits, brands });
};

function DateRangePicker({ start, end }) {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const [cs, setCs] = useState(start);
  const [ce, setCe] = useState(end);
  useEffect(() => setCs(start), [start]);
  useEffect(() => setCe(end), [end]);
  const presets = [
    { label: "7 giorni", start: daysAgo(7), end: today },
    { label: "30 giorni", start: daysAgo(30), end: today },
    { label: "90 giorni", start: daysAgo(90), end: today },
    { label: "Anno", start: `${new Date().getFullYear()}-01-01`, end: today },
  ];
  return (
    <BlockStack gap="200">
      <InlineStack gap="200" blockAlign="center" wrap>
        <Text as="span" variant="bodySm" tone="subdued">Periodo:</Text>
        {presets.map((p) => (
          <Button key={p.label} size="slim"
            variant={start === p.start && end === p.end ? "primary" : "plain"}
            onClick={() => navigate(`?start=${p.start}&end=${p.end}`)}>
            {p.label}
          </Button>
        ))}
      </InlineStack>
      <InlineStack gap="200" blockAlign="end" wrap>
        <div style={{ minWidth: 150 }}>
          <TextField label="Dal" type="date" value={cs} onChange={setCs} autoComplete="off" />
        </div>
        <div style={{ minWidth: 150 }}>
          <TextField label="Al" type="date" value={ce} onChange={setCe} autoComplete="off" />
        </div>
        <div style={{ paddingTop: 22 }}>
          <Button onClick={() => navigate(`?start=${cs}&end=${ce}`)}>Applica</Button>
        </div>
      </InlineStack>
    </BlockStack>
  );
}

function groupByPeriod(byDay, period) {
  if (period === "day") return byDay;
  const map = new Map();
  for (const d of byDay) {
    let key;
    if (period === "week") {
      const date = new Date(d.date);
      const jan1 = new Date(date.getFullYear(), 0, 1);
      const week = Math.ceil(((date - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      key = `${date.getFullYear()}-S${String(week).padStart(2, "0")}`;
    } else {
      key = d.date.slice(0, 7);
    }
    if (!map.has(key)) map.set(key, { date: key, revenue: 0, orders: 0 });
    const entry = map.get(key);
    entry.revenue += d.revenue;
    entry.orders += d.orders;
  }
  return Array.from(map.values());
}

function RevenueTooltip({ active, payload, label, currency }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "8px 12px" }}>
      <p style={{ margin: 0, fontWeight: 600, fontSize: 12 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ margin: "2px 0", fontSize: 12, color: p.color }}>
          {p.name}: {p.name === "Fatturato" || p.name === "Anno prec." ? formatCurrency(p.value, currency) : p.value}
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
  const { orders, kpi, byDay, start, end, currency, yoyRevenue, yoyDelta, channels, topByRevenue, topByUnits, brands } = useLoaderData();
  const [filterStatus, setFilterStatus] = useState("");
  const [filterChannel, setFilterChannel] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [groupBy, setGroupBy] = useState("day");

  const filtered = orders.filter((o) => {
    if (filterStatus && o.financialStatus !== filterStatus) return false;
    if (filterChannel) {
      const ch = o.channelInformation;
      const handle = ch?.channelDefinition?.handle || ch?.app?.title || "unknown";
      if (handle !== filterChannel) return false;
    }
    if (filterBrand) {
      const hasBrand = o.lineItems.edges.some((e) => e.node.variant?.product?.vendor === filterBrand);
      if (!hasBrand) return false;
    }
    return true;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const filteredTotal = filtered.reduce((s, o) => s + parseFloat(o.totalPriceSet.shopMoney.amount), 0);

  const chartData = useMemo(() => groupByPeriod(byDay, groupBy), [byDay, groupBy]);

  const maxOrder = orders.length > 0
    ? Math.max(...orders.map((o) => parseFloat(o.totalPriceSet?.shopMoney?.amount || 0)))
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

  const channelOptions = [
    { label: "Tutti i canali", value: "" },
    ...channels.map((c) => ({ label: c.name, value: c.handle })),
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          <Card><BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">Fatturato totale</Text>
            <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(kpi.revenue, currency)}</Text>
          </BlockStack></Card>
          <Card><BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">Media giornaliera</Text>
            <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(avgDaily, currency)}</Text>
          </BlockStack></Card>
          <Card><BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">N. ordini</Text>
            <Text as="p" variant="headingLg" fontWeight="bold">{kpi.count}</Text>
          </BlockStack></Card>
          <Card><BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">Ordine più alto</Text>
            <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(maxOrder, currency)}</Text>
          </BlockStack></Card>
          <Card><BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">vs anno precedente</Text>
            <InlineStack gap="200" blockAlign="center" wrap={false}>
              <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(yoyRevenue, currency)}</Text>
              {yoyDelta !== null && (
                <Badge tone={yoyDelta >= 0 ? "success" : "critical"}>
                  {yoyDelta >= 0 ? "▲" : "▼"}{Math.abs(yoyDelta).toFixed(1)}%
                </Badge>
              )}
            </InlineStack>
          </BlockStack></Card>
        </div>

        {/* Grafico fatturato */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">Fatturato nel periodo</Text>
              <InlineStack gap="100">
                {["day", "week", "month"].map((g) => (
                  <Button key={g} size="slim"
                    variant={groupBy === g ? "primary" : "plain"}
                    onClick={() => setGroupBy(g)}>
                    {g === "day" ? "Giorno" : g === "week" ? "Settimana" : "Mese"}
                  </Button>
                ))}
              </InlineStack>
            </InlineStack>
            {chartData.length === 0 ? (
              <Text as="p" tone="subdued">Nessun ordine nel periodo.</Text>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={chartData} margin={{ top: 5, right: 40, left: 10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorRev2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#008060" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#008060" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
                  <YAxis yAxisId={0} tick={{ fontSize: 11 }} tickFormatter={(v) => `€${v.toFixed(0)}`} width={65} />
                  <YAxis yAxisId={1} orientation="right" tick={{ fontSize: 11 }} allowDecimals={false} width={30} />
                  <Tooltip content={<RevenueTooltip currency={currency} />} />
                  <Area yAxisId={0} type="monotone" dataKey="revenue" name="Fatturato" stroke="#008060" fill="url(#colorRev2)" strokeWidth={2} />
                  <Area yAxisId={0} type="monotone" dataKey="prevRevenue" name="Anno prec." stroke="#cccccc" fill="none" strokeWidth={1.5} strokeDasharray="4 4" />
                  <Area yAxisId={1} type="monotone" dataKey="orders" name="Ordini" stroke="#1E90FF" fill="none" strokeWidth={1.5} strokeDasharray="4 4" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </BlockStack>
        </Card>

        {/* Top prodotti */}
        {topByRevenue.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Top prodotti per fatturato</Text>
                  <BlockStack gap="100">
                    {topByRevenue.map((p, i) => (
                      <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: 12, color: "#6d7175", fontWeight: 600, flexShrink: 0 }}>{i + 1}.</span>
                          <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{p.title}</span>
                        </div>
                        <span style={{ fontSize: 12, color: "#6d7175", flexShrink: 0 }}>{formatCurrency(p.revenue, currency)}</span>
                      </div>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            </div>
            <div style={{ minWidth: 0 }}>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Top prodotti per unità vendute</Text>
                  <BlockStack gap="100">
                    {topByUnits.map((p, i) => (
                      <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: 12, color: "#6d7175", fontWeight: 600, flexShrink: 0 }}>{i + 1}.</span>
                          <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{p.title}</span>
                        </div>
                        <span style={{ fontSize: 12, color: "#6d7175", flexShrink: 0 }}>{p.units} pz</span>
                      </div>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            </div>
          </div>
        )}

        {/* Vendite per brand (cliccabile per filtrare la tabella ordini) */}
        {brands.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <Text as="h2" variant="headingMd">Vendite per brand</Text>
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {brands.length} brand · clicca per filtrare
                  </Text>
                  {filterBrand && (
                    <Button size="slim" onClick={() => setFilterBrand("")}>
                      Rimuovi filtro: {filterBrand} ✕
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
                {brands.map((b) => {
                  const isActive = filterBrand === b.name;
                  return (
                    <div
                      key={b.name}
                      onClick={() => setFilterBrand(isActive ? "" : b.name)}
                      style={{
                        cursor: "pointer",
                        padding: "10px 12px",
                        border: isActive ? "2px solid #008060" : "1px solid #e1e3e5",
                        borderRadius: 8,
                        background: isActive ? "#f0f9f5" : "#fff",
                        transition: "border-color 0.15s, background 0.15s",
                        minWidth: 0,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
                          {b.name}
                        </span>
                        <span style={{ fontSize: 12, color: "#008060", fontWeight: 600, flexShrink: 0 }}>
                          {formatCurrency(b.revenue, currency)}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: "#6d7175", marginTop: 2 }}>
                        {b.orders} {b.orders === 1 ? "ordine" : "ordini"} · {b.units} pz
                      </div>
                    </div>
                  );
                })}
              </div>
            </BlockStack>
          </Card>
        )}

        {/* Tabella ordini */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Ordini ({filtered.length})</Text>
              <InlineStack gap="200">
                {channels.length > 1 && (
                  <div style={{ minWidth: 180 }}>
                    <Select label="" labelHidden options={channelOptions} value={filterChannel} onChange={setFilterChannel} />
                  </div>
                )}
                <div style={{ minWidth: 200 }}>
                  <Select label="" labelHidden options={statusOptions} value={filterStatus} onChange={setFilterStatus} />
                </div>
              </InlineStack>
            </InlineStack>
            {tableRows.length === 0 ? (
              <Text as="p" tone="subdued">Nessun ordine trovato.</Text>
            ) : (
              <>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "numeric", "text"]}
                  headings={["Data", "Ordine", "Cliente", "Pagamento", "Consegna", "Totale", ""]}
                  rows={tableRows}
                />
                <div style={{ borderTop: "2px solid #e1e3e5", paddingTop: 10, marginTop: 4 }}>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodySm" tone="subdued">{filtered.length} ordini filtrati</Text>
                    <Text as="p" variant="bodyMd" fontWeight="semibold">Totale: {formatCurrency(filteredTotal, currency)}</Text>
                  </InlineStack>
                </div>
              </>
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
