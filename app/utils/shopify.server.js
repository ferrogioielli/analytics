/**
 * Utility per fetch dati da Shopify GraphQL Admin API
 * Tutte le funzioni usano paginazione cursore per gestire cataloghi grandi.
 */

// ─── CACHE IN-MEMORY ───────────────────────────────────────────────────────────
// Cache di processo per ridurre le chiamate ripetute a Shopify quando l'utente
// naviga tra le tab. TTL breve (5 min) per restare reattivi a nuovi ordini.
// Nota: in serverless multi-istanza la cache è per-istanza, comunque utile.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuti
const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.v;
}

function cacheSet(key, value) {
  _cache.set(key, { t: Date.now(), v: value });
  // Soft cap: evita memory leak se la cache cresce troppo
  if (_cache.size > 200) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
}

// ─── ORDINI ────────────────────────────────────────────────────────────────────

const FINANCIAL_STATUS_MAP = {
  "Authorized": "AUTHORIZED",
  "Expired": "EXPIRED",
  "Paid": "PAID",
  "Partially paid": "PARTIALLY_PAID",
  "Partially refunded": "PARTIALLY_REFUNDED",
  "Pending": "PENDING",
  "Refunded": "REFUNDED",
  "Voided": "VOIDED",
};

const FULFILLMENT_STATUS_MAP = {
  "Fulfilled": "FULFILLED",
  "Unfulfilled": "UNFULFILLED",
  "Partially fulfilled": "PARTIAL",
  "In progress": "IN_PROGRESS",
  "On hold": "ON_HOLD",
  "Scheduled": "SCHEDULED",
  "Open": "OPEN",
};

const ORDER_FIELDS_FULL = `
  id
  name
  createdAt
  displayFinancialStatus
  displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  subtotalPriceSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  channelInformation {
    channelDefinition {
      channelName
      handle
    }
    app { title }
  }
  customer {
    id
    firstName
    lastName
    email
    numberOfOrders
  }
  lineItems(first: 50) {
    edges {
      node {
        title
        quantity
        originalTotalSet { shopMoney { amount } }
        variant {
          sku
          product {
            id
            title
            vendor
            productType
          }
        }
      }
    }
  }
`;

// Variante "skinny" per i fetch comparativi (periodo precedente, anno precedente)
// dove servono solo totali, conteggi e info cliente — niente lineItems pesanti.
const ORDER_FIELDS_SKINNY = `
  id
  createdAt
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { numberOfOrders }
`;

/**
 * Carica tutti gli ordini in un intervallo di date con paginazione.
 *
 * Opzioni:
 *   - skinny: true → query leggera senza lineItems (per fetch comparativi)
 */
export async function fetchOrders(admin, { startDate, endDate, skinny = false }) {
  const cacheKey = `orders:${skinny ? "S" : "F"}:${startDate || ""}:${endDate || ""}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const orders = [];
  let hasNextPage = true;
  let cursor = null;

  const queryFilter = buildDateQuery(startDate, endDate);
  const fields = skinny ? ORDER_FIELDS_SKINNY : ORDER_FIELDS_FULL;

  while (hasNextPage) {
    const variables = { first: 250, query: queryFilter };
    if (cursor) variables.after = cursor;

    const response = await admin.graphql(
      `#graphql
      query getOrders($first: Int!, $after: String, $query: String) {
        orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              ${fields}
            }
          }
        }
      }`,
      { variables },
    );

    const json = await response.json();
    const data = json.data?.orders;
    if (!data) break;
    orders.push(...data.edges.map((e) => {
      const node = e.node;
      if (!skinny) {
        node.financialStatus = FINANCIAL_STATUS_MAP[node.displayFinancialStatus] || node.displayFinancialStatus || "UNKNOWN";
        node.fulfillmentStatus = FULFILLMENT_STATUS_MAP[node.displayFulfillmentStatus] || node.displayFulfillmentStatus || null;
      }
      return node;
    }));
    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  cacheSet(cacheKey, orders);
  return orders;
}

function buildDateQuery(startDate, endDate) {
  // Safety: normalizza whitespace e ordina le date se invertite
  let s = startDate?.trim() || null;
  let e = endDate?.trim() || null;
  if (s && e && s > e) [s, e] = [e, s];

  const parts = [];
  // Formato canonico dalla documentazione Shopify Admin GraphQL:
  // solo data, niente orario, niente timezone, niente apici.
  // Esempio dai docs: `created_at:>2019-12-01`
  // Docs: https://shopify.dev/docs/api/usage/search-syntax
  if (s) parts.push(`created_at:>=${s}`);
  if (e) {
    // Per includere l'INTERO giorno finale usiamo strict-less-than sul
    // giorno successivo, altrimenti `<=${e}` senza orario verrebbe
    // interpretato come mezzanotte di quel giorno, escludendo gli ordini
    // del pomeriggio/sera dell'ultimo giorno selezionato.
    const next = new Date(`${e}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextStr = next.toISOString().slice(0, 10);
    parts.push(`created_at:<${nextStr}`);
  }
  // Shopify usa lo spazio come AND implicito nel query language.
  return parts.join(" ") || undefined;
}

