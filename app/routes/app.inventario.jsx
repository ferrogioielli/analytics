import { useLoaderData } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Badge,
  DataTable, Select, Thumbnail, TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchProducts } from "../utils/shopify.server";
import { formatCurrency } from "../utils/format";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const products = await fetchProducts(admin);

  const variants = [];
  for (const p of products) {
    for (const edge of p.variants.edges) {
      const v = edge.node;
      const cost = parseFloat(v.inventoryItem?.unitCost?.amount || 0);
      const qty = v.inventoryQuantity || 0;
      const price = parseFloat(v.price || 0);
      const margin = cost > 0 && price > 0 ? ((price - cost) / price) * 100 : null;
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
        margin,
        stockValue: cost * qty,
        salesValue: price * qty,
      });
    }
  }

  const vendors = [...new Set(variants.map((v) => v.vendor).filter(Boolean))].sort();
  const types = [...new Set(variants.map((v) => v.productType).filter(Boolean))].sort();

  return json({ variants, vendors, types });
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

function StockBadge({ qty, threshold }) {
  if (qty <= 0) return <Badge tone="critical">Esaurito</Badge>;
  if (qty <= threshold) return <Badge tone="warning">Basso ({qty})</Badge>;
  return <Badge tone="success">{qty}</Badge>;
}

// Colonne: Prodotto, Variante, SKU, Brand, Tipo, Prezzo, Costo, Margine%, Stock, Val.mag, Val.vend
const SORT_KEYS = [null, null, null, "vendor", "productType", "price", "cost", "margin", "qty", "stockValue", "salesValue"];

