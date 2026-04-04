import { useLoaderData } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Badge,
  DataTable, Select, Thumbnail,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchProducts, formatCurrency } from "../utils/shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const products = await fetchProducts(admin);

  // Appiattisce varianti
  const variants = [];
  for (const p of products) {
    for (const edge of p.variants.edges) {
      const v = edge.node;
      const cost = parseFloat(v.inventoryItem?.unitCost?.amount || 0);
      const qty = v.inventoryQuantity || 0;
      const price = parseFloat(v.price || 0);
      variants.push({
        productId: p.id,
        productTitle: p.title,
        vendor: p.vendor || "",
        productType: p.productType || "",
        imageUrl: p.featuredImage?.url || null,
        variantId: v.id,
        variantTitle: v.title,
        sku: v.sku || "",
        price,
        cost,
        qty,
        stockValue: cost * qty,
        salesValue: price * qty,
      });
    }
  }

  const vendors = [...new Set(variants.map((v) => v.vendor).filter(Boolean))].sort();
  const totalValue = variants.reduce((s, v) => s + v.stockValue, 0);
  const totalSalesValue = variants.reduce((s, v) => s + v.salesValue, 0);
  const outOfStock = variants.filter((v) => v.qty <= 0).length;
  const lowStock = variants.filter((v) => v.qty > 0 && v.qty <= 5).length;

  // Top 20 per valore magazzino
  const topByValue = [...variants]
    .sort((a, b) => b.stockValue - a.stockValue)
    .slice(0, 20)
    .map((v) => ({ title: `${v.productTitle}${v.variantTitle !== "Default Title" ? ` (${v.variantTitle})` : ""}`, value: v.stockValue }));

  return json({ variants, vendors, totalValue, totalSalesValue, outOfStock, lowStock, topByValue });
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
    XLSX.utils.book_append_sheet(wb, ws, "Inventario");
    XLSX.writeFile(wb, filename);
  });
}

function StockBadge({ qty }) {
  if (qty <= 0) return <Badge tone="critical">Esaurito</Badge>;
  if (qty <= 5) return <Badge tone="warning">Basso ({qty})</Badge>;
  return <Badge tone="success">{qty}</Badge>;
}

export default function Inventario() {
  const { variants, vendors, totalValue, totalSalesValue, outOfStock, lowStock, topByValue } = useLoaderData();
  const [filterVendor, setFilterVendor] = useState("");
  const [filterStock, setFilterStock] = useState("");

  const filtered = useMemo(() => variants.filter((v) => {
    if (filterVendor && v.vendor !== filterVendor) return false;
    if (filterStock === "out" && v.qty > 0) return false;
    if (filterStock === "low" && (v.qty <= 0 || v.qty > 5)) return false;
    if (filterStock === "ok" && v.qty <= 5) return false;
    return true;
  }), [variants, filterVendor, filterStock]);

  const tableRows = filtered.slice(0, 500).map((v) => [
    <InlineStack key={v.variantId} gap="200" blockAlign="center">
      {v.imageUrl && <Thumbnail source={v.imageUrl} size="small" alt={v.productTitle} />}
      <Text as="span" variant="bodySm">{v.productTitle}</Text>
    </InlineStack>,
    v.variantTitle !== "Default Title" ? v.variantTitle : "—",
    v.sku || "—",
    v.vendor || "—",
    formatCurrency(v.price),
    v.cost > 0 ? formatCurrency(v.cost) : "—",
    <StockBadge key={v.variantId + "s"} qty={v.qty} />,
    v.cost > 0 ? formatCurrency(v.stockValue) : "—",
    formatCurrency(v.salesValue),
  ]);

  const exportRows = filtered.map((v) => ({
    Prodotto: v.productTitle,
    Variante: v.variantTitle !== "Default Title" ? v.variantTitle : "",
    SKU: v.sku,
    Brand: v.vendor,
    "Prezzo vendita": v.price.toFixed(2),
    "Costo unitario": v.cost > 0 ? v.cost.toFixed(2) : "",
    Quantità: v.qty,
    "Valore magazzino": v.cost > 0 ? v.stockValue.toFixed(2) : "",
    "Valore a prezzo vendita": v.salesValue.toFixed(2),
  }));

  const vendorOptions = [{ label: "Tutti i brand", value: "" }, ...vendors.map((v) => ({ label: v, value: v }))];
  const stockOptions = [
    { label: "Tutto lo stock", value: "" },
    { label: "Disponibile (>5)", value: "ok" },
    { label: "Basso (1-5)", value: "low" },
    { label: "Esaurito (0)", value: "out" },
  ];

  return (
    <Page title="Inventario">
      <TitleBar title="Inventario" />
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text as="h1" variant="headingLg">Inventario magazzino</Text>
          <InlineStack gap="200">
            <Button size="slim" onClick={() => exportCSV(exportRows, "inventario.csv")}>CSV</Button>
            <Button size="slim" onClick={() => exportExcel(exportRows, "inventario.xlsx")}>Excel</Button>
            <Button size="slim" onClick={() => window.print()}>Stampa</Button>
          </InlineStack>
        </InlineStack>

        {/* KPI */}
        <Layout>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Valore magazzino (costo)</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(totalValue)}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Valore a prezzo vendita</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(totalSalesValue)}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Varianti esaurite</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">
                <span style={{ color: outOfStock > 0 ? "#d82c0d" : "inherit" }}>{outOfStock}</span>
              </Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Stock basso (≤5)</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">
                <span style={{ color: lowStock > 0 ? "#b98900" : "inherit" }}>{lowStock}</span>
              </Text>
            </BlockStack></Card>
          </Layout.Section>
        </Layout>

        {/* Grafico top 20 per valore */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Top 20 varianti per valore magazzino</Text>
            {topByValue.length === 0 ? (
              <Text as="p" tone="subdued">Nessun dato disponibile (aggiungi il costo unitario ai prodotti).</Text>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={topByValue} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => `€${v.toFixed(0)}`} />
                  <YAxis type="category" dataKey="title" tick={{ fontSize: 10 }} width={180} />
                  <Tooltip formatter={(v) => formatCurrency(v)} />
                  <Bar dataKey="value" name="Valore" fill="#9B59B6" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </BlockStack>
        </Card>

        {/* Tabella */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">
                Varianti ({filtered.length}{filtered.length > 500 ? ", mostrando 500" : ""})
              </Text>
              <InlineStack gap="200" wrap>
                <div style={{ minWidth: 180 }}>
                  <Select label="" labelHidden options={vendorOptions} value={filterVendor} onChange={setFilterVendor} />
                </div>
                <div style={{ minWidth: 160 }}>
                  <Select label="" labelHidden options={stockOptions} value={filterStock} onChange={setFilterStock} />
                </div>
              </InlineStack>
            </InlineStack>
            {tableRows.length === 0 ? (
              <Text as="p" tone="subdued">Nessuna variante trovata.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text","text","text","text","numeric","numeric","text","numeric","numeric"]}
                headings={["Prodotto","Variante","SKU","Brand","Prezzo","Costo","Stock","Valore magazzino","Valore vendita"]}
                rows={tableRows}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
