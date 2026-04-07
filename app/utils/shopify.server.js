/**
 * Utility per fetch dati da Shopify GraphQL Admin API
 * Tutte le funzioni usano paginazione cursore per gestire cataloghi grandi.
 */

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

const ORDER_FIELDS = `
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

/**
 * Carica tutti gli ordini in un intervallo di date con paginazione.
 */
export async function fetchOrders(admin, { startDate, endDate }) {
  const orders = [];
  let hasNextPage = true;
  let cursor = null;

  const queryFilter = buildDateQuery(startDate, endDate);

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
              ${ORDER_FIELDS}
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
      node.financialStatus = FINANCIAL_STATUS_MAP[node.displayFinancialStatus] || node.displayFinancialStatus || "UNKNOWN";
      node.fulfillmentStatus = FULFILLMENT_STATUS_MAP[node.displayFulfillmentStatus] || node.displayFulfillmentStatus || null;
      return node;
    }));
    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  return orders;
}

function buildDateQuery(startDate, endDate) {
  const parts = [];
  if (startDate) parts.push(`created_at:>='${startDate}'`);
  if (endDate) parts.push(`created_at:<='${endDate}'`);
  return parts.join(" AND ") || undefined;
}

// ─── PRODOTTI ──────────────────────────────────────────────────────────────────

const PRODUCT_FIELDS = `
  id
  title
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
    currency: orders[0]?.totalPriceSet.shopMoney.currencyCode || "EUR",
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
