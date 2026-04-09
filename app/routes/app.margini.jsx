import { useLoaderData, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo, useEffect } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, DataTable, Badge, TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchProducts, fetchOrders } from "../utils/shopify.server";
import { formatCurrency, daysAgo } from "../utils/format";

const MARGIN_COLORS = ["#008060","#1E90FF","#FFB400","#9B59B6","#2ECC71","#E67E22","#E74C3C","#1ABC9C"];

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const start = url.searchParams.get("start") || daysAgo(7);
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);

  const [products, orders] = await Promise.all([
    fetchProducts(admin),
    fetchOrders(admin, { startDate: start, endDate: end }),
  ]);

  // SKU → unitCost map
  const skuCostMap = new Map();
  for (const p of products) {
    for (const edge of p.variants.edges) {
      const v = edge.node;
      const cost = parseFloat(v.inventoryItem?.unitCost?.amount || 0);
      if (v.sku && cost > 0) skuCostMap.set(v.sku, cost);
    }
  }

  // Aggregate revenue + cost per product from orders
  const productMap = new Map();
  for (const order of orders) {
    for (const edge of order.lineItems.edges) {
      const item = edge.node;
      const product = item.variant?.product;
      if (!product) continue;
      const sku = item.variant?.sku || "";
      const unitCost = skuCostMap.get(sku) || 0;
      const revenue = parseFloat(item.originalTotalSet?.shopMoney?.amount || 0);
      const qty = item.quantity;

      const id = product.id;
      if (!productMap.has(id)) {
        productMap.set(id, { id, title: product.title, vendor: product.vendor || "", revenue: 0, totalCost: 0, units: 0, hasCost: false });
      }
      const e = productMap.get(id);
      e.revenue += revenue;
      e.totalCost += unitCost * qty;
      e.units += qty;
      if (unitCost > 0) e.hasCost = true;
    }
  }

  const productList = Array.from(productMap.values()).map((p) => ({
    ...p,
    profit: p.revenue - p.totalCost,
    margin: p.hasCost && p.revenue > 0 ? ((p.revenue - p.totalCost) / p.revenue) * 100 : null,
  })).sort((a, b) => b.profit - a.profit);

  // Brand summary
  const brandMap = new Map();
  for (const p of productList) {
    const brand = p.vendor || "—";
    if (!brandMap.has(brand)) brandMap.set(brand, { brand, revenue: 0, totalCost: 0, units: 0, hasCost: false });
    const b = brandMap.get(brand);
    b.revenue += p.revenue;
    b.totalCost += p.totalCost;
    b.units += p.units;
    if (p.hasCost) b.hasCost = true;
  }
  const brandList = Array.from(brandMap.values()).map((b) => ({
    ...b,
    profit: b.revenue - b.totalCost,
    margin: b.hasCost && b.revenue > 0 ? ((b.revenue - b.totalCost) / b.revenue) * 100 : null,
  })).sort((a, b) => b.profit - a.profit);

  const withCost = productList.filter((p) => p.hasCost);
  const totalProfit = withCost.reduce((s, p) => s + p.profit, 0);
  const totalCostRevenue = withCost.reduce((s, p) => s + p.revenue, 0);
  const avgMargin = totalCostRevenue > 0 ? (totalProfit / totalCostRevenue) * 100 : null;
  const noCostCount = productList.filter((p) => !p.hasCost).length;
  const currency = orders[0]?.totalPriceSet?.shopMoney?.currencyCode || "EUR";

  return json({ productList, brandList, totalProfit, avgMargin, noCostCount, start, end, currency });
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
    XLSX.utils.book_append_sheet(wb, ws, "Margini");
    XLSX.writeFile(wb, filename);
  });
}