/**
 * Recupera il valore del magazzino a una data precisa tramite ShopifyQL.
 * Usa la stessa fonte dati delle analisi native di Shopify → dati esatti, non stimati.
 *
 * Ritorna:
 *   { total: { units, costValue, retailValue },
 *     byBrand: [{ brand, units, costValue, retailValue }],
 *     error: string | null }
 */
export async function fetchInventorySnapshot(admin, { date }) {
  const cacheKey = `inv_snapshot:${date}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Query totale (senza raggruppamento) — WHERE inventory_is_tracked = true come Shopify Analytics
  const totalQuery = `FROM inventory SHOW ending_inventory_units, ending_inventory_value, ending_inventory_retail_value WHERE inventory_is_tracked = true SINCE ${date} UNTIL ${date}`;
  // Query per brand
  const brandQuery  = `FROM inventory SHOW ending_inventory_units, ending_inventory_value, ending_inventory_retail_value WHERE inventory_is_tracked = true GROUP BY vendor_name WITH TOTALS SINCE ${date} UNTIL ${date} ORDER BY ending_inventory_value DESC LIMIT 250`;

  const [totalResp, brandResp] = await Promise.all([
    admin.graphql(
      `mutation shopifyqlQuery($query: String!) {
        shopifyqlQuery(query: $query) {
          ... on TableResponse { tableData { rowData columns { name } } }
          ... on ParseErrorResponse { parseErrors { code message } }
        }
      }`,
      { variables: { query: totalQuery } },
    ),
    admin.graphql(
      `mutation shopifyqlQuery($query: String!) {
        shopifyqlQuery(query: $query) {
          ... on TableResponse { tableData { rowData columns { name } } }
          ... on ParseErrorResponse { parseErrors { code message } }
        }
      }`,
      { variables: { query: brandQuery } },
    ),
  ]);

  const totalJson = await totalResp.json();
  const brandJson = await brandResp.json();

  const totalSql = totalJson.data?.shopifyqlQuery;
  const brandSql = brandJson.data?.shopifyqlQuery;

  // Gestione errori di parsing ShopifyQL
  if (totalSql?.parseErrors) {
    const result = { error: totalSql.parseErrors.map((e) => e.message).join("; "), total: null, byBrand: [] };
    cacheSet(cacheKey, result);
    return result;
  }

  // Utility: converte rowData in array di oggetti usando i nomi colonna
  function parseTable(tableData) {
    if (!tableData?.rowData?.length) return [];
    const cols = tableData.columns.map((c) => c.name);
    return tableData.rowData.map((row) =>
      Object.fromEntries(cols.map((c, i) => [c, row[i]])),
    );
  }

  const totalRows = parseTable(totalSql?.tableData);
  const brandRows = parseTable(brandSql?.tableData);

  // Riga di riepilogo (prima riga della tabella totale)
  const t = totalRows[0] || {};
  const total = {
    units:       parseInt(t.ending_inventory_units   || 0),
    costValue:   parseFloat(t.ending_inventory_value  || 0),
    retailValue: parseFloat(t.ending_inventory_retail_value || 0),
  };

  // Righe per brand — ShopifyQL restituisce anche una riga "Summary"
  const byBrand = brandRows
    .filter((r) => r.vendor_name && r.vendor_name !== "Summary")
    .map((r) => ({
      brand:       r.vendor_name || "—",
      units:       parseInt(r.ending_inventory_units   || 0),
      costValue:   parseFloat(r.ending_inventory_value  || 0),
      retailValue: parseFloat(r.ending_inventory_retail_value || 0),
    }))
    .sort((a, b) => b.costValue - a.costValue);

  const result = { error: null, total, byBrand, date };
  cacheSet(cacheKey, result);
  return result;
}

// ─── SHOPIFYQL ─────────────────────────────────────────────────────────────────

/**
 * Esegue una ShopifyQL query tramite la mutation shopifyqlQuery.
 * Cache 5 min inclusa. Restituisce { rows, error }.
 */
async function runShopifyQL(admin, query) {
  const cacheKey = `ql:${query.replace(/\s+/g, " ").trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let response;
  try {
    response = await admin.graphql(
      `#graphql
      mutation shopifyqlQuery($query: String!) {
        shopifyqlQuery(query: $query) {
          ... on TableResponse {
            tableData { rowData columns { name dataType } }
          }
          ... on ParseErrorResponse {
            parseErrors { code message }
          }
        }
      }`,
      { variables: { query } },
    );
  } catch (err) {
    return { rows: [], error: String(err.message || err) };
  }

  const json = await response.json();
  const result = json.data?.shopifyqlQuery;

  if (result?.parseErrors?.length) {
    return { rows: [], error: result.parseErrors.map((e) => e.message).join("; ") };
  }

  const tableData = result?.tableData;
  if (!tableData?.rowData?.length) return { rows: [], error: null };

  const cols = tableData.columns.map((c) => c.name);
  const rows = tableData.rowData.map((row) =>
    Object.fromEntries(cols.map((c, i) => [c, row[i]])),
  );

  const out = { rows, error: null };
  cacheSet(cacheKey, out);
  return out;
}

/** Helper: legge un valore numerico dalla prima riga di un risultato ShopifyQL */
function qlNum(result, field) {
  if (result.error || !result.rows.length) return 0;
  const v = result.rows[0]?.[field];
  return v === null || v === undefined ? 0 : parseFloat(v) || 0;
}

/**
 * Recupera tutti i dati per la Dashboard tramite ShopifyQL.
 * Nessun limite 60 giorni. Sostituisce fetchOrders+calcKPI+groupOrdersByDay+topProductsByRevenue+ordersByFinancialStatus.
 */
export async function fetchDashboardByQL(admin, { start, end }) {
  const prev = getPrevPeriod(start, end);

  const [
    currTotals, prevTotals,
    custData,
    byDayData,
    topProductsData,
    byStatusData,
  ] = await Promise.all([
    runShopifyQL(admin, `FROM sales SHOW total_sales, orders SINCE ${start} UNTIL ${end}`),
    runShopifyQL(admin, `FROM sales SHOW total_sales, orders SINCE ${prev.start} UNTIL ${prev.end}`),
    runShopifyQL(admin, `FROM sales SHOW customers WHERE new_or_returning_customer IS NOT NULL GROUP BY new_or_returning_customer SINCE ${start} UNTIL ${end} ORDER BY new_or_returning_customer ASC LIMIT 10`),
    runShopifyQL(admin, `FROM sales SHOW total_sales, orders TIMESERIES day SINCE ${start} UNTIL ${end} ORDER BY day ASC LIMIT 1000`),
    runShopifyQL(admin, `FROM sales SHOW total_sales, net_items_sold WHERE product_title IS NOT NULL GROUP BY product_title, product_vendor SINCE ${start} UNTIL ${end} ORDER BY total_sales DESC LIMIT 10`),
    runShopifyQL(admin, `FROM sales SHOW orders WHERE billing_financial_status IS NOT NULL GROUP BY billing_financial_status SINCE ${start} UNTIL ${end} ORDER BY orders DESC LIMIT 20`),
  ]);

  // Periodo precedente per nuovi clienti
  const prevCustData = await runShopifyQL(admin,
    `FROM sales SHOW customers WHERE new_or_returning_customer IS NOT NULL GROUP BY new_or_returning_customer SINCE ${prev.start} UNTIL ${prev.end} ORDER BY new_or_returning_customer ASC LIMIT 10`
  );

  const revenue = qlNum(currTotals, "total_sales");
  const count   = Math.round(qlNum(currTotals, "orders"));
  const aov     = count > 0 ? revenue / count : 0;

  const prevRevenue = qlNum(prevTotals, "total_sales");
  const prevCount   = Math.round(qlNum(prevTotals, "orders"));
  const prevAov     = prevCount > 0 ? prevRevenue / prevCount : 0;

  // Nuovi clienti: cerca riga con new_or_returning_customer = 'new' (EN) o 'Nuovo' (IT)
  const getNewCust = (rows) => {
    const row = rows.find((r) =>
      r.new_or_returning_customer?.toLowerCase() === "new" ||
      r.new_or_returning_customer === "Nuovo"
    );
    return row ? Math.round(parseFloat(row.customers || 0)) : 0;
  };
  const newCustomers = getNewCust(custData.rows || []);
  const prevNew      = getNewCust(prevCustData.rows || []);

  const delta = (c, p) => (p > 0 ? ((c - p) / p) * 100 : null);
  const kpi = {
    revenue, count, aov, newCustomers,
    revenueDelta: delta(revenue, prevRevenue),
    countDelta:   delta(count, prevCount),
    aovDelta:     delta(aov, prevAov),
    newDelta:     delta(newCustomers, prevNew),
    currency: "EUR",
  };

  const byDay = (byDayData.rows || [])
    .map((r) => ({ date: String(r.day || "").slice(0, 10), revenue: parseFloat(r.total_sales || 0), orders: Math.round(parseFloat(r.orders || 0)) }))
    .filter((d) => d.date);

  const topProducts = (topProductsData.rows || []).map((r) => ({
    id: r.product_title,
    title: r.product_title || "",
    vendor: r.product_vendor || "",
    revenue: parseFloat(r.total_sales || 0),
    units:   Math.round(parseFloat(r.net_items_sold || 0)),
  }));

  const FINANCIAL_STATUS_IT = {
    paid: "Pagato", pending: "In attesa", refunded: "Rimborsato",
    partially_refunded: "Parz. rimborsato", authorized: "Autorizzato",
    voided: "Annullato", partially_paid: "Parz. pagato",
  };
  const byStatus = (byStatusData.rows || [])
    .filter((r) => r.billing_financial_status)
    .map((r) => ({
      name: FINANCIAL_STATUS_IT[r.billing_financial_status?.toLowerCase()] || r.billing_financial_status,
      value: Math.round(parseFloat(r.orders || 0)),
    }));

  return { kpi, byDay, topProducts, byStatus };
}

/**
 * Recupera i dati aggregati per la tab Vendite tramite ShopifyQL.
 * Restituisce kpi, byDay (con anno precedente), topByRevenue, topByUnits, brands, yoyRevenue, yoyDelta.
 */
export async function fetchVenditeByQL(admin, { start, end }) {
  const yoyStart = new Date(start); yoyStart.setFullYear(yoyStart.getFullYear() - 1);
  const yoyEnd   = new Date(end);   yoyEnd.setFullYear(yoyEnd.getFullYear() - 1);
  const yoyS = yoyStart.toISOString().slice(0, 10);
  const yoyE = yoyEnd.toISOString().slice(0, 10);

  const [
    currTotals,
    yoyTotals,
    byDayData,
    yoyByDayData,
    topProductsData,
    brandsData,
  ] = await Promise.all([
    runShopifyQL(admin, `FROM sales SHOW total_sales, orders SINCE ${start} UNTIL ${end}`),
    runShopifyQL(admin, `FROM sales SHOW total_sales, orders SINCE ${yoyS} UNTIL ${yoyE}`),
    runShopifyQL(admin, `FROM sales SHOW total_sales, orders TIMESERIES day SINCE ${start} UNTIL ${end} ORDER BY day ASC LIMIT 1000`),
    runShopifyQL(admin, `FROM sales SHOW total_sales, orders TIMESERIES day SINCE ${yoyS} UNTIL ${yoyE} ORDER BY day ASC LIMIT 1000`),
    runShopifyQL(admin, `FROM sales SHOW total_sales, net_items_sold WHERE product_title IS NOT NULL GROUP BY product_title, product_vendor SINCE ${start} UNTIL ${end} ORDER BY total_sales DESC LIMIT 10`),
    runShopifyQL(admin, `FROM sales SHOW total_sales, net_items_sold WHERE product_vendor IS NOT NULL GROUP BY product_vendor SINCE ${start} UNTIL ${end} ORDER BY total_sales DESC LIMIT 100`),
  ]);

  const revenue = qlNum(currTotals, "total_sales");
  const count   = Math.round(qlNum(currTotals, "orders"));
  const aov     = count > 0 ? revenue / count : 0;

  const yoyRevenue = qlNum(yoyTotals, "total_sales");
  const yoyDelta   = yoyRevenue > 0 ? ((revenue - yoyRevenue) / yoyRevenue) * 100 : null;

  const kpi = { revenue, count, aov, currency: "EUR" };

  const byDayCurr = (byDayData.rows || [])
    .map((r) => ({ date: String(r.day || "").slice(0, 10), revenue: parseFloat(r.total_sales || 0), orders: Math.round(parseFloat(r.orders || 0)) }))
    .filter((d) => d.date);

  const byDayYoy = (yoyByDayData.rows || [])
    .map((r) => ({ revenue: parseFloat(r.total_sales || 0), orders: Math.round(parseFloat(r.orders || 0)) }));

  const byDay = byDayCurr.map((d, i) => ({
    ...d,
    prevRevenue: byDayYoy[i]?.revenue || 0,
    prevOrders:  byDayYoy[i]?.orders  || 0,
  }));

  const topByRevenue = (topProductsData.rows || []).map((r) => ({
    id:      r.product_title,
    title:   r.product_title || "",
    vendor:  r.product_vendor || "",
    revenue: parseFloat(r.total_sales || 0),
    units:   Math.round(parseFloat(r.net_items_sold || 0)),
  }));
  const topByUnits = [...topByRevenue].sort((a, b) => b.units - a.units);

  // Brands: revenue + units da ShopifyQL; orders verrà aggiunto lato loader da GraphQL
  const qlBrands = (brandsData.rows || []).map((r) => ({
    name:    r.product_vendor || "",
    revenue: parseFloat(r.total_sales || 0),
    units:   Math.round(parseFloat(r.net_items_sold || 0)),
    orders:  0, // sovrascritto nel loader da GraphQL se disponibile
  }));

  return { kpi, byDay, topByRevenue, topByUnits, qlBrands, yoyRevenue, yoyDelta };
}

// ─── PRODOTTI ──────────────────────────────────────────────────────────────────

const PRODUCT_FIELDS = `
  id
  title
  createdAt
  vendor
  productType
  status
  tags
  totalInventory
  featuredImage { url }
  variants(first: 100) {
    edges {
      node {
        id
        sku
        title
        price
        inventoryQuantity
        inventoryItem {
          unitCost { amount currencyCode }
        }
      }
    }
  }
`;

/**
 * Carica tutti i prodotti con varianti e inventario.
 */
export async function fetchProducts(admin) {
  const cacheKey = "products:all";
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const products = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const variables = { first: 250 };
    if (cursor) variables.after = cursor;

    const response = await admin.graphql(
      `#graphql
      query getProducts($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              ${PRODUCT_FIELDS}
            }
          }
        }
      }`,
      { variables },
    );

    const json = await response.json();
    const data = json.data?.products;
    if (!data) break;
    products.push(...data.edges.map((e) => e.node));
    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  cacheSet(cacheKey, products);
  return products;
}

// ─── CLIENTI ───────────────────────────────────────────────────────────────────

const CUSTOMER_FIELDS = `
  id
  firstName
  lastName
  email
  createdAt
  numberOfOrders
  amountSpent { amount currencyCode }
  lastOrder { createdAt name }
  tags
`;

/**
 * Carica tutti i clienti con statistiche.
 */
export async function fetchCustomers(admin) {
  const cacheKey = "customers:all";
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const customers = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const variables = { first: 250 };
    if (cursor) variables.after = cursor;

    const response = await admin.graphql(
      `#graphql
      query getCustomers($first: Int!, $after: String) {
        customers(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              ${CUSTOMER_FIELDS}
            }
          }
        }
      }`,
      { variables },
    );

    const json = await response.json();
    const data = json.data?.customers;
    if (!data) break;
    customers.push(...data.edges.map((e) => e.node));
    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  cacheSet(cacheKey, customers);
  return customers;
}

// ─── AGGREGAZIONI ──────────────────────────────────────────────────────────────

/**
 * Raggruppa gli ordini per giorno — restituisce array [{ date, revenue, orders }]
 */
export function groupOrdersByDay(orders) {
  const map = new Map();
  for (const order of orders) {
    const day = order.createdAt.slice(0, 10); // YYYY-MM-DD
    if (!map.has(day)) map.set(day, { date: day, revenue: 0, orders: 0 });
    const entry = map.get(day);
    entry.revenue += parseFloat(order.totalPriceSet.shopMoney.amount);
    entry.orders += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Calcola KPI da array ordini + periodo precedente (stessa durata)
 */
export function calcKPI(orders, prevOrders) {
  const revenue = orders.reduce((s, o) => s + parseFloat(o.totalPriceSet.shopMoney.amount), 0);
  const count = orders.length;
  const aov = count > 0 ? revenue / count : 0;
  const newCustomers = orders.filter((o) => o.customer?.numberOfOrders === 1).length;

  const prevRevenue = prevOrders.reduce((s, o) => s + parseFloat(o.totalPriceSet.shopMoney.amount), 0);
  const prevCount = prevOrders.length;
  const prevAov = prevCount > 0 ? prevRevenue / prevCount : 0;
  const prevNew = prevOrders.filter((o) => o.customer?.numberOfOrders === 1).length;

  return {
    revenue,
    count,
    aov,
    newCustomers,
    prevRevenue,
    prevCount,
    prevAov,
    prevNew,
    revenueDelta: prevRevenue > 0 ? ((revenue - prevRevenue) / prevRevenue) * 100 : null,
    countDelta: prevCount > 0 ? ((count - prevCount) / prevCount) * 100 : null,
    aovDelta: prevAov > 0 ? ((aov - prevAov) / prevAov) * 100 : null,
    newDelta: prevNew > 0 ? ((newCustomers - prevNew) / prevNew) * 100 : null,
    currency: orders[0]?.totalPriceSet?.shopMoney?.currencyCode || "EUR",
  };
}

/**
 * Top N prodotti per fatturato dagli ordini.
 */
export function topProductsByRevenue(orders, n = 20) {
  const map = new Map();
  for (const order of orders) {
    for (const edge of order.lineItems.edges) {
      const item = edge.node;
      const product = item.variant?.product;
      if (!product) continue;
      const id = product.id;
      if (!map.has(id)) {
        map.set(id, {
          id,
          title: product.title,
          vendor: product.vendor,
          revenue: 0,
          units: 0,
        });
      }
      const entry = map.get(id);
      entry.revenue += parseFloat(item.originalTotalSet?.shopMoney?.amount || 0);
      entry.units += item.quantity;
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, n);
}

/**
 * Distribuzione ordini per stato finanziario.
 */
export function ordersByFinancialStatus(orders) {
  const map = new Map();
  for (const o of orders) {
    const s = o.financialStatus || "UNKNOWN";
    map.set(s, (map.get(s) || 0) + 1);
  }
  return Array.from(map.entries()).map(([name, value]) => ({ name: formatStatus(name), value }));
}

export function formatStatus(s) {
  const labels = {
    PAID: "Pagato",
    PENDING: "In attesa",
    REFUNDED: "Rimborsato",
    PARTIALLY_REFUNDED: "Parz. rimborsato",
    AUTHORIZED: "Autorizzato",
    VOIDED: "Annullato",
    PARTIALLY_PAID: "Parz. pagato",
    UNKNOWN: "Sconosciuto",
    UNFULFILLED: "Non evaso",
    FULFILLED: "Evaso",
    PARTIAL: "Parziale",
    RESTOCKED: "Rifornito",
  };
  return labels[s] || s;
}

/**
 * Date helpers
 */
export function getDateRange(preset) {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  let start;
  switch (preset) {
    case "today":
      start = end;
      break;
    case "7d":
      start = daysAgo(7);
      break;
    case "30d":
    default:
      start = daysAgo(30);
      break;
    case "90d":
      start = daysAgo(90);
      break;
    case "year":
      start = `${now.getFullYear()}-01-01`;
      break;
  }
  return { start, end };
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function getPrevPeriod(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  const diff = e - s; // ms
  const prevEnd = new Date(s - 1);
  const prevStart = new Date(prevEnd - diff);
  return {
    start: prevStart.toISOString().slice(0, 10),
    end: prevEnd.toISOString().slice(0, 10),
  };
}

export function formatCurrency(amount, currency = "EUR") {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

export function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
