import { useLoaderData, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo, useEffect, useCallback } from "react";
import {
  Page, Card, BlockStack, InlineStack, Text, Button, Badge, Banner,
  DataTable, Select, TextField, Popover, OptionList,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchProducts, fetchOrdersForHistory } from "../utils/shopify.server";
import { formatCurrency, daysAgo } from "../utils/format";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const snapshot = url.searchParams.get("snapshot") || null;

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
        productCreatedAt: p.createdAt || null,
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

  // ── SNAPSHOT STORICO ─────────────────────────────────────────────────────────
  // Ricostruzione approssimativa: stock_al_giorno_X = stock_attuale + venduto_tra_X_e_oggi
  let snapshotData = null;
  if (snapshot) {
    const today = new Date().toISOString().slice(0, 10);
    const orders = await fetchOrdersForHistory(admin, { startDate: snapshot, endDate: today });

    // Mappa variantId → pezzi venduti nel periodo [snapshot, oggi]
    const soldMap = new Map();
    for (const order of orders) {
      for (const edge of order.lineItems.edges) {
        const node = edge.node;
        if (!node.variant?.id) continue;
        soldMap.set(node.variant.id, (soldMap.get(node.variant.id) || 0) + node.quantity);
      }
    }

    // Ricostruisce il magazzino storico per ogni variante e aggrega per brand
    let totalCostValue = 0;
    let totalSalesValue = 0;
    const brandMap = new Map();

    for (const v of variants) {
      const sold = soldMap.get(v.variantId) || 0;
      const histQty = v.qty + sold;                  // stock_X = stock_oggi + venduto_tra_X_oggi
      const histCost = v.cost * histQty;
      const histSales = v.price * histQty;
      totalCostValue += histCost;
      totalSalesValue += histSales;

      const brand = v.vendor || "—";
      if (!brandMap.has(brand)) brandMap.set(brand, { brand, qty: 0, costValue: 0, salesValue: 0 });
      const b = brandMap.get(brand);
      b.qty += histQty;
      b.costValue += histCost;
      b.salesValue += histSales;
    }

    const currentCostValue = variants.reduce((s, v) => s + v.stockValue, 0);
    const currentSalesValue = variants.reduce((s, v) => s + v.salesValue, 0);

    snapshotData = {
      snapshot,
      totalCostValue,
      totalSalesValue,
      currentCostValue,
      currentSalesValue,
      ordersCount: orders.length,
      byBrand: Array.from(brandMap.values()).sort((a, b) => b.costValue - a.costValue),
    };
  }

  return json({ variants, vendors, types, allTags, snapshotData });
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

/**
 * Multi-select con "seleziona tutti" per default.
 * selected: string[] — valori attualmente selezionati (spuntati).
 * allValues: string[] — tutti i valori possibili.
 * Mostra come pill gli elementi ESCLUSI (deselezionati), con X per riabilitarli.
 */
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

