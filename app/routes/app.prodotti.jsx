import { useLoaderData, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Badge,
  DataTable, Select, Thumbnail,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchProducts, fetchOrders, topProductsByRevenue } from "../utils/shopify.server";
import { formatCurrency, daysAgo } from "../utils/format";

const COLORS = ["#008060","#1E90FF","#FFB400","#FF4D4D","#9B59B6","#2ECC71","#E67E22","#1ABC9C"];

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const start = url.searchParams.get("start") || daysAgo(30);
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);

  const [products, orders] = await Promise.all([
    fetchProducts(admin),
    fetchOrders(admin, { startDate: start, endDate: end }),
  ]);

  const topByRevenue = topProductsByRevenue(orders, 20);
  const topByUnits = [...topByRevenue].sort((a, b) => b.units - a.units).slice(0, 20);

  // Distribuzione per brand
  const brandMap = new Map();
  for (const p of products) {
    const v = p.vendor || "Senza brand";
    brandMap.set(v, (brandMap.get(v) || 0) + 1);
  }
  const byBrand = Array.from(brandMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  // Vendors list
  const vendors = [...new Set(products.map((p) => p.vendor).filter(Boolean))].sort();
  const types = [...new Set(products.map((p) => p.productType).filter(Boolean))].sort();

  return json({ products, topByRevenue, topByUnits, byBrand, vendors, types, start, end });
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
    XLSX.utils.book_append_sheet(wb, ws, "Prodotti");
    XLSX.writeFile(wb, filename);
  });
}

