import { useLoaderData, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useEffect } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Badge, Box, TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import {
  fetchOrders, groupOrdersByDay, calcKPI, topProductsByRevenue,
  ordersByFinancialStatus,
} from "../utils/shopify.server";
import { getDateRange, getPrevPeriod, formatCurrency, formatDate, daysAgo } from "../utils/format";

// ─── LOADER ────────────────────────────────────────────────────────────────────
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
  const topProducts = topProductsByRevenue(orders, 10);
  const byStatus = ordersByFinancialStatus(orders);

  return json({ kpi, byDay, topProducts, byStatus, start, end, currency: kpi.currency });
};

// ─── COLORI ────────────────────────────────────────────────────────────────────
const COLORS = ["#008060", "#1E90FF", "#FFB400", "#FF4D4D", "#9B59B6", "#2ECC71"];

// ─── KPI CARD ─────────────────────────────────────────────────────────────────
function KpiCard({ title, value, delta }) {
  const isPos = delta !== null && delta > 0;
  const isNeg = delta !== null && delta < 0;
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{title}</Text>
        <Text as="p" variant="headingLg" fontWeight="bold">{value}</Text>
        {delta !== null && (
          <Badge tone={isPos ? "success" : isNeg ? "critical" : "info"}>
            {isPos ? "+" : ""}{delta.toFixed(1)}% vs periodo prec.
          </Badge>
        )}
      </BlockStack>
    </Card>
  );
}

// ─── DATE RANGE PICKER ─────────────────────────────────────────────────────────
function DateRangePicker({ start, end }) {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const [cs, setCs] = useState(start);
  const [ce, setCe] = useState(end);
  useEffect(() => setCs(start), [start]);
  useEffect(() => setCe(end), [end]);

  const presets = [
    { label: "Oggi", start: today, end: today },
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

// ─── TOOLTIP ──────────────────────────────────────────────────────────────────
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

// ─── EXPORT CSV ───────────────────────────────────────────────────────────────
function exportCSV(rows, filename) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── COMPONENT ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { kpi, byDay, topProducts, byStatus, start, end, currency } = useLoaderData();

  return (
    <Page>
      <TitleBar title="Ferro Reports — Dashboard" />
      <BlockStack gap="500">
        {/* Header */}
        <InlineStack align="space-between" blockAlign="center" wrap>
          <DateRangePicker start={start} end={end} />
          <Button
            size="slim"
            onClick={() => exportCSV(byDay.map((d) => ({ Data: d.date, Fatturato: d.revenue.toFixed(2), Ordini: d.orders })), `dashboard_${start}_${end}.csv`)}
          >
            Esporta CSV
          </Button>
        </InlineStack>

        {/* KPI */}
        <Layout>
          <Layout.Section variant="oneQuarter">
            <KpiCard title="Fatturato" value={formatCurrency(kpi.revenue, currency)} delta={kpi.revenueDelta} />
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <KpiCard title="Ordini" value={kpi.count.toString()} delta={kpi.countDelta} />
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <KpiCard title="Scontrino medio" value={formatCurrency(kpi.aov, currency)} delta={kpi.aovDelta} />
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <KpiCard title="Nuovi clienti" value={kpi.newCustomers.toString()} delta={kpi.newDelta} />
          </Layout.Section>
        </Layout>

        {/* Grafici riga 1 */}
        <Layout>
          <Layout.Section variant="twoThirds">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Fatturato giornaliero</Text>
                {byDay.length === 0 ? (
                  <Text as="p" tone="subdued">Nessun ordine nel periodo selezionato.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart data={byDay} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#008060" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#008060" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `€${v.toFixed(0)}`} width={65} />
                      <Tooltip content={<RevenueTooltip currency={currency} />} />
                      <Area type="monotone" dataKey="revenue" name="Fatturato" stroke="#008060" fill="url(#colorRev)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Stato ordini</Text>
                {byStatus.length === 0 ? (
                  <Text as="p" tone="subdued">Nessun dato.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie data={byStatus} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={85}
                        label={({ name, percent }) => percent > 0.05 ? `${(percent * 100).toFixed(0)}%` : ""}
                        labelLine={false}>
                        {byStatus.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v, name) => [v, name]} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
                {byStatus.map((s, i) => (
                  <InlineStack key={i} gap="200" blockAlign="center">
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                    <Text as="span" variant="bodySm">{s.name}: {s.value}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Grafici riga 2 */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Ordini per giorno</Text>
                {byDay.length === 0 ? (
                  <Text as="p" tone="subdued">Nessun ordine nel periodo.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={byDay} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d) => d.slice(5)} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip content={<RevenueTooltip currency={currency} />} />
                      <Bar dataKey="orders" name="Ordini" fill="#1E90FF" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Top 10 prodotti per fatturato</Text>
                {topProducts.length === 0 ? (
                  <Text as="p" tone="subdued">Nessun dato nel periodo.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={topProducts} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => `€${v.toFixed(0)}`} />
                      <YAxis type="category" dataKey="title" tick={{ fontSize: 10 }} width={130} />
                      <Tooltip formatter={(v) => formatCurrency(v, currency)} />
                      <Bar dataKey="revenue" name="Fatturato" fill="#FFB400" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
