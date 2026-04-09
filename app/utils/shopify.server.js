/**
 * Utility per fetch dati da Shopify GraphQL Admin API
 * Tutte le funzioni usano paginazione cursore per gestire cataloghi grandi.
 */

// ─── CACHE IN-MEMORY ───────────────────────────────────────────────────────────
// Cache di processo per ridurre le chiamate ripetute a Shopify quando l'utente
// naviga tra le tab. TTL breve (5 min) per restare reattivi a nuovi ordini.
// Nota: in serverless multi-istanza la cache è per-istanza, comunque utile.

const CACHE_TTL_ORDERS_MS  = 5  * 60 * 1000; // 5 min  — ordini (aggiornati spesso)
const CACHE_TTL_STATIC_MS  = 30 * 60 * 1000; // 30 min — prodotti/clienti (cambiano raramente)
const MAX_PAGES = 40; // limite sicurezza: max 10.000 record per fetch
const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > entry.ttl) {
    _cache.delete(key);
    return null;
  }
  return entry.v;
}

function cacheSet(key, value, ttl = CACHE_TTL_ORDERS_MS) {
  _cache.set(key, { t: Date.now(), v: value, ttl });
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
  let pages = 0;

  const queryFilter = buildDateQuery(startDate, endDate);
  const fields = skinny ? ORDER_FIELDS_SKINNY : ORDER_FIELDS_FULL;

  while (hasNextPage && pages < MAX_PAGES) {
    pages++;
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

// ─── SHOPIFYQL ────────────────────────────────────────────────────────────────

/**
 * Esegue una query ShopifyQL e restituisce le righe come array di oggetti.
 * Richiede scope read_analytics.
 */
export async function runShopifyQL(admin, query) {
  const cacheKey = `ql:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const response = await admin.graphql(
    `#graphql
    mutation shopifyqlQuery($query: String!) {
      shopifyqlQuery(query: $query) {
        __typename
        ... on TableResponse {
          tableData {
            rowData
            columns { name dataType }
          }
        }
        parseErrors { code message range { start { line character } end { line character } } }
      }
    }`,
    { variables: { query } },
  );

  const json = await response.json();
  const result = json.data?.shopifyqlQuery;

  if (result?.parseErrors?.length) {
    console.error("ShopifyQL parse errors:", JSON.stringify(result.parseErrors));
    return [];
  }

  const table = result?.tableData;
  if (!table?.columns?.length || !table?.rowData?.length) return [];

  const cols = table.columns.map((c) => c.name);
  const rows = table.rowData.map((row) => {
    const cells = JSON.parse(row);
    const obj = {};
    cols.forEach((col, i) => { obj[col] = cells[i]; });
    return obj;
  });

  cacheSet(cacheKey, rows);
  return rows;
}

/**
 * Snapshot inventario a una data specifica via ShopifyQL.
 * Ritorna { totals, byBrand[] }.
 */
export async function fetchInventorySnapshot(admin, date) {
  const query = `FROM inventory
    SHOW ending_inventory_units, ending_inventory_value, ending_inventory_retail_value
    WHERE inventory_is_tracked = true
    GROUP BY product_vendor WITH TOTALS
    SINCE ${date} UNTIL ${date}
    ORDER BY ending_inventory_value DESC
    LIMIT 1000`;

  const rows = await runShopifyQL(admin, query);
  if (!rows.length) return { totals: { units: 0, costValue: 0, retailValue: 0 }, byBrand: [] };

  const num = (v) => parseFloat(String(v).replace(/[^0-9.\-]/g, "")) || 0;

  // La prima riga con vendor vuoto/null è il totale (WITH TOTALS)
  const totalsRow = rows.find((r) => !r.product_vendor || r.product_vendor === "(not set)");
  const brandRows = rows.filter((r) => r.product_vendor && r.product_vendor !== "(not set)");

  const totals = totalsRow
    ? { units: num(totalsRow.ending_inventory_units), costValue: num(totalsRow.ending_inventory_value), retailValue: num(totalsRow.ending_inventory_retail_value) }
    : {
        units: brandRows.reduce((s, r) => s + num(r.ending_inventory_units), 0),
        costValue: brandRows.reduce((s, r) => s + num(r.ending_inventory_value), 0),
        retailValue: brandRows.reduce((s, r) => s + num(r.ending_inventory_retail_value), 0),
      };

  const byBrand = brandRows.map((r) => ({
    brand: r.product_vendor,
    units: num(r.ending_inventory_units),
    costValue: num(r.ending_inventory_value),
    retailValue: num(r.ending_inventory_retail_value),
  }));

  return { totals, byBrand };
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
  let pages = 0;

  while (hasNextPage && pages < MAX_PAGES) {
    pages++;
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

  cacheSet(cacheKey, products, CACHE_TTL_STATIC_MS);
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
  let pages = 0;

  while (hasNextPage && pages < MAX_PAGES) {
    pages++;
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

  cacheSet(cacheKey, customers, CACHE_TTL_STATIC_MS);
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