function MarginBadge({ margin }) {
  if (margin === null) return <span style={{ color: "#999" }}>N/D</span>;
  const tone = margin < 0 ? "critical" : margin < 20 ? "warning" : "success";
  return <Badge tone={tone}>{margin.toFixed(1)}%</Badge>;
}

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
        <div style={{ minWidth: 150 }}><TextField label="Dal" type="date" value={cs} onChange={setCs} autoComplete="off" /></div>
        <div style={{ minWidth: 150 }}><TextField label="Al" type="date" value={ce} onChange={setCe} autoComplete="off" /></div>
        <div style={{ paddingTop: 22 }}><Button onClick={() => navigate(`?start=${cs}&end=${ce}`)}>Applica</Button></div>
      </InlineStack>
    </BlockStack>
  );
}

export default function Margini() {
  const { productList, brandList, totalProfit, avgMargin, noCostCount, start, end, currency } = useLoaderData();
  const [sortCol, setSortCol] = useState(3);
  const [sortDir, setSortDir] = useState("descending");

  const SORT_KEYS = [null, null, "units", "revenue", "totalCost", "profit", "margin"];

  const sorted = useMemo(() => {
    const key = SORT_KEYS[sortCol];
    if (!key) return productList;
    return [...productList].sort((a, b) => {
      const av = a[key] ?? -Infinity;
      const bv = b[key] ?? -Infinity;
      return sortDir === "ascending" ? av - bv : bv - av;
    });
  }, [productList, sortCol, sortDir]);

  const top15Revenue = [...productList]
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 15)
    .map((p) => ({ name: p.title.length > 30 ? p.title.slice(0, 28) + "…" : p.title, profitto: Math.max(0, p.profit) }));

  const brandChartData = [...brandList]
    .sort((a, b) => (b.margin ?? -999) - (a.margin ?? -999))
    .slice(0, 12)
    .map((b) => ({ name: b.brand, margine: b.margin ?? 0 }));

  const topProduct = productList.find((p) => p.hasCost);
  const topBrand = brandList.find((b) => b.hasCost);

  const tableRows = sorted.map((p) => [
    p.title,
    p.vendor || "—",
    p.units.toString(),
    formatCurrency(p.revenue, currency),
    p.hasCost ? formatCurrency(p.totalCost, currency) : "—",
    p.hasCost ? <span key={p.id + "pr"} style={{ color: p.profit < 0 ? "#d82c0d" : undefined, fontWeight: p.profit < 0 ? 600 : undefined }}>{formatCurrency(p.profit, currency)}</span> : "—",
    <MarginBadge key={p.id} margin={p.margin} />,
  ]);

  const exportRows = sorted.map((p) => ({
    Prodotto: p.title,
    Brand: p.vendor || "",
    "Unità vendute": p.units,
    Fatturato: p.revenue.toFixed(2),
    "Costo totale": p.hasCost ? p.totalCost.toFixed(2) : "",
    Profitto: p.hasCost ? p.profit.toFixed(2) : "",
    "Margine %": p.margin !== null ? p.margin.toFixed(1) : "",
  }));

  return (
    <Page title="Margini">
      <TitleBar title="Margini" />
      <BlockStack gap="500">

        <InlineStack align="space-between" blockAlign="start" wrap>
          <DateRangePicker start={start} end={end} />
          <InlineStack gap="200">
            <Button size="slim" onClick={() => exportCSV(exportRows, `margini_${start}_${end}.csv`)}>CSV</Button>
            <Button size="slim" onClick={() => exportExcel(exportRows, `margini_${start}_${end}.xlsx`)}>Excel</Button>
          </InlineStack>
        </InlineStack>

        {noCostCount > 0 && (
          <Card>
            <Text as="p" variant="bodySm" tone="subdued">
              ⚠ {noCostCount} {noCostCount === 1 ? "prodotto senza" : "prodotti senza"} costo unitario in Shopify — esclusi dal calcolo del profitto.
            </Text>
          </Card>
        )}

        {/* KPI */}
        <Layout>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <span title="Fatturato totale meno costi dei prodotti venduti nel periodo. Richiede il costo unitario impostato in Shopify." style={{ cursor: "help" }}>
                <Text as="p" variant="bodySm" tone="subdued">Profitto totale periodo ⓘ</Text>
              </span>
              <Text as="p" variant="headingLg" fontWeight="bold">
                <span style={{ color: totalProfit >= 0 ? "#008060" : "#d82c0d" }}>{formatCurrency(totalProfit, currency)}</span>
              </Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <span title="(Fatturato - Costi) / Fatturato, pesato sul volume venduto. Verde ≥40%, giallo 20–40%, rosso <20%." style={{ cursor: "help" }}>
                <Text as="p" variant="bodySm" tone="subdued">Margine medio ponderato ⓘ</Text>
              </span>
              <Text as="p" variant="headingLg" fontWeight="bold">
                <span style={{ color: avgMargin === null ? undefined : avgMargin < 20 ? "#d82c0d" : avgMargin < 40 ? "#b98900" : "#008060" }}>
                  {avgMargin !== null ? avgMargin.toFixed(1) + "%" : "—"}
                </span>
              </Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <span title="Il prodotto con il maggior profitto assoluto nel periodo (non margine %)." style={{ cursor: "help" }}>
                <Text as="p" variant="bodySm" tone="subdued">Prodotto più redditizio ⓘ</Text>
              </span>
              <Text as="p" variant="headingMd" fontWeight="bold">{topProduct?.title || "—"}</Text>
              {topProduct && <Text as="p" variant="bodySm" tone="subdued">{formatCurrency(topProduct.profit, currency)}</Text>}
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <span title="Il brand con il maggior profitto assoluto nel periodo." style={{ cursor: "help" }}>
                <Text as="p" variant="bodySm" tone="subdued">Brand più redditizio ⓘ</Text>
              </span>
              <Text as="p" variant="headingMd" fontWeight="bold">{topBrand?.brand || "—"}</Text>
              {topBrand && <Text as="p" variant="bodySm" tone="subdued">{formatCurrency(topBrand.profit, currency)}</Text>}
            </BlockStack></Card>
          </Layout.Section>
        </Layout>

        {/* Grafici */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Top 15 prodotti per profitto</Text>
                {top15Revenue.length === 0 ? (
                  <Text as="p" tone="subdued">Nessun dato nel periodo.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={top15Revenue} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => `€${v.toFixed(0)}`} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={160} />
                      <Tooltip formatter={(v) => formatCurrency(v, currency)} />
                      <Bar dataKey="profitto" name="Profitto" fill="#008060" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Margine % per brand</Text>
                {brandChartData.length === 0 ? (
                  <Text as="p" tone="subdued">Nessun dato nel periodo.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={brandChartData} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toFixed(0)}%`} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={120} />
                      <Tooltip formatter={(v) => v.toFixed(1) + "%"} />
                      <ReferenceLine x={40} stroke="#008060" strokeDasharray="4 4" label={{ value: "Obiettivo 40%", position: "insideTopRight", fontSize: 10, fill: "#008060" }} />
                      <Bar dataKey="margine" name="Margine %" radius={[0, 3, 3, 0]}>
                        {brandChartData.map((b, i) => (
                          <Cell key={i} fill={b.margine >= 40 ? "#008060" : b.margine >= 20 ? "#FFB400" : "#E74C3C"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Riepilogo brand */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Riepilogo per brand</Text>
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
              headings={["Brand", "Unità", "Fatturato", "Profitto", "Margine %"]}
              rows={brandList.map((b) => [
                b.brand,
                b.units.toString(),
                formatCurrency(b.revenue, currency),
                b.hasCost ? formatCurrency(b.profit, currency) : "—",
                <MarginBadge key={b.brand} margin={b.margin} />,
              ])}
            />
          </BlockStack>
        </Card>

        {/* Tabella prodotti */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Dettaglio prodotti ({productList.length})</Text>
            {tableRows.length === 0 ? (
              <Text as="p" tone="subdued">Nessuna vendita nel periodo.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
                headings={["Prodotto", "Brand", "Unità", "Fatturato", "Costo tot.", "Profitto", "Margine %"]}
                rows={tableRows}
                sortable={[false, false, true, true, true, true, true]}
                defaultSortDirection="descending"
                initialSortColumnIndex={3}
                onSort={(col, dir) => { setSortCol(col); setSortDir(dir); }}
              />
            )}
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
