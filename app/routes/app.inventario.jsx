import { useLoaderData, useNavigate, Await } from "@remix-run/react";
import { defer } from "@remix-run/node";
import { useState, useMemo, useEffect, useCallback, Suspense } from "react";
import {
  Page, Card, BlockStack, InlineStack, Text, Button, Badge,
  DataTable, Select, TextField, Popover, OptionList,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchProducts, fetchInventorySnapshot } from "../utils/shopify.server";
import { formatCurrency } from "../utils/format";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const snapshotDate = url.searchParams.get("snapshot") || null;

  const dataPromise = (async () => {
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

    return { variants, vendors, types, allTags };
  })();

  // Snapshot storico: se richiesto, lancia in parallelo (con error handling)
  const snapshotPromise = snapshotDate
    ? fetchInventorySnapshot(admin, snapshotDate).catch((err) => {
        console.error("Snapshot error:", err);
        return { error: err.message || "Errore nel recupero dati storici" };
      })
    : Promise.resolve(null);

  return defer({ data: dataPromise, snapshot: snapshotPromise, snapshotDate });
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

function MultiSelect({ label, allLabel, options, selected, onChange, allValues }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const isAll = selected.length === allValues.length;

  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodySm">{label}</Text>
      <Popover
        active={open}
        activator={
          <Button size="slim" disclosure onClick={toggle} fullWidth textAlign="left">
            {isAll ? allLabel : `${selected.length} / ${allValues.length} selezionati`}
          </Button>
        }
        onClose={() => setOpen(false)}
        preferredAlignment="left"
      >
        <div style={{ minWidth: 220 }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #e1e3e5" }}>
            <Button
              size="slim"
              plain
              onClick={() => onChange(isAll ? [] : [...allValues])}
            >
              {isAll ? "Deseleziona tutti" : "Seleziona tutti"}
            </Button>
          </div>
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            <OptionList
              options={options}
              selected={selected}
              onChange={onChange}
              allowMultiple
            />
          </div>
        </div>
      </Popover>
    </BlockStack>
  );
}

const SORT_KEYS = [null, null, "vendor", "productType", "margin", "qty", "stockValue", "salesValue"];

// ─── LOADING SKELETON ─────────────────────────────────────────────────────────
function LoadingSkeleton() {
  const box = (w, h) => ({ width: w, height: h, background: "#f0f0f0", borderRadius: 6, animation: "pulse 1.5s infinite" });
  return (
    <>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
      {/* Filters */}
      <Card><BlockStack gap="300"><div style={box("20%",20)} /><div style={box("100%",80)} /></BlockStack></Card>
      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
        {[1,2,3,4,5].map(i => (
          <Card key={i}><BlockStack gap="100"><div style={box("60%",14)} /><div style={box("80%",28)} /></BlockStack></Card>
        ))}
      </div>
      {/* Brand summary */}
      <Card><BlockStack gap="300"><div style={box("40%",20)} /><div style={box("100%",200)} /></BlockStack></Card>
      {/* Chart */}
      <Card><BlockStack gap="300"><div style={box("50%",20)} /><div style={box("100%",320)} /></BlockStack></Card>
      {/* Table */}
      <Card><BlockStack gap="300"><div style={box("30%",20)} /><div style={box("100%",300)} /></BlockStack></Card>
    </>
  );
}

