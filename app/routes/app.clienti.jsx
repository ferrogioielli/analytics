import { useLoaderData, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Badge, DataTable, TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchCustomers, fetchOrders, formatCurrency, formatDate, daysAgo, getPrevPeriod } from "../utils/shopify.server";

const COLORS = ["#008060", "#1E90FF", "#FFB400", "#FF4D4D"];

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const start = url.searchParams.get("start") || daysAgo(30);
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);

  const [customers, orders] = await Promise.all([
    fetchCustomers(admin),
    fetchOrders(admin, { startDate: start, endDate: end }),
  ]);

  // Nuovi clienti nel periodo = primo ordine nel periodo
  const newInPeriod = customers.filter((c) => {
    const created = c.createdAt?.slice(0, 10);
    return created >= start && created <= end;
  });

  // Clienti abituali = numberOfOrders > 1
  const returning = customers.filter((c) => parseInt(c.numberOfOrders) > 1);

  // Nuovi clienti per mese
  const monthMap = new Map();
  for (const c of customers) {
    const month = c.createdAt?.slice(0, 7);
    if (!month) continue;
    monthMap.set(month, (monthMap.get(month) || 0) + 1);
  }
  const newByMonth = Array.from(monthMap.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12);

  // LTV medio
  const totalSpent = customers.reduce((s, c) => s + parseFloat(c.totalSpentV2?.amount || 0), 0);
  const ltv = customers.length > 0 ? totalSpent / customers.length : 0;

  // Top per spesa
  const topCustomers = [...customers].sort((a, b) => parseFloat(b.totalSpentV2?.amount || 0) - parseFloat(a.totalSpentV2?.amount || 0)).slice(0, 5);

  const pieData = [
    { name: "Nuovi nel periodo", value: newInPeriod.length },
    { name: "Abituali (>1 ordine)", value: returning.length },
  ];

  return json({ customers, newInPeriod, returning, newByMonth, ltv, topCustomers, pieData, start, end });
};

function DateRangePicker({ start, end }) {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const presets = [
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
    XLSX.utils.book_append_sheet(wb, ws, "Clienti");
    XLSX.writeFile(wb, filename);
  });
}

export default function Clienti() {
  const { customers, newInPeriod, returning, newByMonth, ltv, topCustomers, pieData, start, end } = useLoaderData();
  const [search, setSearch] = useState("");
  const [minOrders, setMinOrders] = useState("");

  const filtered = useMemo(() => customers.filter((c) => {
    const fullName = `${c.firstName || ""} ${c.lastName || ""} ${c.email || ""}`.toLowerCase();
    if (search && !fullName.includes(search.toLowerCase())) return false;
    if (minOrders && parseInt(c.numberOfOrders) < parseInt(minOrders)) return false;
    return true;
  }), [customers, search, minOrders]);

  const topByOrders = [...customers].sort((a, b) => parseInt(b.numberOfOrders) - parseInt(a.numberOfOrders)).slice(0, 1)[0];

  const tableRows = filtered.slice(0, 200).map((c) => [
    `${c.firstName || ""} ${c.lastName || ""}`.trim() || "—",
    c.email || "—",
    c.numberOfOrders.toString(),
    formatCurrency(parseFloat(c.totalSpentV2?.amount || 0), c.totalSpentV2?.currencyCode),
    c.lastOrder ? formatDate(c.lastOrder.createdAt) : "—",
    formatDate(c.createdAt),
  ]);

  const exportRows = filtered.map((c) => ({
    Nome: `${c.firstName || ""} ${c.lastName || ""}`.trim(),
    Email: c.email || "",
    "N. ordini": c.numberOfOrders,
    "Spesa totale": parseFloat(c.totalSpentV2?.amount || 0).toFixed(2),
    "Ultimo ordine": c.lastOrder ? formatDate(c.lastOrder.createdAt) : "",
    "Data registrazione": formatDate(c.createdAt),
  }));

  return (
    <Page title="Clienti">
      <TitleBar title="Clienti" />
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <DateRangePicker start={start} end={end} />
          <InlineStack gap="200">
            <Button size="slim" onClick={() => exportCSV(exportRows, `clienti_${start}_${end}.csv`)}>CSV</Button>
            <Button size="slim" onClick={() => exportExcel(exportRows, `clienti_${start}_${end}.xlsx`)}>Excel</Button>
          </InlineStack>
        </InlineStack>

        {/* KPI */}
        <Layout>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Clienti totali</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{customers.length}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Nuovi nel periodo</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{newInPeriod.length}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">LTV medio</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(ltv)}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Clienti abituali</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{returning.length}</Text>
              <Text as="p" variant="bodySm" tone="subdued">&gt;1 ordine</Text>
            </BlockStack></Card>
          </Layout.Section>
        </Layout>

        {/* Grafici */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Nuovi vs abituali</Text>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80}
                      label={({ name, percent }) => percent > 0.05 ? `${(percent * 100).toFixed(0)}%` : ""} labelLine={false}>
                      {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                {pieData.map((d, i) => (
                  <InlineStack key={i} gap="200" blockAlign="center">
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS[i], flexShrink: 0 }} />
                    <Text as="span" variant="bodySm">{d.name}: {d.value}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="twoThirds">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Nuovi clienti per mese (ultimi 12)</Text>
                {newByMonth.length === 0 ? (
                  <Text as="p" tone="subdued">Nessun dato.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={newByMonth} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="count" name="Nuovi clienti" fill="#008060" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Tabella */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">Clienti ({filtered.length}{filtered.length > 200 ? ", mostrando 200" : ""})</Text>
              <InlineStack gap="200" wrap>
                <div style={{ minWidth: 200 }}>
                  <TextField label="" labelHidden placeholder="Cerca nome / email..." value={search} onChange={setSearch} autoComplete="off" />
                </div>
                <div style={{ minWidth: 140 }}>
                  <TextField label="" labelHidden placeholder="Min ordini..." type="number" value={minOrders} onChange={setMinOrders} autoComplete="off" />
                </div>
              </InlineStack>
            </InlineStack>
            {tableRows.length === 0 ? (
              <Text as="p" tone="subdued">Nessun cliente trovato.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text","text","numeric","numeric","text","text"]}
                headings={["Nome","Email","Ordini","Spesa totale","Ultimo ordine","Registrato il"]}
                rows={tableRows}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
