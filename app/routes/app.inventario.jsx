import { useLoaderData } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo, useEffect } from "react";
import {
  Page, Card, BlockStack, InlineStack, Text, Button, Badge,
  DataTable, Select, TextField,
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
        status: p.status || "ACTIVE",
        tags: p.tags || [],
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
  const allTags = [...new Set(variants.flatMap((v) => v.tags))].sort();

  return json({ variants, vendors, types, allTags });
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

function MarginCell({ margin }) {
  if (margin === null) return <span style={{ color: "#999" }}>—</span>;
  const color = margin < 20 ? "#d82c0d" : margin < 40 ? "#b98900" : "#008060";
  return <span style={{ color, fontWeight: 500 }}>{margin.toFixed(1)}%</span>;
}

const SORT_KEYS = [null, null, null, "vendor", "productType", "cost", "price", "margin", "qty", "stockValue", "salesValue"];

export default function Inventario() {
  const { variants, vendors, types, allTags } = useLoaderData();

  const [search, setSearch] = useState("");
  const [filterVendor, setFilterVendor] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterScorte, setFilterScorte] = useState("");  // scorte fisiche
  const [filterStatus, setFilterStatus] = useState("");  // stato pubblicazione
  const [filterTag, setFilterTag] = useState("");         // tag prodotto
  const [threshold, setThreshold] = useState("5");
  const [sortCol, setSortCol] = useState(9);
  const [sortDir, setSortDir] = useState("descending");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const thr = Math.max(1, parseInt(threshold) || 5);

  const filtered = useMemo(() => variants.filter((v) => {
    if (search) {
      const s = search.toLowerCase();
      if (!v.productTitle.toLowerCase().includes(s) && !v.sku.toLowerCase().includes(s)) return false;
    }
    if (filterVendor && v.vendor !== filterVendor) return false;
    if (filterType && v.productType !== filterType) return false;
    // Scorte fisiche (come Shopify: a magazzino / basso / esaurito)
    if (filterScorte === "in_stock" && v.qty <= 0) return false;
    if (filterScorte === "low" && (v.qty <= 0 || v.qty > thr)) return false;
    if (filterScorte === "out" && v.qty > 0) return false;
    // Stato pubblicazione (come Shopify: disponibile / bozza / non in elenco)
    if (filterStatus && v.status !== filterStatus) return false;
    // Tag prodotto
    if (filterTag && !v.tags.includes(filterTag)) return false;
    return true;
  }), [variants, search, filterVendor, filterType, filterScorte, filterStatus, filterTag, thr]);

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

  // Reset pagina al cambio filtri/sorting
  useEffect(() => setPage(0), [filtered, sortCol, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageData = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // KPI dinamici sul filtro
  const filteredTotalValue = useMemo(() => filtered.reduce((s, v) => s + v.stockValue, 0), [filtered]);
  const filteredSalesValue = useMemo(() => filtered.reduce((s, v) => s + v.salesValue, 0), [filtered]);
  const filteredTotalQty = useMemo(() => filtered.reduce((s, v) => s + v.qty, 0), [filtered]);
  const filteredOutOfStock = useMemo(() => filtered.filter((v) => v.qty <= 0).length, [filtered]);
  const filteredLowStock = useMemo(() => filtered.filter((v) => v.qty > 0 && v.qty <= thr).length, [filtered, thr]);
  const avgMargin = useMemo(() => {
    const withCost = filtered.filter((v) => v.margin !== null);
    if (!withCost.length) return null;
    return withCost.reduce((s, v) => s + v.margin, 0) / withCost.length;
  }, [filtered]);

  // Riepilogo per brand (sul filtro attivo)
  const brandSummary = useMemo(() => {
    const map = new Map();
    for (const v of filtered) {
      const key = v.vendor || "—";
      if (!map.has(key)) map.set(key, { brand: key, variants: 0, qty: 0, stockValue: 0, salesValue: 0, margins: [] });
      const b = map.get(key);
      b.variants++;
      b.qty += v.qty;
      b.stockValue += v.stockValue;
      b.salesValue += v.salesValue;
      if (v.margin !== null) b.margins.push(v.margin);
    }
    return Array.from(map.values())
      .map((b) => ({ ...b, avgMargin: b.margins.length > 0 ? b.margins.reduce((s, m) => s + m, 0) / b.margins.length : null }))
      .sort((a, b) => b.stockValue - a.stockValue);
  }, [filtered]);

  // Top 20 chart
  const topByValue = useMemo(() =>
    [...filtered]
      .sort((a, b) => b.stockValue - a.stockValue)
      .slice(0, 20)
      .map((v) => ({
        title: `${v.productTitle}${v.variantTitle !== "Default Title" ? ` · ${v.variantTitle}` : ""}`,
        value: v.stockValue,
      }))
  , [filtered]);

  const tableRows = pageData.map((v) => [
    <Text key={v.variantId} as="span" variant="bodySm">{v.productTitle}</Text>,
    v.variantTitle !== "Default Title" ? v.variantTitle : "—",
    v.sku || "—",
    v.vendor || "—",
    v.productType || "—",
    v.cost > 0 ? formatCurrency(v.cost) : "—",
    formatCurrency(v.price),
    <MarginCell key={v.variantId + "m"} margin={v.margin} />,
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
    "Costo unitario": v.cost > 0 ? v.cost.toFixed(2) : "",
    "Prezzo vendita": v.price.toFixed(2),
    "Margine %": v.margin !== null ? v.margin.toFixed(1) : "",
    Quantità: v.qty,
    "Valore magazzino (costo)": v.cost > 0 ? v.stockValue.toFixed(2) : "",
    "Valore a prezzo vendita": v.salesValue.toFixed(2),
  }));

  const brandExportRows = brandSummary.map((b) => ({
    Brand: b.brand,
    "N. varianti": b.variants,
    "Pezzi totali": b.qty,
    "Valore costo": b.stockValue.toFixed(2),
    "Valore vendita": b.salesValue.toFixed(2),
    "Margine medio %": b.avgMargin !== null ? b.avgMargin.toFixed(1) : "",
  }));

  const vendorOptions = [{ label: "Tutti i brand", value: "" }, ...vendors.map((v) => ({ label: v, value: v }))];
  const typeOptions = [{ label: "Tutti i tipi", value: "" }, ...types.map((t) => ({ label: t, value: t }))];
  const tagOptions = [{ label: "Tutti i tag", value: "" }, ...allTags.map((t) => ({ label: t, value: t }))];
  const scorteOptions = [
    { label: "Tutte le scorte", value: "" },
    { label: "A magazzino (disponibile)", value: "in_stock" },
    { label: `Scorte basse (1–${thr} pz)`, value: "low" },
    { label: "Esaurito (0 pz)", value: "out" },
  ];
  const statusOptions = [
    { label: "Tutti gli stati", value: "" },
    { label: "Disponibile", value: "ACTIVE" },
    { label: "Bozza", value: "DRAFT" },
    { label: "Non in elenco", value: "ARCHIVED" },
  ];

  const isFiltered = filtered.length < variants.length;

  return (
    <Page title="Inventario">
      <TitleBar title="Inventario" />
      <BlockStack gap="500">

        {/* ── HEADER ── */}
        <InlineStack align="space-between" blockAlign="center" wrap>
          <InlineStack gap="200">
            <Button size="slim" onClick={() => exportCSV(exportRows, "inventario.csv")}>CSV varianti</Button>
            <Button size="slim" onClick={() => exportExcel(exportRows, "inventario.xlsx")}>Excel varianti</Button>
            <Button size="slim" onClick={() => exportCSV(brandExportRows, "inventario_per_brand.csv")}>CSV per brand</Button>
            <Button size="slim" onClick={() => window.print()}>Stampa / PDF</Button>
          </InlineStack>
        </InlineStack>

        {/* ── FILTRI (sopra i KPI) ── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Filtri</Text>
              {isFiltered && (
                <Button size="slim" plain onClick={() => {
                  setSearch(""); setFilterVendor(""); setFilterType("");
                  setFilterScorte(""); setFilterStatus(""); setFilterTag("");
                }}>
                  Azzera filtri
                </Button>
              )}
            </InlineStack>
            <InlineStack gap="200" wrap>
              <div style={{ minWidth: 220 }}>
                <TextField
                  label="Cerca" placeholder="Prodotto / SKU..."
                  value={search} onChange={setSearch} autoComplete="off"
                />
              </div>
              <div style={{ minWidth: 180 }}>
                <Select label="Brand" options={vendorOptions} value={filterVendor} onChange={setFilterVendor} />
              </div>
              <div style={{ minWidth: 180 }}>
                <Select label="Tipo prodotto" options={typeOptions} value={filterType} onChange={setFilterType} />
              </div>
              <div style={{ minWidth: 200 }}>
                <Select label="Scorte" options={scorteOptions} value={filterScorte} onChange={setFilterScorte} />
              </div>
              <div style={{ minWidth: 180 }}>
                <Select label="Stato" options={statusOptions} value={filterStatus} onChange={setFilterStatus} />
              </div>
              <div style={{ minWidth: 180 }}>
                <Select label="Tag" options={tagOptions} value={filterTag} onChange={setFilterTag} />
              </div>
              <div style={{ minWidth: 120 }}>
                <TextField
                  label="Soglia scorte basse" type="number" value={threshold}
                  onChange={setThreshold} autoComplete="off" min={1}
                  helpText={`≤ ${thr} pz = basso`}
                />
              </div>
            </InlineStack>
            {isFiltered && (
              <Text as="p" variant="bodySm" tone="subdued">
                {filtered.length} varianti su {variants.length} totali
              </Text>
            )}
          </BlockStack>
        </Card>

        {/* ── KPI DINAMICI ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          {[
            { label: `Pezzi in stock${isFiltered ? " — filtrato" : ""}`, value: filteredTotalQty.toLocaleString("it-IT") },
            { label: `Valore magazzino (costo)${isFiltered ? " — filtrato" : ""}`, value: formatCurrency(filteredTotalValue) },
            { label: `Valore a prezzo vendita${isFiltered ? " — filtrato" : ""}`, value: formatCurrency(filteredSalesValue) },
            {
              label: "Margine medio (su filtro)",
              value: avgMargin !== null ? avgMargin.toFixed(1) + "%" : "—",
              color: avgMargin !== null ? (avgMargin < 20 ? "#d82c0d" : avgMargin < 40 ? "#b98900" : "#008060") : undefined,
            },
            {
              label: `Esauriti / Bassi (≤${thr})`,
              value: `${filteredOutOfStock} / ${filteredLowStock}`,
              color: filteredOutOfStock > 0 ? "#d82c0d" : filteredLowStock > 0 ? "#b98900" : undefined,
            },
          ].map(({ label, value, color }) => (
            <Card key={label}>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                <Text as="p" variant="headingLg" fontWeight="bold">
                  <span style={color ? { color } : {}}>{value}</span>
                </Text>
              </BlockStack>
            </Card>
          ))}
        </div>

        {/* ── RIEPILOGO PER BRAND ── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Riepilogo per brand{isFiltered ? " — filtrato" : ""}
              </Text>
              <Button size="slim" plain onClick={() => exportCSV(brandExportRows, "inventario_per_brand.csv")}>
                Esporta CSV
              </Button>
            </InlineStack>
            {brandSummary.length === 0 ? (
              <Text as="p" tone="subdued">Nessun dato.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
                headings={["Brand", "Varianti", "Pezzi totali", "Valore costo", "Valore vendita", "Margine medio"]}
                rows={brandSummary.map((b) => [
                  <Button key={b.brand} size="slim" plain onClick={() => setFilterVendor(b.brand === "—" ? "" : b.brand)}>
                    {b.brand}
                  </Button>,
                  b.variants.toString(),
                  b.qty.toLocaleString("it-IT"),
                  b.stockValue > 0 ? formatCurrency(b.stockValue) : "—",
                  formatCurrency(b.salesValue),
                  b.avgMargin !== null ? (
                    <MarginCell key={b.brand + "m"} margin={b.avgMargin} />
                  ) : "—",
                ])}
              />
            )}
          </BlockStack>
        </Card>

        {/* ── GRAFICO TOP 20 ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Top 20 varianti per valore magazzino{isFiltered ? " — filtrato" : ""}</Text>
            {topByValue.length === 0 ? (
              <Text as="p" tone="subdued">Nessun dato (aggiungi il costo unitario ai prodotti in Shopify).</Text>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={topByValue} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => `€${v.toFixed(0)}`} />
                  <YAxis type="category" dataKey="title" tick={{ fontSize: 9 }} width={220} />
                  <Tooltip formatter={(v) => formatCurrency(v)} />
                  <Bar dataKey="value" name="Valore mag." fill="#9B59B6" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </BlockStack>
        </Card>

        {/* ── TABELLA VARIANTI ── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">
                Varianti ({filtered.length}{isFiltered ? ` su ${variants.length}` : ""})
              </Text>
              {totalPages > 1 && (
                <InlineStack gap="200" blockAlign="center">
                  <Button size="slim" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prec.</Button>
                  <Text as="span" variant="bodySm">
                    Pagina {page + 1} di {totalPages} ({PAGE_SIZE * page + 1}–{Math.min(PAGE_SIZE * (page + 1), sorted.length)} di {sorted.length})
                  </Text>
                  <Button size="slim" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Succ. →</Button>
                </InlineStack>
              )}
            </InlineStack>
            {tableRows.length === 0 ? (
              <Text as="p" tone="subdued">Nessuna variante trovata con i filtri selezionati.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text","text","text","text","text","numeric","numeric","numeric","text","numeric","numeric"]}
                headings={["Prodotto","Variante","SKU","Brand","Tipo","Costo unitario","Prezzo vendita","Margine %","Stock","Val. magazzino","Val. vendita"]}
                rows={tableRows}
                sortable={[false, false, false, true, true, true, true, true, true, true, true]}
                defaultSortDirection="descending"
                initialSortColumnIndex={9}
                onSort={(col, dir) => { setSortCol(col); setSortDir(dir); }}
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