// ─── MAIN CONTENT ─────────────────────────────────────────────────────────────
function InventarioContent({ data, snapshotData, snapshotDate }) {
  const { variants, vendors, types, allTags } = data;
  const isSnapshot = !!snapshotDate && !!snapshotData && !snapshotData.error;

  const [search, setSearch] = useState("");
  const [filterVendors, setFilterVendors] = useState(() => vendors);
  const [filterTypes, setFilterTypes] = useState(() => types);
  const [filterTags, setFilterTags] = useState(() => allTags);
  const [filterStatus, setFilterStatus] = useState("");
  const [threshold, setThreshold] = useState("5");
  const [sortCol, setSortCol] = useState(6);
  const [sortDir, setSortDir] = useState("descending");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const thr = Math.max(1, parseInt(threshold) || 5);

  const filtered = useMemo(() => variants.filter((v) => {
    if (search) {
      const s = search.toLowerCase();
      if (!v.productTitle.toLowerCase().includes(s) && !v.sku.toLowerCase().includes(s)) return false;
    }
    if (filterVendors.length < vendors.length && !filterVendors.includes(v.vendor)) return false;
    if (filterTypes.length < types.length && !filterTypes.includes(v.productType)) return false;
    if (filterStatus && v.status !== filterStatus) return false;
    if (filterTags.length < allTags.length) {
      const excluded = allTags.filter((t) => !filterTags.includes(t));
      if (excluded.some((t) => v.tags.includes(t))) return false;
    }
    return true;
  }), [variants, search, filterVendors, filterTypes, filterStatus, filterTags, vendors, types, allTags, thr]);

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

  useEffect(() => setPage(0), [filtered, sortCol, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageData = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const filteredTotalValue = useMemo(() => filtered.reduce((s, v) => s + v.stockValue, 0), [filtered]);
  const filteredSalesValue = useMemo(() => filtered.reduce((s, v) => s + v.salesValue, 0), [filtered]);
  const filteredTotalQty = useMemo(() => filtered.reduce((s, v) => s + v.qty, 0), [filtered]);
  const avgMargin = useMemo(() => {
    const withCost = filtered.filter((v) => v.margin !== null);
    if (!withCost.length) return null;
    return withCost.reduce((s, v) => s + v.margin, 0) / withCost.length;
  }, [filtered]);

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
    v.sku || "—",
    v.vendor || "—",
    v.productType || "—",
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

  const vendorOptionList = vendors.map((v) => ({ label: v, value: v }));
  const typeOptionList = types.map((t) => ({ label: t, value: t }));
  const tagOptionList = allTags.map((t) => ({ label: t, value: t }));

  const statusOptions = [
    { label: "Tutti gli stati", value: "" },
    { label: "Disponibile", value: "ACTIVE" },
    { label: "Bozza", value: "DRAFT" },
    { label: "Non in elenco", value: "ARCHIVED" },
  ];

  const isFiltered = filtered.length < variants.length;

  const resetFilters = () => {
    setSearch("");
    setFilterVendors(vendors);
    setFilterTypes(types);
    setFilterTags(allTags);
    setFilterStatus("");
  };

  const navigate = useNavigate();
  const [snapshotDateLocal, setSnapshotDateLocal] = useState(snapshotDate || new Date().toISOString().slice(0, 10));

  return (
    <>
      {/* ── HEADER ── */}
      <InlineStack align="space-between" blockAlign="center" wrap>
        <InlineStack gap="200">
          <Button size="slim" onClick={() => exportCSV(exportRows, "inventario.csv")}>CSV varianti</Button>
          <Button size="slim" onClick={() => exportExcel(exportRows, "inventario.xlsx")}>Excel varianti</Button>
          <Button size="slim" onClick={() => exportCSV(brandExportRows, "inventario_per_brand.csv")}>CSV per brand</Button>
        </InlineStack>
      </InlineStack>

      {/* ── FILTRI ── */}
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Filtri</Text>
            {(isFiltered || isSnapshot) && (
              <Button size="slim" plain onClick={() => { resetFilters(); if (isSnapshot) navigate("/app/inventario"); }}>Azzera filtri</Button>
            )}
          </InlineStack>

          <InlineStack gap="300" wrap blockAlign="start">
            <div style={{ minWidth: 180 }}>
              <TextField label="Data inventario" type="date" value={snapshotDateLocal} onChange={setSnapshotDateLocal} autoComplete="off" />
            </div>
            <div style={{ paddingTop: 22 }}>
              <Button onClick={() => navigate(`?snapshot=${snapshotDateLocal}`)}>Applica data</Button>
            </div>
            {isSnapshot && (
              <div style={{ paddingTop: 22 }}>
                <Button plain onClick={() => navigate("/app/inventario")}>Oggi (live)</Button>
              </div>
            )}
          </InlineStack>

          {isSnapshot && (
            <Text as="p" variant="bodySm" tone="info">
              Dati storici al {new Date(snapshotDate).toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" })}
            </Text>
          )}

          {!isSnapshot && (
            <>
              <InlineStack gap="300" wrap blockAlign="start">
                <div style={{ minWidth: 220 }}>
                  <TextField
                    label="Cerca" placeholder="Prodotto / SKU..."
                    value={search} onChange={setSearch} autoComplete="off"
                  />
                </div>
                <div style={{ minWidth: 180 }}>
                  <Select label="Stato" options={statusOptions} value={filterStatus} onChange={setFilterStatus} />
                </div>
                <div style={{ minWidth: 120 }}>
                  <TextField
                    label="Soglia scorte basse" type="number" value={threshold}
                    onChange={setThreshold} autoComplete="off" min={1}
                    helpText={`≤ ${thr} pz = basso`}
                  />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap blockAlign="start">
                <div style={{ minWidth: 200 }}>
                  <MultiSelect
                    label="Brand"
                    allLabel="Tutti i brand"
                    options={vendorOptionList}
                    selected={filterVendors}
                    onChange={setFilterVendors}
                    allValues={vendors}
                  />
                </div>
                <div style={{ minWidth: 200 }}>
                  <MultiSelect
                    label="Tipo prodotto"
                    allLabel="Tutti i tipi"
                    options={typeOptionList}
                    selected={filterTypes}
                    onChange={setFilterTypes}
                    allValues={types}
                  />
                </div>
                <div style={{ minWidth: 200 }}>
                  <MultiSelect
                    label="Tag"
                    allLabel="Tutti i tag"
                    options={tagOptionList}
                    selected={filterTags}
                    onChange={setFilterTags}
                    allValues={allTags}
                  />
                </div>
              </InlineStack>

              {isFiltered && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {filtered.length} varianti su {variants.length} totali
                </Text>
              )}
            </>
          )}
        </BlockStack>
      </Card>

      {/* ── KPI ── */}
      {isSnapshot ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          <Card><BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">Pezzi in stock</Text>
            <Text as="p" variant="headingLg" fontWeight="bold">{snapshotData.totals.units.toLocaleString("it-IT")}</Text>
          </BlockStack></Card>
          <Card><BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">Valore (costo)</Text>
            <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(snapshotData.totals.costValue)}</Text>
          </BlockStack></Card>
          <Card><BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">Valore (vendita)</Text>
            <Text as="p" variant="headingLg" fontWeight="bold">{formatCurrency(snapshotData.totals.retailValue)}</Text>
          </BlockStack></Card>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {[
            { label: `Pezzi in stock${isFiltered ? " — filtrato" : ""}`, value: filteredTotalQty.toLocaleString("it-IT") },
            { label: `Valore magazzino (costo)${isFiltered ? " — filtrato" : ""}`, value: formatCurrency(filteredTotalValue) },
            { label: `Valore a prezzo vendita${isFiltered ? " — filtrato" : ""}`, value: formatCurrency(filteredSalesValue) },
            {
              label: "Margine medio (su filtro)",
              value: avgMargin !== null ? avgMargin.toFixed(1) + "%" : "—",
              color: avgMargin !== null ? (avgMargin < 20 ? "#d82c0d" : avgMargin < 40 ? "#b98900" : "#008060") : undefined,
            },
          ].map(({ label, value, color }) => (
            <Card key={label}><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
              <Text as="p" variant="headingLg" fontWeight="bold"><span style={color ? { color } : {}}>{value}</span></Text>
            </BlockStack></Card>
          ))}
        </div>
      )}

      {/* ── RIEPILOGO PER BRAND ── */}
      {isSnapshot ? (
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Riepilogo per brand</Text>
            {snapshotData.byBrand.length === 0 ? (
              <Text as="p" tone="subdued">Nessun dato.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                headings={["Brand", "Pezzi", "Valore costo", "Valore vendita"]}
                rows={snapshotData.byBrand.map((b) => [
                  b.brand,
                  b.units.toLocaleString("it-IT"),
                  formatCurrency(b.costValue),
                  formatCurrency(b.retailValue),
                ])}
              />
            )}
          </BlockStack>
        </Card>
      ) : (
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Riepilogo per brand{isFiltered ? " — filtrato" : ""}</Text>
              <Button size="slim" plain onClick={() => exportCSV(brandExportRows, "inventario_per_brand.csv")}>Esporta CSV</Button>
            </InlineStack>
            {brandSummary.length === 0 ? (
              <Text as="p" tone="subdued">Nessun dato.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
                headings={["Brand", "Varianti", "Pezzi totali", "Valore costo", "Valore vendita", "Margine medio"]}
                rows={brandSummary.map((b) => [
                  <Button key={b.brand} size="slim" plain onClick={() => { if (b.brand !== "—") setFilterVendors([b.brand]); }}>{b.brand}</Button>,
                  b.variants.toString(),
                  b.qty.toLocaleString("it-IT"),
                  b.stockValue > 0 ? formatCurrency(b.stockValue) : "—",
                  formatCurrency(b.salesValue),
                  b.avgMargin !== null ? <MarginCell key={b.brand + "m"} margin={b.avgMargin} /> : "—",
                ])}
              />
            )}
          </BlockStack>
        </Card>
      )}

      {/* ── TABELLA VARIANTI (solo dati live) ── */}
      {isSnapshot ? null : (
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
              columnContentTypes={["text","text","text","text","numeric","text","numeric","numeric"]}
              headings={["Prodotto","SKU","Brand","Tipo","Margine %","Stock","Val. magazzino","Val. vendita"]}
              rows={tableRows}
              sortable={[false, false, true, true, true, true, true, true]}
              defaultSortDirection="descending"
              initialSortColumnIndex={6}
              onSort={(col, dir) => { setSortCol(col); setSortDir(dir); }}
              totals={["", "", "", "", "", filteredTotalQty.toLocaleString("it-IT"), filteredTotalValue > 0 ? formatCurrency(filteredTotalValue) : "", formatCurrency(filteredSalesValue)]}
              showTotalsInFooter
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
      )}
    </>
  );
}


export default function Inventario() {
  const { data, snapshot, snapshotDate } = useLoaderData();

  return (
    <Page title="Inventario">
      <TitleBar title="Inventario" />
      <BlockStack gap="500">
        <Suspense fallback={<LoadingSkeleton />}>
          <Await resolve={Promise.all([data, snapshot || Promise.resolve(null)])}>
            {([resolvedData, resolvedSnapshot]) => (
              <InventarioContent data={resolvedData} snapshotData={resolvedSnapshot} snapshotDate={snapshotDate} />
            )}
          </Await>
        </Suspense>
      </BlockStack>
    </Page>
  );
}
