import { useLoaderData, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/node";
import { useState, useMemo, useEffect, useCallback } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Badge,
  DataTable, Select, Thumbnail, TextField, Popover, OptionList,
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

  // Distribuzione per brand (su tutti i prodotti)
  const brandMap = new Map();
  for (const p of products) {
    const v = p.vendor || "Senza brand";
    brandMap.set(v, (brandMap.get(v) || 0) + 1);
  }
  const byBrand = Array.from(brandMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const vendors = [...new Set(products.map((p) => p.vendor).filter(Boolean))].sort();
  const types = [...new Set(products.map((p) => p.productType).filter(Boolean))].sort();
  const allTags = [...new Set(products.flatMap((p) => p.tags || []))].sort();

  return json({ products, topByRevenue, topByUnits, byBrand, vendors, types, allTags, start, end });
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
        <Text as="span" variant="bodySm" tone="subdued">Vendite nel periodo:</Text>
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

export default function Prodotti() {
  const { products, topByRevenue, topByUnits, byBrand, vendors, types, allTags, start, end } = useLoaderData();

  const [filterVendors, setFilterVendors] = useState(() => vendors);
  const [filterTypes, setFilterTypes] = useState(() => types);
  const [filterTags, setFilterTags] = useState(() => allTags);
  const [filterStatus, setFilterStatus] = useState("");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => products.filter((p) => {
    if (search && !p.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterVendors.length < vendors.length && !filterVendors.includes(p.vendor || "")) return false;
    if (filterTypes.length < types.length && !filterTypes.includes(p.productType || "")) return false;
    if (filterStatus && p.status !== filterStatus) return false;
    if (filterTags.length < allTags.length) {
      const excluded = allTags.filter((t) => !filterTags.includes(t));
      if (excluded.some((t) => (p.tags || []).includes(t))) return false;
    }
    return true;
  }), [products, search, filterVendors, filterTypes, filterStatus, filterTags, vendors, types, allTags]);

  const isFiltered = filtered.length < products.length;

  const resetFilters = () => {
    setSearch("");
    setFilterVendors(vendors);
    setFilterTypes(types);
    setFilterTags(allTags);
    setFilterStatus("");
  };

  // KPI sul set filtrato
  const filteredInventory = filtered.reduce((s, p) => s + (p.totalInventory || 0), 0);
  const filteredActive = filtered.filter((p) => p.status === "ACTIVE").length;
  const filteredVendors = [...new Set(filtered.map((p) => p.vendor).filter(Boolean))].length;
  const totalRevenue = topByRevenue.reduce((s, p) => s + p.revenue, 0);

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
      <span key={p.id + "qty"} style={{ color: totalQty <= 0 ? "#d82c0d" : totalQty <= 5 ? "#b98900" : "#008060", fontWeight: 500 }}>
        {totalQty}
      </span>,
      formatCurrency(avgPrice),
      soldData ? soldData.units.toString() : "0",
      soldData ? formatCurrency(soldData.revenue) : "€0",
      soldData && totalRevenue > 0 ? (soldData.revenue / totalRevenue * 100).toFixed(1) + "%" : "—",
    ];
  });

  const exportRows = filtered.map((p) => {
    const totalQty = p.variants.edges.reduce((s, e) => s + (e.node.inventoryQuantity || 0), 0);
    const soldData = topByRevenue.find((t) => t.id === p.id);
    return {
      Prodotto: p.title,
      Brand: p.vendor || "",
      Tipo: p.productType || "",
      Tag: (p.tags || []).join(", "),
      Status: p.status,
      Varianti: p.variants.edges.length,
      "Stock totale": totalQty,
      "Unità vendute": soldData?.units || 0,
      Fatturato: soldData ? soldData.revenue.toFixed(2) : "0",
    };
  });

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
    <Page title="Prodotti">
      <TitleBar title="Prodotti" />
      <BlockStack gap="500">

        {/* ── HEADER ── */}
        <InlineStack align="space-between" blockAlign="start" wrap>
          <DateRangePicker start={start} end={end} />
          <InlineStack gap="200">
            <Button size="slim" onClick={() => exportCSV(exportRows, `prodotti_${start}_${end}.csv`)}>CSV</Button>
            <Button size="slim" onClick={() => exportExcel(exportRows, `prodotti_${start}_${end}.xlsx`)}>Excel</Button>
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

        {/* ── KPI ── */}
        <Layout>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Prodotti{isFiltered ? " — filtrati" : " totali"}</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{filtered.length}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Prodotti attivi{isFiltered ? " — filtrati" : ""}</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{filteredActive}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Stock totale{isFiltered ? " — filtrati" : ""}</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{filteredInventory.toLocaleString("it-IT")}</Text>
            </BlockStack></Card>
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <Card><BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Brand distinti{isFiltered ? " — filtrati" : ""}</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{filteredVendors}</Text>
            </BlockStack></Card>
          </Layout.Section>
        </Layout>

        {/* ── GRAFICI VENDITE ── */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Top 20 prodotti per fatturato</Text>
                {topByRevenue.length === 0 ? (
                  <Text as="p" tone="subdued">Nessuna vendita nel periodo selezionato.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={topByRevenue.slice(0, 20)} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => `€${v.toFixed(0)}`} />
                      <YAxis type="category" dataKey="title" tick={{ fontSize: 10 }} width={150} />
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
                  <Text as="p" tone="subdued">Nessuna vendita nel periodo selezionato.</Text>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={topByUnits.slice(0, 20)} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                      <YAxis type="category" dataKey="title" tick={{ fontSize: 10 }} width={150} />
                      <Tooltip />
                      <Bar dataKey="units" name="Unità" fill="#008060" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* ── DISTRIBUZIONE BRAND ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Distribuzione per brand</Text>
            <InlineStack gap="600" wrap blockAlign="start">
              <ResponsiveContainer width={260} height={220}>
                <PieChart>
                  <Pie data={byBrand} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90}
                    label={({ name, percent }) => percent > 0.05 ? `${(percent * 100).toFixed(0)}%` : ""}
                    labelLine={false}>
                    {byBrand.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <BlockStack gap="200">
                {byBrand.map((b, i) => (
                  <InlineStack key={i} gap="200" blockAlign="center">
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                    <Text as="span" variant="bodySm">{b.name}: {b.value} prodotti</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* ── TABELLA PRODOTTI ── */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Tutti i prodotti ({filtered.length}{isFiltered ? ` su ${products.length}` : ""})
            </Text>
            {tableRows.length === 0 ? (
              <Text as="p" tone="subdued">Nessun prodotto trovato con i filtri selezionati.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text","text","text","text","numeric","numeric","numeric","numeric","numeric","numeric"]}
                headings={["Prodotto","Brand","Tipo","Status","Varianti","Stock","Prezzo medio","Venduto","Fatturato","% Fatt."]}
                rows={tableRows}
              />
            )}
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
