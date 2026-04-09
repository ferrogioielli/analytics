import { useLoaderData, Await } from "@remix-run/react";
import { defer } from "@remix-run/node";
import { useState, useMemo, useEffect, useCallback, Suspense } from "react";
import {
  Page, Card, BlockStack, InlineStack, Text, Button, Badge, Link,
  DataTable, Select, Thumbnail, TextField, Popover, OptionList,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { fetchProducts } from "../utils/shopify.server";
import { formatCurrency } from "../utils/format";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const dataPromise = (async () => {
    const products = await fetchProducts(admin);

    const brandMap = new Map();
    for (const p of products) {
      const v = p.vendor || "Senza brand";
      brandMap.set(v, (brandMap.get(v) || 0) + 1);
    }
    const byBrand = Array.from(brandMap.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    const vendors = [...new Set(products.map((p) => p.vendor).filter(Boolean))].sort();
    const types = [...new Set(products.map((p) => p.productType).filter(Boolean))].sort();
    const allTags = [...new Set(products.flatMap((p) => p.tags || []))].sort();

    return { products, byBrand, vendors, types, allTags };
  })();

  return defer({ data: dataPromise, shop });
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
            <Button size="slim" plain onClick={() => onChange(isAll ? [] : [...allValues])}>
              {isAll ? "Deseleziona tutti" : "Seleziona tutti"}
            </Button>
          </div>
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            <OptionList options={options} selected={selected} onChange={onChange} allowMultiple />
          </div>
        </div>
      </Popover>
    </BlockStack>
  );
}

const PAGE_SIZE = 50;
const SORT_KEYS = [null, "vendor", "productType", "status", "variantCount", "totalQty", "avgPrice"];

// ─── LOADING SKELETON ─────────────────────────────────────────────────────────
function LoadingSkeleton() {
  const box = (w, h) => ({ width: w, height: h, background: "#f0f0f0", borderRadius: 6, animation: "pulse 1.5s infinite" });
  return (
    <>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {[1,2,3,4].map(i => (
          <Card key={i}><BlockStack gap="100"><div style={box("60%",14)} /><div style={box("80%",28)} /></BlockStack></Card>
        ))}
      </div>
      {/* Brand distribution */}
      <Card><BlockStack gap="300"><div style={box("40%",20)} /><div style={box("100%",200)} /></BlockStack></Card>
      {/* Filters */}
      <Card><BlockStack gap="300"><div style={box("20%",20)} /><div style={box("100%",60)} /></BlockStack></Card>
      {/* Table */}
      <Card><BlockStack gap="300"><div style={box("30%",20)} /><div style={box("100%",300)} /></BlockStack></Card>
    </>
  );
}

