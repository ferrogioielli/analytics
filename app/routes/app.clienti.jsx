import { useLoaderData } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo, useEffect } from "react";
import {
  Page, Card, BlockStack, InlineStack, Text, Button, Badge, DataTable,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchCustomers, fetchOrders } from "../utils/shopify.server";
import { formatCurrency, formatDate, daysAgo } from "../utils/format";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const today = new Date().toISOString().slice(0, 10);

  // Carica tutti i clienti + ordini ultimi 30gg (per Top 10 per periodo)
  const [customers, orders30] = await Promise.all([
    fetchCustomers(admin),
    fetchOrders(admin, { startDate: daysAgo(30), endDate: today }),
  ]);

  // Clienti abituali (>1 ordine)
  const returning = customers.filter((c) => parseInt(c.numberOfOrders) > 1);

  // Nuovi ultimi 30gg (data registrazione)
  const thirtyDaysAgo = daysAgo(30);
  const newLast30 = customers.filter((c) => c.createdAt?.slice(0, 10) >= thirtyDaysAgo);

  // Spesa media per cliente (LTV = Lifetime Value = spesa totale media storica)
  const totalSpent = customers.reduce((s, c) => s + parseFloat(c.amountSpent?.amount || 0), 0);
  const ltv = customers.length > 0 ? totalSpent / customers.length : 0;
  const currency = customers[0]?.amountSpent?.currencyCode || "EUR";

  // Nuovi clienti per mese (ultimi 12)
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

  // Ordini 30gg serializzati (solo i campi necessari per Top 10 per periodo)
  const ordersSummary = orders30.map((o) => ({
    createdAt: o.createdAt,
    amount: parseFloat(o.totalPriceSet?.shopMoney?.amount || 0),
    customerId: o.customer?.id || null,
    customerName: o.customer
      ? `${o.customer.firstName || ""} ${o.customer.lastName || ""}`.trim() || o.customer.email || "—"
      : null,
    customerEmail: o.customer?.email || "—",
  })).filter((o) => o.customerId);

  return json({ customers, returning, newLast30, ltv, newByMonth, ordersSummary, currency });
};

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

// Aggrega ordini per cliente e restituisce top N
function topByOrders(orders, n = 10) {
  const map = new Map();
  for (const o of orders) {
    if (!o.customerId) continue;
    if (!map.has(o.customerId)) map.set(o.customerId, { name: o.customerName, email: o.customerEmail, spend: 0, orders: 0 });
    map.get(o.customerId).spend += o.amount;
    map.get(o.customerId).orders += 1;
  }
  return [...map.values()].sort((a, b) => b.spend - a.spend).slice(0, n);
}

const RFM_SEGMENTS = [
  { key: "Champions",    color: "#008060", tone: "success",  label: "Champion",    desc: "Compra spesso, ha speso tanto, è tornato di recente. Cliente ideale." },
  { key: "Abituali",    color: "#1E90FF", tone: "info",     label: "Abituale",    desc: "Torna regolarmente, ≥2 ordini negli ultimi 60 giorni." },
  { key: "Nuovi",       color: "#2ECC71", tone: "success",  label: "Nuovo",       desc: "Ha fatto il primo ordine negli ultimi 30 giorni. Da fidelizzare." },
  { key: "Occasionali", color: "#FFB400", tone: "warning",  label: "Occasionale", desc: "Compra ogni tanto, senza un ritmo preciso." },
  { key: "A rischio",   color: "#FF4D4D", tone: "critical", label: "A rischio",   desc: "Aveva ≥2 ordini ma non compra da oltre 90 giorni. Da ricontattare." },
  { key: "Persi",       color: "#888888", tone: "critical", label: "Perso",       desc: "Nessun acquisto da oltre 180 giorni." },
];

// Componente lista clienti (stessa grafica Top 10)
function ClientiList({ items, currency, emptyMsg, showInactivo = false }) {
  if (!items.length) return <Text as="p" tone="subdued">{emptyMsg}</Text>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 40px" }}>
      {items.map((c, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #f4f4f4" }}>
          <InlineStack gap="200" blockAlign="center">
            <span style={{ fontSize: 13, color: "#6d7175", minWidth: 20, fontWeight: 600 }}>{i + 1}.</span>
            <BlockStack gap="0">
              <Text as="span" variant="bodySm" fontWeight="semibold">{c.name}</Text>
              <Text as="span" variant="bodySm" tone="subdued">{c.email}</Text>
            </BlockStack>
          </InlineStack>
          <BlockStack gap="0">
            <Text as="span" variant="bodySm" fontWeight="semibold">{formatCurrency(c.spend, currency)}</Text>
            {showInactivo
              ? <Text as="span" variant="bodySm" tone="subdued">
                  {c.daysSinceLast < 9999 ? `inattivo da ${c.daysSinceLast}gg` : "—"}
                </Text>
              : <Text as="span" variant="bodySm" tone="subdued">{c.orders} {c.orders === 1 ? "ordine" : "ordini"}</Text>
            }
          </BlockStack>
        </div>
      ))}
    </div>
  );
}