export default function Inventario() {
  const { variants, vendors, types, allTags, snapshotData } = useLoaderData();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  // Partono tutti selezionati — togliere = escludere
  const [filterVendors, setFilterVendors] = useState(() => vendors);
  const [filterTypes, setFilterTypes] = useState(() => types);
  const [filterTags, setFilterTags] = useState(() => allTags);
  const [filterStatus, setFilterStatus] = useState("");
  // Filtro per data di creazione del prodotto (vuoto = nessun limite)
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [threshold, setThreshold] = useState("5");
  // Snapshot storico — picker locale (separato dalla navigate)
  const [snapshotInput, setSnapshotInput] = useState(snapshotData?.snapshot || "");
  useEffect(() => setSnapshotInput(snapshotData?.snapshot || ""), [snapshotData]);
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
    // Brand: mostra solo quelli selezionati (non selezionato = escluso)
    if (filterVendors.length < vendors.length && !filterVendors.includes(v.vendor)) return false;
    // Tipo prodotto
    if (filterTypes.length < types.length && !filterTypes.includes(v.productType)) return false;
    // Stato pubblicazione
    if (filterStatus && v.status !== filterStatus) return false;
    // Tag: nasconde le varianti che hanno un tag deselezionato
    if (filterTags.length < allTags.length) {
      const excluded = allTags.filter((t) => !filterTags.includes(t));
      if (excluded.some((t) => v.tags.includes(t))) return false;
    }
    // Data di creazione prodotto: confronto sulla parte YYYY-MM-DD dell'ISO
    if (filterDateFrom || filterDateTo) {
      const createdDay = v.productCreatedAt ? v.productCreatedAt.slice(0, 10) : "";
      if (!createdDay) return false;
      if (filterDateFrom && createdDay < filterDateFrom) return false;
      if (filterDateTo && createdDay > filterDateTo) return false;
    }
    return true;
  }), [variants, search, filterVendors, filterTypes, filterStatus, filterTags, filterDateFrom, filterDateTo, vendors, types, allTags, thr]);

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
    setFilterDateFrom("");
    setFilterDateTo("");
  };

  const today = new Date().toISOString().slice(0, 10);
  const datePresets = [
    { label: "30 giorni", from: daysAgo(30), to: today },
    { label: "90 giorni", from: daysAgo(90), to: today },
    { label: "Anno", from: `${new Date().getFullYear()}-01-01`, to: today },
  ];

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
          </InlineStack>
        </InlineStack>

        {/* ── FILTRI ── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Filtri</Text>
              {isFiltered && (
                <Button size="slim" plain onClick={resetFilters}>Azzera filtri</Button>
              )}
            </InlineStack>

            {/* Riga 1: Cerca + Stato + Soglia */}
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

            {/* Riga 2: Multi-select Brand + Tipo + Tag */}
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

            {/* Riga 3: Filtro data di creazione prodotto */}
            <BlockStack gap="200">
              <Text as="span" variant="bodySm">Data creazione prodotto</Text>
              <InlineStack gap="200" blockAlign="end" wrap>
                <div style={{ minWidth: 150 }}>
                  <TextField
                    label="Dal" type="date" value={filterDateFrom}
                    onChange={setFilterDateFrom} autoComplete="off"
                  />
                </div>
                <div style={{ minWidth: 150 }}>
                  <TextField
                    label="Al" type="date" value={filterDateTo}
                    onChange={setFilterDateTo} autoComplete="off"
                  />
                </div>
                <InlineStack gap="100" blockAlign="center">
                  {datePresets.map((p) => {
                    const active = filterDateFrom === p.from && filterDateTo === p.to;
                    return (
                      <Button
                        key={p.label}
                        size="slim"
                        variant={active ? "primary" : "plain"}
                        onClick={() => {
                          setFilterDateFrom(p.from);
                          setFilterDateTo(p.to);
                        }}
                      >
                        {p.label}
                      </Button>
                    );
                  })}
                  {(filterDateFrom || filterDateTo) && (
                    <Button
                      size="slim"
                      plain
                      onClick={() => { setFilterDateFrom(""); setFilterDateTo(""); }}
                    >
                      Azzera date ✕
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>
            </BlockStack>

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
                  <Button
                    key={b.brand}
                    size="slim"
                    plain
                    onClick={() => {
                      if (b.brand === "—") return;
                      // Mostra solo questo brand (deseleziona tutti gli altri)
                      setFilterVendors([b.brand]);
                    }}
                  >
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

        {/* ── VALORE MAGAZZINO STORICO ── */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Valore magazzino a data</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Stima il valore del magazzino in una data passata ricostruendo le vendite dagli ordini.
              Formula: <em>stock al giorno X = stock attuale + pezzi venduti tra X e oggi</em>
            </Text>

            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ minWidth: 180 }}>
                <TextField
                  label="Data snapshot"
                  type="date"
                  value={snapshotInput}
                  onChange={setSnapshotInput}
                  autoComplete="off"
                  max={today}
                />
              </div>
              <div style={{ paddingTop: 22 }}>
                <Button
                  variant="primary"
                  onClick={() => navigate(`?snapshot=${snapshotInput}`)}
                  disabled={!snapshotInput}
                >
                  Calcola
                </Button>
              </div>
              {snapshotData && (
                <div style={{ paddingTop: 22 }}>
                  <Button size="slim" plain onClick={() => { setSnapshotInput(""); navigate("?"); }}>
                    ✕ Azzera
                  </Button>
                </div>
              )}
            </InlineStack>

            {snapshotData && (() => {
              const daysDiff = Math.round((new Date(today) - new Date(snapshotData.snapshot)) / (1000 * 60 * 60 * 24));
              const over60 = daysDiff > 60;
              const deltaCost = snapshotData.totalCostValue - snapshotData.currentCostValue;
              const deltaPct = snapshotData.currentCostValue > 0
                ? (deltaCost / snapshotData.currentCostValue) * 100
                : null;
              return (
                <BlockStack gap="300">
                  {snapshotData.ordersCount === 0 ? (
                    <Banner tone="warning">
                      <Text as="p" variant="bodySm">
                        Nessun ordine trovato per il periodo selezionato.
                        {over60 && " La data è oltre 60 giorni fa: potrebbe essere necessario lo scope read_all_orders (richiesto a Shopify Partners). I valori mostrati coincidono con il magazzino attuale."}
                      </Text>
                    </Banner>
                  ) : (
                    <Banner tone="info">
                      <Text as="p" variant="bodySm">
                        ⚠️ Stima approssimativa — basata su {snapshotData.ordersCount} ordini trovati.
                        Non include riassortimenti manuali, resi o correzioni manuali dello stock.
                        {over60 && " ⚠️ Periodo oltre 60 giorni: dati completi richiedono lo scope read_all_orders."}
                      </Text>
                    </Banner>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                    {[
                      { label: `Val. costo al ${snapshotData.snapshot}`, value: formatCurrency(snapshotData.totalCostValue) },
                      { label: `Val. vendita al ${snapshotData.snapshot}`, value: formatCurrency(snapshotData.totalSalesValue) },
                      { label: "Val. costo oggi", value: formatCurrency(snapshotData.currentCostValue) },
                      {
                        label: "Variazione dal snapshot ad oggi",
                        value: formatCurrency(deltaCost),
                        badge: deltaPct !== null ? { tone: deltaCost < 0 ? "critical" : "success", text: `${deltaCost > 0 ? "+" : ""}${deltaPct.toFixed(1)}%` } : null,
                      },
                    ].map(({ label, value, badge }) => (
                      <Card key={label}>
                        <BlockStack gap="100">
                          <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                          <Text as="p" variant="headingMd" fontWeight="bold">{value}</Text>
                          {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
                        </BlockStack>
                      </Card>
                    ))}
                  </div>

                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                    headings={["Brand", `Pezzi stimati al ${snapshotData.snapshot}`, "Val. costo stimato", "Val. vendita stimato"]}
                    rows={snapshotData.byBrand.map((b) => [
                      b.brand,
                      b.qty.toLocaleString("it-IT"),
                      b.costValue > 0 ? formatCurrency(b.costValue) : "—",
                      formatCurrency(b.salesValue),
                    ])}
                  />
                </BlockStack>
              );
            })()}
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

      </BlockStack>
    </Page>
  );
}