// ─── MAIN CONTENT ─────────────────────────────────────────────────────────────
function ProdottiContent({ data, shop }) {
  const { products, byBrand, vendors, types, allTags } = data;

  const [filterVendors, setFilterVendors] = useState(() => vendors);
  const [filterTypes, setFilterTypes] = useState(() => types);
  const [filterTags, setFilterTags] = useState(() => allTags);
  const [filterStatus, setFilterStatus] = useState("");
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState(0);
  const [sortDir, setSortDir] = useState("ascending");
  const [page, setPage] = useState(0);

  const enriched = useMemo(() => products.map((p) => ({
    ...p,
    variantCount: p.variants.edges.length,
    totalQty: p.variants.edges.reduce((s, e) => s + (e.node.inventoryQuantity || 0), 0),
    avgPrice: p.variants.edges.length > 0
      ? p.variants.edges.reduce((s, e) => s + parseFloat(e.node.price), 0) / p.variants.edges.length
      : 0,
  })), [products]);

  const filtered = useMemo(() => enriched.filter((p) => {
    if (search && !p.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterVendors.length < vendors.length && !filterVendors.includes(p.vendor || "")) return false;
    if (filterTypes.length < types.length && !filterTypes.includes(p.productType || "")) return false;
    if (filterStatus && p.status !== filterStatus) return false;
    if (filterTags.length < allTags.length) {
      const excluded = allTags.filter((t) => !filterTags.includes(t));
      if (excluded.some((t) => (p.tags || []).includes(t))) return false;
    }
    return true;
  }), [enriched, search, filterVendors, filterTypes, filterStatus, filterTags, vendors, types, allTags]);

  const sorted = useMemo(() => {
    const key = SORT_KEYS[sortCol];
    if (!key) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[key] ?? "";
      const bv = b[key] ?? "";
      const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
      return sortDir === "ascending" ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir]);

  useEffect(() => setPage(0), [filtered, sortCol, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageData = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const isFiltered = filtered.length < products.length;

  const resetFilters = () => {
    setSearch("");
    setFilterVendors(vendors);
    setFilterTypes(types);
    setFilterTags(allTags);
    setFilterStatus("");
  };

  const filteredActive = filtered.filter((p) => p.status === "ACTIVE").length;
  const filteredInventory = filtered.reduce((s, p) => s + (p.totalInventory || 0), 0);
  const filteredVendors = [...new Set(filtered.map((p) => p.vendor).filter(Boolean))].length;

  const shopName = shop.replace(".myshopify.com", "");

  const tableRows = pageData.map((p) => {
    const numericId = p.id.split("/").pop();
    const productUrl = `https://admin.shopify.com/store/${shopName}/products/${numericId}`;
    return [
      <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flexShrink: 0 }}>
          {p.featuredImage?.url
            ? <Thumbnail source={p.featuredImage.url} size="small" alt={p.title} />
            : <div style={{ width: 40, height: 40, background: "#f0f0f0", borderRadius: 4 }} />
          }
        </div>
        <Link url={productUrl} external removeUnderline>
          <span
            style={{ display: "block", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, cursor: "pointer" }}
            title={p.title}
          >
            {p.title}
          </span>
        </Link>
      </div>,
      p.vendor || "—",
      p.productType || "—",
      <Badge key={p.id + "s"} tone={p.status === "ACTIVE" ? "success" : p.status === "DRAFT" ? "attention" : "critical"}>
        {p.status === "ACTIVE" ? "Attivo" : p.status === "DRAFT" ? "Bozza" : "Archiviato"}
      </Badge>,
      p.variantCount.toString(),
      <span key={p.id + "qty"} style={{ color: p.totalQty <= 0 ? "#d82c0d" : p.totalQty <= 5 ? "#b98900" : "#008060", fontWeight: 500 }}>
        {p.totalQty}
      </span>,
      formatCurrency(p.avgPrice),
    ];
  });

  const exportRows = sorted.map((p) => ({
    Prodotto: p.title,
    Brand: p.vendor || "",
    Tipo: p.productType || "",
    Tag: (p.tags || []).join(", "),
    Status: p.status,
    Varianti: p.variantCount,
    "Stock totale": p.totalQty,
    "Prezzo medio": p.avgPrice.toFixed(2),
  }));

  const vendorOptionList = vendors.map((v) => ({ label: v, value: v }));
  const typeOptionList = types.map((t) => ({ label: t, value: t }));
  const tagOptionList = allTags.map((t) => ({ label: t, value: t }));
  const statusOptions = [
    { label: "Tutti gli stati", value: "" },
    { label: "Attivo", value: "ACTIVE" },
    { label: "Bozza", value: "DRAFT" },
    { label: "Archiviato", value: "ARCHIVED" },
  ];

  return (
    <>
      {/* ── HEADER ── */}
      <InlineStack align="end" blockAlign="center">
        <InlineStack gap="200">
          <Button size="slim" onClick={() => exportCSV(exportRows, "prodotti.csv")}>CSV</Button>
          <Button size="slim" onClick={() => exportExcel(exportRows, "prodotti.xlsx")}>Excel</Button>
        </InlineStack>
      </InlineStack>

      {/* ── KPI ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {[
          { label: isFiltered ? "Prodotti filtrati" : "Prodotti totali", value: filtered.length },
          { label: isFiltered ? "Attivi — filtrati" : "Prodotti attivi", value: filteredActive },
          { label: isFiltered ? "Stock — filtrati" : "Stock totale", value: filteredInventory.toLocaleString("it-IT") },
          { label: isFiltered ? "Brand — filtrati" : "Brand distinti", value: filteredVendors },
        ].map(({ label, value }) => (
          <Card key={label}>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{value}</Text>
            </BlockStack>
          </Card>
        ))}
      </div>

      {/* ── DISTRIBUZIONE BRAND ── */}
      {byBrand.length > 0 && (
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Distribuzione per brand</Text>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 40px", alignItems: "start" }}>
              <div>
                {byBrand.slice(0, 35).map((b, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", borderBottom: "1px solid #f4f4f4" }}>
                    <span style={{ fontSize: 13, color: "#6d7175", marginRight: 6, minWidth: 22 }}>{i + 1}.</span>
                    <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                    <span style={{ fontSize: 13, color: "#6d7175", marginLeft: 8, flexShrink: 0 }}>{b.value}</span>
                  </div>
                ))}
              </div>
              <div>
                {byBrand.slice(35).map((b, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", borderBottom: "1px solid #f4f4f4" }}>
                    <span style={{ fontSize: 13, color: "#6d7175", marginRight: 6, minWidth: 22 }}>{i + 36}.</span>
                    <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                    <span style={{ fontSize: 13, color: "#6d7175", marginLeft: 8, flexShrink: 0 }}>{b.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </BlockStack>
        </Card>
      )}

      {/* ── FILTRI ── */}
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Filtri</Text>
            {isFiltered && (
              <Button size="slim" plain onClick={resetFilters}>Azzera filtri</Button>
            )}
          </InlineStack>

          <InlineStack gap="300" wrap blockAlign="start">
            <div style={{ minWidth: 220 }}>
              <TextField
                label="Cerca" placeholder="Nome prodotto..."
                value={search} onChange={setSearch} autoComplete="off"
              />
            </div>
            <div style={{ minWidth: 180 }}>
              <Select label="Stato" options={statusOptions} value={filterStatus} onChange={setFilterStatus} />
            </div>
          </InlineStack>

          <InlineStack gap="300" wrap blockAlign="start">
            {vendors.length > 0 && (
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
            )}
            {types.length > 0 && (
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
            )}
            {allTags.length > 0 && (
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
            )}
          </InlineStack>

          {isFiltered && (
            <Text as="p" variant="bodySm" tone="subdued">
              {filtered.length} prodotti su {products.length} totali
            </Text>
          )}
        </BlockStack>
      </Card>

      {/* ── TABELLA PRODOTTI ── */}
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h2" variant="headingMd">
              Tutti i prodotti ({filtered.length}{isFiltered ? ` su ${products.length}` : ""})
            </Text>
            {totalPages > 1 && (
              <InlineStack gap="200" blockAlign="center">
                <Button size="slim" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prec.</Button>
                <Text as="span" variant="bodySm">
                  Pag. {page + 1} / {totalPages} ({page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} di {sorted.length})
                </Text>
                <Button size="slim" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Succ. →</Button>
              </InlineStack>
            )}
          </InlineStack>

          {tableRows.length === 0 ? (
            <Text as="p" tone="subdued">Nessun prodotto trovato con i filtri selezionati.</Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "numeric", "numeric", "numeric"]}
              headings={["Prodotto", "Brand", "Tipo", "Status", "Varianti", "Stock", "Prezzo medio"]}
              rows={tableRows}
              sortable={[false, true, true, true, true, true, true]}
              defaultSortDirection="ascending"
              initialSortColumnIndex={0}
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
    </>
  );
}

export default function Prodotti() {
  const { data, shop } = useLoaderData();

  return (
    <Page title="Prodotti">
      <TitleBar title="Prodotti" />
      <BlockStack gap="500">
        <Suspense fallback={<LoadingSkeleton />}>
          <Await resolve={data}>
            {(resolved) => <ProdottiContent data={resolved} shop={shop} />}
          </Await>
        </Suspense>
      </BlockStack>
    </Page>
  );
}
