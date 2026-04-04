/**
 * Utility pure (safe per client e server)
 */

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
  const diff = e - s;
  const prevEnd = new Date(s - 1);
  const prevStart = new Date(prevEnd - diff);
  return {
    start: prevStart.toISOString().slice(0, 10),
    end: prevEnd.toISOString().slice(0, 10),
  };
}