export default function Inventario() {
  const { variants, vendors, types } = useLoaderData();

  const [search, setSearch] = useState("");
  const [filterVendor, setFilterVendor] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStock, setFilterStock] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [threshold, setThreshold] = useState("5");
  const [sortCol, setSortCol] = useState(9);
  const [sortDir, setSortDir] = useState("descending");

  const thr = Math.max(1, parseInt(threshold) || 5);

  const filtered = useMemo(() => variants.filter((v) => {
    if (search) {
      const s = search.toLowerCase();
      if (!v.productTitle.toLowerCase().includes(s) && !v.sku.toLowerCase().includes(s)) return false;
    }
    if (filterVendor && v.vendor !== filterVendor) return false;
    if (filterType && v.productType !== filterType) return false;
    if (filterStock === "out" && v.qty > 0) return false;
    if (filterStock === "low" && (v.qty <= 0 || v.qty > thr)) return false;
    if (filterStock === "ok" && v.qty <= thr) return false;
    if (minPrice !== "" && v.price < parseFloat(minPrice)) return false;
    if (maxPrice !== "" && v.price > parseFloat(maxPrice)) return false;
    return true;
  }), [variants, search, filterVendor, filterType, filterStock, minPrice, maxPrice, thr]);

  const sorted = useMemo(() => {
    const key = SORT_KEYS[sortCol];
    if (!key) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[key] ?? -Infinity;
      const bv = b[key] ?? -Infinity;
      const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
      return sortDir === "ascending" ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir]);

  const filteredTotalValue = useMemo(() => filtered.reduce((s, v) => s + v.stockValue, 0), [filtered]);
  const filteredSalesValue = useMemo(() => filtered.reduce((s, v) => s + v.salesValue, 0), [filtered]);
  const filteredOutOfStock = useMemo(() => filtered.filter((v) => v.qty <= 0).length, [filtered]);
  const filteredLowStock = useMemo(() => filtered.filter((v) => v.qty > 0 && v.qty <= thr).length, [filtered, thr]);

  const avgMargin = useMemo(() => {
    const withCost = filtered.filter((v) => v.margin !== null);
    if (!withCost.length) return null;
    return withCost.reduce((s, v) => s + v.margin, 0) / withCost.length;
  }, [filtered]);

  const topByValue = useMemo(() =>
    [...filtered]
      .sort((a, b) => b.stockValue - a.stockValue)
      .slice(0, 20)
      .map((v) => ({
        title: `${v.productTitle}${v.variantTitle !== "Default Title" ? ` (${v.variantTitle})` : ""}`,
        value: v.stockValue,
      }))
  , [filtered]);

  const tableRows = sorted.slice(0, 500).map((v) => [
    <InlineStack key={v.variantId} gap="200" blockAlign="center">
      {v.imageUrl && <Thumbnail source={v.imageUrl} size="small" alt={v.productTitle} />}
      <Text as="span" variant="bodySm">{v.productTitle}</Text>
    </InlineStack>,
    v.variantTitle !== "Default Title" ? v.variantTitle : "—",
    v.sku || "—",
    v.vendor || "—",
    v.productType || "—",
    formatCurrency(v.price),
    v.cost > 0 ? formatCurrency(v.cost) : "—",
    v.margin !== null ? (
      <span style={{ color: v.margin < 20 ? "#d82c0d" : v.margin < 40 ? "#b98900" : "#008060", fontWeight: 500 }}>
        {v.margin.toFixed(1)}%
      </span>
    ) : "—",
    <StockBadge key={v.variantId + "s"} qty={v.qty} threshold={thr} />,
    v.cost > 0 ? formatCurrency(v.stockValue) : "—",
    formatCurrency(v.salesValue),
  ]);

  const exportRows = sorted.map((v) => ({
    Prodotto: v.productTitle,
    Variante: v.variantTitle !== "Default Title" ? v.variantTitle : "",
    SKU: v.sku,
    Brand: v.vendor,
    Tipo: v.productType,
    "Prezzo vendita": v.price.toFixed(2),
    "Costo unitario": v.cost > 0 ? v.cost.toFixed(2) : "",
    "Margine %": v.margin !== null ? v.margin.toFixed(1) : "",
    Quantità: v.qty,
    "Valore magazzino": v.cost > 0 ? v.stockValue.toFixed(2) : "",
    "Valore a prezzo vendita": v.salesValue.toFixed(2),
  }));

  const vendorOptions = [{ label: "Tutti i brand", value: "" }, ...vendors.map((v) => ({ label: v, value: v }))];
  const typeOptions = [{ label: "Tutti i tipi", value: "" }, ...types.map((t) => ({ label: t, value: t }))];
  const stockOptions = [
    { label: "Tutto lo stock", value: "" },
    { label: `Disponibile (>${thr})`, value: "ok" },
    { label: `Basso (1-${thr})`, value: "low" },
    { label: "Esaurito (0)", value: "out" },
  ];

  const isFiltered = filtered.length < variants.length;

  return (
    <Page title="Inventario">
      <TitleBar title="Inventario" />
      <BlockStack gap="500">

        {/* Header */}
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text as="h1" variant="headingLg">Inventario magazzino</Text>
          <InlineStack gap="200">
            <Button size="slim" onClick={() => exportCSV(exportRows, "inventario.csv")}>CSV</Button>
            <Button size="slim" onClick={() => exportExcel(exportRows, "inventario.xlsx")}>Excel</Button>
            <Button size="slim" onClick={() => window.print()}>Stampa / PDF</Button>
          </InlineStack>
        </InlineStack>

        {/* KPI — dinamici sul filtro attivo */}
        <Layout>
          <Layout.Section variant="oneQuarter">
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">Valore magazzino (costo){isFiltered ? " — filtrato" : ""}</Text>
                <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(filteredTotalValue)}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">Valore a prezzo vendita{isFiltered ? " — filtrato" : ""}</Text>
                <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(filteredSalesValue)}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">Margine medio (su filtro)</Text>
                <Text as="p" variant="headingLg" fontWeight="bold">
                  {avgMargin !== null ? (
                    <span style={{ color: avgMargin < 20 ? "#d82c0d" : avgMargin < 40 ? "#b98900" : "#008060" }}>
                      {avgMargin.toFixed(1)}%
                    </span>
                  ) : "—"}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">Esauriti / Bassi (≤{thr})</Text>
                <Text as="p" variant="headingLg" fontWeight="bold">
                  <span style={{ color: filteredOutOfStock > 0 ? "#d82c0d" : "inherit" }}>{filteredOutOfStock}</span>
                  {" / "}
                  <span style={{ color: filteredLowStock > 0 ? "#b98900" : "inherit" }}>{filteredLowStock}</span>
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Grafico top 20 per valore (filtrato) */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Top 20 varianti per valore magazzino{isFiltered ? " (filtrato)" : ""}</Text>
            {topByValue.length === 0 ? (
              <Text as="p" tone="subdued">Nessun dato disponibile (aggiungi il costo unitario ai prodotti).</Text>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={topByValue} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => `€${v.toFixed(0)}`} />
                  <YAxis type="category" dataKey="title" tick={{ fontSize: 10 }} width={200} />
                  <Tooltip formatter={(v) => formatCurrency(v)} />
                  <Bar dataKey="value" name="Valore mag." fill="#9B59B6" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </BlockStack>
        </Card>

        {/* Filtri + Tabella */}
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <Text as="h2" variant="headingMd">
                  Varianti ({filtered.length}{filtered.length > 500 ? " — mostrando 500" : ""}{isFiltered ? ` su ${variants.length}` : ""})
                </Text>
                <Button size="slim" plain onClick={() => {
                  setSearch(""); setFilterVendor(""); setFilterType("");
                  setFilterStock(""); setMinPrice(""); setMaxPrice("");
                }}>
                  Azzera filtri
                </Button>
              </InlineStack>

              {/* Filtri riga 1 */}
              <InlineStack gap="200" wrap>
                <div style={{ minWidth: 220 }}>
                  <TextField
                    label="" labelHidden placeholder="Cerca prodotto / SKU..."
                    value={search} onChange={setSearch} autoComplete="off"
                  />
                </div>
                <div style={{ minWidth: 170 }}>
                  <Select label="" labelHidden options={vendorOptions} value={filterVendor} onChange={setFilterVendor} />
                </div>
                <div style={{ minWidth: 170 }}>
                  <Select label="" labelHidden options={typeOptions} value={filterType} onChange={setFilterType} />
                </div>
                <div style={{ minWidth: 160 }}>
                  <Select label="" labelHidden options={stockOptions} value={filterStock} onChange={setFilterStock} />
                </div>
              </InlineStack>

              {/* Filtri riga 2 */}
              <InlineStack gap="200" wrap blockAlign="end">
                <div style={{ minWidth: 130 }}>
                  <TextField
                    label="Prezzo min (€)" type="number" value={minPrice}
                    onChange={setMinPrice} autoComplete="off" min={0}
                  />
                </div>
                <div style={{ minWidth: 130 }}>
                  <TextField
                    label="Prezzo max (€)" type="number" value={maxPrice}
                    onChange={setMaxPrice} autoComplete="off" min={0}
                  />
                </div>
                <div style={{ minWidth: 130 }}>
                  <TextField
                    label="Soglia stock basso" type="number" value={threshold}
                    onChange={setThreshold} autoComplete="off" min={1}
                    helpText="Soglia per avviso"
                  />
                </div>
              </InlineStack>
            </BlockStack>

            {tableRows.length === 0 ? (
              <Text as="p" tone="subdued">Nessuna variante trovata con i filtri selezionati.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text","text","text","text","text","numeric","numeric","numeric","text","numeric","numeric"]}
                headings={["Prodotto","Variante","SKU","Brand","Tipo","Prezzo","Costo","Margine %","Stock","Valore mag.","Valore vend."]}
                rows={tableRows}
                sortable={[false, false, false, true, true, true, true, true, true, true, true]}
                defaultSortDirection="descending"
                initialSortColumnIndex={9}
                onSort={(col, dir) => { setSortCol(col); setSortDir(dir); }}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
