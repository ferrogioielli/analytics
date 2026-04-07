import { useLoaderData, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo, useEffect } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Badge, DataTable, TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchCustomers, fetchOrders } from "../utils/shopify.server";
import { formatCurrency, formatDate, daysAgo, getPrevPeriod } from "../utils/format";

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
  const totalSpent = customers.reduce((s, c) => s + parseFloat(c.amountSpent?.amount || 0), 0);
  const ltv = customers.length > 0 ? totalSpent / customers.length : 0;

  // Top per spesa
  const topCustomers = [...customers].sort((a, b) => parseFloat(b.amountSpent?.amount || 0) - parseFloat(a.amountSpent?.amount || 0)).slice(0, 10);

  const pieData = [
    { name: "Nuovi nel periodo", value: newInPeriod.length },
    { name: "Abituali (>1 ordine)", value: returning.length },
  ];

  return json({ customers, newInPeriod, returning, newByMonth, ltv, topCustomers, pieData, start, end });
};

function DateRangePicker({ start, end }) {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const [cs, setCs] = useState(start);
  const [ce, setCe] = useState(end);
  useEffect(() => setCs(start), [start]);
  useEffect(() => setCe(end), [end]);
  const presets = [
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

  // RFM segmentation
  const today = new Date();
  const rfmSegments = useMemo(() => {
    const avgSpent = customers.length > 0
      ? customers.reduce((s, c) => s + parseFloat(c.amountSpent?.amount || 0), 0) / customers.length
      : 0;
    return customers.map((c) => {
      const lastOrderDate = c.lastOrder?.createdAt ? new Date(c.lastOrder.createdAt) : null;
      const daysSinceLast = lastOrderDate ? Math.floor((today - lastOrderDate) / 86400000) : 9999;
      const freq = parseInt(c.numberOfOrders) || 0;
      const monetary = parseFloat(c.amountSpent?.amount || 0);
      let segment;
      if (daysSinceLast <= 30 && freq >= 3 && monetary >= avgSpent) segment = "Champions";
      else if (daysSinceLast <= 60 && freq >= 2) segment = "Abituali";
      else if (daysSinceLast <= 30 && freq === 1) segment = "Nuovi";
      else if (daysSinceLast > 90 && freq >= 2) segment = "A rischio";
      else if (daysSinceLast > 180) segment = "Persi";
      else segment = "Occasionali";
      return { ...c, segment, daysSinceLast };
    });
  }, [customers]);

  const segmentCounts = useMemo(() => {
    const map = {};
    for (const c of rfmSegments) map[c.segment] = (map[c.segment] || 0) + 1;
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [rfmSegments]);

  const atRisk = useMemo(() =>
    rfmSegments.filter((c) => c.segment === "A rischio" || c.segment === "Persi")
      .sort((a, b) => b.daysSinceLast - a.daysSinceLast)
      .slice(0, 10)
  , [rfmSegments]);

  const tableRows = filtered.slice(0, 200).map((c) => [
    `${c.firstName || ""} ${c.lastName || ""}`.trim() || "—",
    c.email || "—",
    c.numberOfOrders.toString(),
    formatCurrency(parseFloat(c.amountSpent?.amount || 0), c.amountSpent?.currencyCode),
    c.lastOrder ? formatDate(c.lastOrder.createdAt) : "—",
    formatDate(c.createdAt),
  ]);

  const exportRows = filtered.map((c) => ({
    Nome: `${c.firstName || ""} ${c.lastName || ""}`.trim(),
    Email: c.email || "",
    "N. ordini": c.numberOfOrders,
    "Spesa totale": parseFloat(c.amountSpent?.amount || 0).toFixed(2),
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

        {/* Segmentazione RFM */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Segmentazione clienti (RFM)</Text>
                {segmentCounts.map(([seg, count]) => {
                  const colors = {
                    Champions: "#008060", Abituali: "#1E90FF", Nuovi: "#2ECC71",
                    Occasionali: "#FFB400", "A rischio": "#FF4D4D", Persi: "#888",
                  };
                  return (
                    <InlineStack key={seg} align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <div style={{ width: 10, height: 10, borderRadius: "50%", background: colors[seg] || "#ccc", flexShrink: 0 }} />
                        <Text as="span" variant="bodySm">{seg}</Text>
                      </InlineStack>
                      <Badge tone={seg === "Champions" ? "success" : seg === "A rischio" || seg === "Persi" ? "critical" : "info"}>
                        {count}
                      </Badge>
                    </InlineStack>
                  );
                })}
                <div style={{ borderTop: "1px solid #e1e3e5", paddingTop: 8, marginTop: 4 }}>
                  {[
                    { seg: "Champions", desc: "Ultimo ordine ≤30gg, ≥3 ordini, spesa sopra media — clienti più fedeli" },
                    { seg: "Abituali", desc: "Ultimo ordine ≤60gg, ≥2 ordini — acquistano regolarmente" },
                    { seg: "Nuovi", desc: "Primo e unico ordine negli ultimi 30 giorni" },
                    { seg: "Occasionali", desc: "Non rientrano in altre categorie" },
                    { seg: "A rischio", desc: "Inattivi >90gg ma con ≥2 ordini — da ricontattare" },
                    { seg: "Persi", desc: "Inattivi da oltre 180 giorni" },
                  ].map(({ seg, desc }) => (
                    <Text key={seg} as="p" variant="bodySm" tone="subdued" title={desc} style={{ cursor: "help", marginBottom: 2 }}>
                      <strong>{seg}</strong>: {desc}
                    </Text>
                  ))}
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="twoThirds">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Top 10 clienti per spesa</Text>
                <DataTable
                  columnContentTypes={["text","text","numeric","numeric"]}
                  headings={["Nome","Email","Ordini","Spesa totale"]}
                  rows={topCustomers.map((c) => [
                    `${c.firstName || ""} ${c.lastName || ""}`.trim() || "—",
                    c.email || "—",
                    c.numberOfOrders.toString(),
                    formatCurrency(parseFloat(c.amountSpent?.amount || 0), c.amountSpent?.currencyCode),
                  ])}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Clienti a rischio */}
        {atRisk.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Clienti a rischio / persi</Text>
                <Badge tone="critical">{atRisk.length} clienti</Badge>
              </InlineStack>
              <DataTable
                columnContentTypes={["text","text","numeric","numeric","text"]}
                headings={["Nome","Email","Ordini","Spesa totale","Ultimo ordine"]}
                rows={atRisk.map((c) => [
                  `${c.firstName || ""} ${c.lastName || ""}`.trim() || "—",
                  c.email || "—",
                  c.numberOfOrders.toString(),
                  formatCurrency(parseFloat(c.amountSpent?.amount || 0), c.amountSpent?.currencyCode),
                  c.lastOrder ? `${formatDate(c.lastOrder.createdAt)} (${c.daysSinceLast}gg fa)` : "Mai",
                ])}
              />
            </BlockStack>
          </Card>
        )}

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