export default function Prodotti() {
  const { products, topByRevenue, topByUnits, byBrand, vendors, types, start, end } = useLoaderData();
  const [filterVendor, setFilterVendor] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  const filtered = useMemo(() => products.filter((p) => {
    if (filterVendor && p.vendor !== filterVendor) return false;
    if (filterType && p.productType !== filterType) return false;
    if (filterStatus && p.status !== filterStatus) return false;
    return true;
  }), [products, filterVendor, filterType, filterStatus]);

  const totalInventory = products.reduce((s, p) => s + (p.totalInventory || 0), 0);
  const activeProducts = products.filter((p) => p.status === "ACTIVE").length;

  const tableRows = filtered.map((p) => {
    const totalQty = p.variants.edges.reduce((s, e) => s + (e.node.inventoryQuantity || 0), 0);
    const avgPrice = p.variants.edges.length > 0
      ? p.variants.edges.reduce((s, e) => s + parseFloat(e.node.price), 0) / p.variants.edges.length
      : 0;
    const soldData = topByRevenue.find((t) => t.id === p.id);
    return [
      <InlineStack key={p.id} gap="200" blockAlign="center">
        {p.featuredImage?.url && <Thumbnail source={p.featuredImage.url} size="small" alt={p.title} />}
        <Text as="span" variant="bodySm">{p.title}</Text>
      </InlineStack>,
      p.vendor || "—",
      p.productType || "—",
      <Badge key={p.id + "s"} tone={p.status === "ACTIVE" ? "success" : p.status === "DRAFT" ? "attention" : "critical"}>
        {p.status === "ACTIVE" ? "Attivo" : p.status === "DRAFT" ? "Bozza" : "Archiviato"}
      </Badge>,
      p.variants.edges.length.toString(),
      totalQty.toString(),
      formatCurrency(avgPrice),
      soldData ? soldData.units.toString() : "0",
      soldData ? formatCurrency(soldData.revenue) : "€0",
    ];
  });

  const exportRows = filtered.map((p) => {
    const totalQty = p.variants.edges.reduce((s, e) => s + (e.node.inventoryQuantity || 0), 0);
    const soldData = topByRevenue.find((t) => t.id === p.id);
    return {
      Prodotto: p.title,
      Brand: p.vendor || "",
      Tipo: p.productType || "",
      Status: p.status,
      Varianti: p.variants.edges.length,
      "Stock totale": totalQty,
      "Unità vendute": soldData?.units || 0,
      "Fatturato": soldData ? soldData.revenue.toFixed(2) : "0",
    };
  });

  const vendorOptions = [{ label: "Tutti i brand", value: "" }, ...vendors.map((v) => ({ label: v, value: v }))];
  const typeOptions = [{ label: "Tutti i tipi", value: "" }, ...types.map((t) => ({ label: t, value: t }))];
  const statusOptions = [
    { label: "Tutti gli stati", value: "" },
    { label: "Attivo", value: "ACTIVE" },
    { label: "Bozza", value: "DRAFT" },
    { label: "Archiviato", value: "ARCHIVED" },
  ];

  return (
    <Page title="Prodotti">
      <TitleBar title="Prodotti" />
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <InlineStack gap="200">
            <Text as="span" variant="bodySm" tone="subdued">Vendite: {start} — {end}</Text>
          </InlineStack>
          <InlineStack gap="200">
            <Button size="slim" onClick={() => exportCSV(exportRows, `prodotti_${start}_${end}.csv`)}>CSV</Button>
            <Button size="slim" onClick={() => exportExcel(exportRows, `prodotti_${start}_${end}.xlsx`)}>Excel</Button>
          </InlineStack>
        </InlineStack>

        {/* KPI */}
        <Layout>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Prodotti totali</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{products.length}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Prodotti attivi</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{activeProducts}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Stock totale</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{totalInventory.toLocaleString("it-IT")}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Brand distinti</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{vendors.length}</Text>
            </BlockStack></Card>
          </Layout.Section>
        </Layout>

        {/* Grafici */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Top 20 prodotti per fatturato</Text>
                {topByRevenue.length === 0 ? (
                  <Text as="p" tone="subdued">Nessuna vendita nel periodo.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={topByRevenue.slice(0, 20)} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => `€${v.toFixed(0)}`} />
                      <YAxis type="category" dataKey="title" tick={{ fontSize: 10 }} width={140} />
                      <Tooltip formatter={(v) => formatCurrency(v)} />
                      <Bar dataKey="revenue" name="Fatturato" fill="#FFB400" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Top 20 per unità vendute</Text>
                {topByUnits.length === 0 ? (
                  <Text as="p" tone="subdued">Nessuna vendita nel periodo.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={topByUnits.slice(0, 20)} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                      <YAxis type="category" dataKey="title" tick={{ fontSize: 10 }} width={140} />
                      <Tooltip />
                      <Bar dataKey="units" name="Unità" fill="#008060" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Distribuzione brand */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Distribuzione per brand</Text>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={byBrand} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80}
                      label={({ name, percent }) => percent > 0.05 ? `${(percent * 100).toFixed(0)}%` : ""}
                      labelLine={false}>
                      {byBrand.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                {byBrand.slice(0, 5).map((b, i) => (
                  <InlineStack key={i} gap="200" blockAlign="center">
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                    <Text as="span" variant="bodySm">{b.name}: {b.value}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Tabella prodotti */}
          <Layout.Section variant="twoThirds">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">Tutti i prodotti ({filtered.length})</Text>
                  <InlineStack gap="200" wrap>
                    <div style={{ minWidth: 150 }}>
                      <Select label="" labelHidden options={vendorOptions} value={filterVendor} onChange={setFilterVendor} />
                    </div>
                    <div style={{ minWidth: 150 }}>
                      <Select label="" labelHidden options={typeOptions} value={filterType} onChange={setFilterType} />
                    </div>
                    <div style={{ minWidth: 130 }}>
                      <Select label="" labelHidden options={statusOptions} value={filterStatus} onChange={setFilterStatus} />
                    </div>
                  </InlineStack>
                </InlineStack>
                {tableRows.length === 0 ? (
                  <Text as="p" tone="subdued">Nessun prodotto trovato.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text","text","text","text","numeric","numeric","numeric","numeric","numeric"]}
                    headings={["Prodotto","Brand","Tipo","Status","Varianti","Stock","Prezzo medio","Venduto","Fatturato"]}
                    rows={tableRows}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