export default function Clienti() {
  const { customers, returning, newLast30, ltv, newByMonth, ordersSummary, currency } = useLoaderData();

  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const [top10Period, setTop10Period] = useState("tutto"); // oggi | settimana | mese | tutto

  // ── RFM segmentation ──
  const rfmSegments = useMemo(() => {
    const avgSpent = customers.length > 0
      ? customers.reduce((s, c) => s + parseFloat(c.amountSpent?.amount || 0), 0) / customers.length
      : 0;
    const now = new Date();
    return customers.map((c) => {
      const lastOrderDate = c.lastOrder?.createdAt ? new Date(c.lastOrder.createdAt) : null;
      const daysSinceLast = lastOrderDate ? Math.floor((now - lastOrderDate) / 86400000) : 9999;
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

  // ── Top 10 filtrato per periodo ──
  const top10 = useMemo(() => {
    if (top10Period === "tutto") {
      return [...customers]
        .sort((a, b) => parseFloat(b.amountSpent?.amount || 0) - parseFloat(a.amountSpent?.amount || 0))
        .slice(0, 10)
        .map((c) => ({
          name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.email || "—",
          email: c.email || "—",
          spend: parseFloat(c.amountSpent?.amount || 0),
          orders: parseInt(c.numberOfOrders) || 0,
        }));
    }
    const todayStr = new Date().toISOString().slice(0, 10);
    const filtered = ordersSummary.filter((o) => {
      const d = o.createdAt.slice(0, 10);
      if (top10Period === "oggi") return d === todayStr;
      if (top10Period === "settimana") return d >= daysAgo(7);
      if (top10Period === "mese") return d >= daysAgo(30);
      return true;
    });
    return topByOrders(filtered, 10);
  }, [customers, ordersSummary, top10Period]);

  // ── Clienti a rischio (A rischio + Persi, top 10 per inattività) ──
  const atRisk = useMemo(() =>
    rfmSegments
      .filter((c) => c.segment === "A rischio" || c.segment === "Persi")
      .sort((a, b) => b.daysSinceLast - a.daysSinceLast)
      .slice(0, 10)
      .map((c) => ({
        name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.email || "—",
        email: c.email || "—",
        spend: parseFloat(c.amountSpent?.amount || 0),
        orders: parseInt(c.numberOfOrders) || 0,
        daysSinceLast: c.daysSinceLast,
      }))
  , [rfmSegments]);

  // ── Clienti abituali (Champions + Abituali, top 10 per spesa) ──
  const habitual = useMemo(() =>
    rfmSegments
      .filter((c) => c.segment === "Champions" || c.segment === "Abituali")
      .sort((a, b) => parseFloat(b.amountSpent?.amount || 0) - parseFloat(a.amountSpent?.amount || 0))
      .slice(0, 10)
      .map((c) => ({
        name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.email || "—",
        email: c.email || "—",
        spend: parseFloat(c.amountSpent?.amount || 0),
        orders: parseInt(c.numberOfOrders) || 0,
        daysSinceLast: c.daysSinceLast,
      }))
  , [rfmSegments]);

  // ── Tabella tutti i clienti ──
  const totalPages = Math.ceil(rfmSegments.length / PAGE_SIZE);
  const pageData = rfmSegments.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const segTones = { Champions: "success", Abituali: "info", Nuovi: "success", Occasionali: "warning", "A rischio": "critical", Persi: "critical" };

  const tableRows = pageData.map((c) => [
    `${c.firstName || ""} ${c.lastName || ""}`.trim() || "—",
    c.email || "—",
    <Badge key={c.id + "seg"} tone={segTones[c.segment] || "info"}>{c.segment}</Badge>,
    c.numberOfOrders.toString(),
    formatCurrency(parseFloat(c.amountSpent?.amount || 0), c.amountSpent?.currencyCode),
    c.lastOrder ? formatDate(c.lastOrder.createdAt) : "—",
    c.daysSinceLast < 9999 ? `${c.daysSinceLast}gg fa` : "—",
  ]);

  const exportRows = rfmSegments.map((c) => ({
    Nome: `${c.firstName || ""} ${c.lastName || ""}`.trim(),
    Email: c.email || "",
    Segmento: c.segment,
    "N. ordini": c.numberOfOrders,
    "Spesa totale": parseFloat(c.amountSpent?.amount || 0).toFixed(2),
    "Ultimo ordine": c.lastOrder ? formatDate(c.lastOrder.createdAt) : "",
    "Registrato il": formatDate(c.createdAt),
  }));

  const periodLabels = [
    { key: "oggi", label: "Oggi" },
    { key: "settimana", label: "Settimana" },
    { key: "mese", label: "Mese" },
    { key: "tutto", label: "Tutto" },
  ];

  return (
    <Page title="Clienti">
      <TitleBar title="Clienti" />
      <BlockStack gap="500">

        {/* ── HEADER export ── */}
        <InlineStack align="end">
          <InlineStack gap="200">
            <Button size="slim" onClick={() => exportCSV(exportRows, "clienti.csv")}>CSV</Button>
            <Button size="slim" onClick={() => exportExcel(exportRows, "clienti.xlsx")}>Excel</Button>
          </InlineStack>
        </InlineStack>

        {/* ── KPI riga unica ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Clienti totali</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{customers.length}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Abituali (≥2 ordini)</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{returning.length}</Text>
              <Text as="p" variant="bodySm" tone="subdued">{customers.length > 0 ? ((returning.length / customers.length) * 100).toFixed(0) : 0}% del totale</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <span title="Spesa media storica per cliente (Lifetime Value): somma totale spesa / numero clienti" style={{ cursor: "help" }}>
                <Text as="p" variant="bodySm" tone="subdued">Spesa media cliente ⓘ</Text>
              </span>
              <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(ltv, currency)}</Text>
              <Text as="p" variant="bodySm" tone="subdued">media storica per cliente</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Nuovi ultimi 30gg</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{newLast30.length}</Text>
            </BlockStack>
          </Card>
        </div>

        {/* ── TOP 10 ── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">Top 10 clienti per spesa</Text>
              <InlineStack gap="100">
                {periodLabels.map(({ key, label }) => (
                  <Button key={key} size="slim"
                    variant={top10Period === key ? "primary" : "plain"}
                    onClick={() => setTop10Period(key)}>
                    {label}
                  </Button>
                ))}
              </InlineStack>
            </InlineStack>
            <ClientiList items={top10} currency={currency} emptyMsg="Nessun ordine nel periodo selezionato." />
          </BlockStack>
        </Card>

        {/* ── CLIENTI A RISCHIO ── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Clienti a rischio</Text>
              <Text as="p" variant="bodySm" tone="subdued">Non acquistano da oltre 90 giorni</Text>
            </InlineStack>
            <ClientiList items={atRisk} currency={currency} emptyMsg="Nessun cliente a rischio." showInactivo />
          </BlockStack>
        </Card>

        {/* ── CLIENTI ABITUALI ── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Clienti abituali</Text>
              <Text as="p" variant="bodySm" tone="subdued">Champions e abituali per spesa totale</Text>
            </InlineStack>
            <ClientiList items={habitual} currency={currency} emptyMsg="Nessun cliente abituale trovato." />
          </BlockStack>
        </Card>

        {/* ── NUOVI CLIENTI PER MESE ── */}
        {newByMonth.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Nuovi clienti per mese (ultimi 12)</Text>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={newByMonth} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" name="Nuovi clienti" fill="#008060" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </BlockStack>
          </Card>
        )}

        {/* ── TABELLA TUTTI I CLIENTI ── */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Tutti i clienti ({rfmSegments.length})</Text>

            {totalPages > 1 && (
              <InlineStack align="space-between" blockAlign="center">
                <Button size="slim" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prec.</Button>
                <Text as="span" variant="bodySm">
                  Pag. {page + 1} / {totalPages} ({page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, rfmSegments.length)} di {rfmSegments.length})
                </Text>
                <Button size="slim" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Succ. →</Button>
              </InlineStack>
            )}

            {tableRows.length === 0 ? (
              <Text as="p" tone="subdued">Nessun cliente trovato.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text","text","text","numeric","numeric","text","text"]}
                headings={["Nome","Email","Segmento","Ordini","Spesa totale","Ultimo ordine","Inattivo da"]}
                rows={tableRows}
              />
            )}

            {totalPages > 1 && (
              <InlineStack align="center" gap="200" blockAlign="center">
                <Button size="slim" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Precedente</Button>
                <Text as="span" variant="bodySm">Pagina {page + 1} di {totalPages}</Text>
                <Button size="slim" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Successiva →</Button>
              </InlineStack>
            )}
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
