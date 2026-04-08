import { useLoaderData } from "@remix-run/react";
import { json } from "@remix-run/node";
import {
  Page, Card, BlockStack, InlineStack, Text, Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchOrders, groupOrdersByDay } from "../utils/shopify.server";
import { formatCurrency, daysAgo } from "../utils/format";

// ─── Regressione lineare ────────────────────────────────────────────────────

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y || 0 };
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const yearStart = `${today.getFullYear()}-01-01`;
  const start90 = daysAgo(90);

  // Ordini anno corrente (per YTD e proiezioni mensili) + ultimi 90gg (per trend)
  const [yearOrders, orders90] = await Promise.all([
    fetchOrders(admin, { startDate: yearStart, endDate: todayStr }),
    fetchOrders(admin, { startDate: start90, endDate: todayStr }),
  ]);

  const currency = yearOrders[0]?.totalPriceSet?.shopMoney?.currencyCode || "EUR";

  // ── Dati anno corrente giornalieri ──────────────────────────────────────────
  const yearDailyMap = new Map();
  for (const d of groupOrdersByDay(yearOrders)) yearDailyMap.set(d.date, d);

  // Riempi tutti i giorni dall'inizio anno ad oggi (gap = 0)
  const allDaysYear = [];
  const cur = new Date(yearStart);
  while (cur <= today) {
    const ds = cur.toISOString().slice(0, 10);
    allDaysYear.push({
      date: ds,
      revenue: yearDailyMap.get(ds)?.revenue || 0,
      orders: yearDailyMap.get(ds)?.orders || 0,
    });
    cur.setDate(cur.getDate() + 1);
  }

  // ── Trend: regressione sugli ultimi 30 giorni ───────────────────────────────
  const last30 = allDaysYear.slice(-30);
  const regPoints = last30.map((d, i) => ({ x: i, y: d.revenue }));
  const { slope, intercept } = linearRegression(regPoints);
  const avgLast30 = last30.reduce((s, d) => s + d.revenue, 0) / last30.length;
  const avgLast7 = allDaysYear.slice(-7).reduce((s, d) => s + d.revenue, 0) / 7;

  // ── Media mobile 7 giorni ───────────────────────────────────────────────────
  const allDaysWithMA = allDaysYear.map((d, i) => {
    const slice = allDaysYear.slice(Math.max(0, i - 6), i + 1);
    const ma7 = slice.reduce((s, x) => s + x.revenue, 0) / slice.length;
    return { ...d, ma7: Math.round(ma7 * 100) / 100 };
  });

  // ── Proiezione prossimi 60 giorni ───────────────────────────────────────────
  const forecastDays = [];
  for (let i = 1; i <= 60; i++) {
    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + i);
    const ds = futureDate.toISOString().slice(0, 10);
    const forecast = Math.max(0, slope * (30 + i) + intercept);
    forecastDays.push({ date: ds, revenue: null, orders: null, ma7: null, forecast: Math.round(forecast * 100) / 100 });
  }

  // Chart data: ultimi 90 giorni + forecast 60 giorni
  const chartStart = start90;
  const chartData = [
    ...allDaysWithMA.filter((d) => d.date >= chartStart).map((d) => ({ ...d, forecast: null })),
    ...forecastDays,
  ];

  // ── KPI ─────────────────────────────────────────────────────────────────────
  const ytdRevenue = allDaysYear.reduce((s, d) => s + d.revenue, 0);

  // Proiezione fine mese corrente
  const dayOfMonth = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysRemainingMonth = daysInMonth - dayOfMonth;
  const mtdRevenue = allDaysYear
    .filter((d) => d.date.startsWith(todayStr.slice(0, 7)))
    .reduce((s, d) => s + d.revenue, 0);
  const projectedRemainingMonth = Array.from({ length: daysRemainingMonth }, (_, i) =>
    Math.max(0, slope * (30 + i + 1) + intercept)
  ).reduce((s, v) => s + v, 0);
  const projectedMonth = mtdRevenue + projectedRemainingMonth;

  // Proiezione anno (YTD + giorni rimanenti)
  const daysInYear = today.getFullYear() % 4 === 0 ? 366 : 365;
  const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
  const daysRemainingYear = daysInYear - dayOfYear;
  const projectedRemainingYear = Array.from({ length: daysRemainingYear }, (_, i) =>
    Math.max(0, slope * (30 + i + 1) + intercept)
  ).reduce((s, v) => s + v, 0);
  const projectedYear = ytdRevenue + projectedRemainingYear;

  // Trend direzione: slope positivo = crescita, negativo = calo
  const trendPct = avgLast30 > 0 ? (slope * 30 / avgLast30) * 100 : 0;

  // ── Riepilogo mensile ────────────────────────────────────────────────────────
  const monthlyMap = new Map();
  for (const d of allDaysYear) {
    const month = d.date.slice(0, 7);
    if (!monthlyMap.has(month)) monthlyMap.set(month, { month, actual: 0, orders: 0, isFuture: false });
    const m = monthlyMap.get(month);
    m.actual += d.revenue;
    m.orders += d.orders;
  }

  // Aggiungi mesi futuri dell'anno
  const currentMonth = todayStr.slice(0, 7);
  for (let m = today.getMonth() + 1; m <= 11; m++) {
    const year = today.getFullYear();
    const monthStr = `${year}-${String(m + 1).padStart(2, "0")}`;
    const daysInM = new Date(year, m + 1, 0).getDate();
    const daysFromNow = Math.floor(
      (new Date(year, m, 1) - today) / 86400000
    );
    const projM = Array.from({ length: daysInM }, (_, i) =>
      Math.max(0, slope * (30 + daysFromNow + i) + intercept)
    ).reduce((s, v) => s + v, 0);
    monthlyMap.set(monthStr, { month: monthStr, actual: 0, orders: 0, projected: projM, isFuture: true });
  }
  // Aggiorna mese corrente con proiezione
  if (monthlyMap.has(currentMonth)) {
    monthlyMap.get(currentMonth).projected = projectedMonth;
  }

  const monthlyData = Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month));

  return json({
    chartData,
    monthlyData,
    avgLast30,
    avgLast7,
    ytdRevenue,
    projectedMonth,
    projectedYear,
    trendPct,
    currency,
    todayStr,
    currentMonth,
  });
};

const MONTH_LABELS = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];

function monthLabel(m) {
  const [, mm] = m.split("-");
  return MONTH_LABELS[parseInt(mm, 10) - 1] || m;
}

function TrendBadge({ pct }) {
  if (Math.abs(pct) < 1) return <Badge>Stabile</Badge>;
  return (
    <Badge tone={pct >= 0 ? "success" : "critical"}>
      {pct >= 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% / mese
    </Badge>
  );
}

function ForecastTooltip({ active, payload, label, currency }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "8px 12px", fontSize: 12 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{label}</p>
      {payload.map((p, i) => p.value != null && (
        <p key={i} style={{ margin: "2px 0", color: p.color }}>
          {p.name}: {typeof p.value === "number" && p.name !== "Ordini" ? formatCurrency(p.value, currency) : p.value}
        </p>
      ))}
    </div>
  );
}

export default function Previsioni() {
  const {
    chartData, monthlyData, avgLast30, avgLast7, ytdRevenue,
    projectedMonth, projectedYear, trendPct, currency, todayStr, currentMonth,
  } = useLoaderData();

  return (
    <Page title="Previsioni">
      <TitleBar title="Previsioni" />
      <BlockStack gap="500">

        {/* ── KPI ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {[
            {
              label: "Media giornaliera (30gg)",
              value: formatCurrency(avgLast30, currency),
              sub: `Ultimi 7gg: ${formatCurrency(avgLast7, currency)}/giorno`,
            },
            {
              label: "Proiezione fine mese",
              value: formatCurrency(projectedMonth, currency),
              sub: "Mese corrente (MTD + forecast)",
              color: "#1E90FF",
            },
            {
              label: "Proiezione anno corrente",
              value: formatCurrency(projectedYear, currency),
              sub: `YTD reale: ${formatCurrency(ytdRevenue, currency)}`,
              color: "#008060",
            },
            {
              label: "Trend",
              sub: "Basato sulla regressione ultimi 30gg",
              badge: <TrendBadge pct={trendPct} />,
            },
          ].map(({ label, value, sub, color, badge }) => (
            <Card key={label}>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                {badge || (
                  <Text as="p" variant="headingLg" fontWeight="bold">
                    <span style={color ? { color } : {}}>{value}</span>
                  </Text>
                )}
                {sub && <Text as="p" variant="bodySm" tone="subdued">{sub}</Text>}
              </BlockStack>
            </Card>
          ))}
        </div>

        {/* ── Grafico trend + forecast ── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Andamento e previsione (ultimi 90gg + prossimi 60gg)</Text>
              <InlineStack gap="300">
                <InlineStack gap="100" blockAlign="center">
                  <div style={{ width: 12, height: 3, background: "#008060", borderRadius: 2 }} />
                  <Text as="span" variant="bodySm" tone="subdued">Fatturato reale</Text>
                </InlineStack>
                <InlineStack gap="100" blockAlign="center">
                  <div style={{ width: 12, height: 3, background: "#FFB400", borderRadius: 2 }} />
                  <Text as="span" variant="bodySm" tone="subdued">Media mobile 7gg</Text>
                </InlineStack>
                <InlineStack gap="100" blockAlign="center">
                  <div style={{ width: 20, height: 3, background: "#1E90FF", borderRadius: 2, borderStyle: "dashed" }} />
                  <Text as="span" variant="bodySm" tone="subdued">Previsione</Text>
                </InlineStack>
              </InlineStack>
            </InlineStack>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d) => d.slice(5)} interval={6} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} width={55} />
                <Tooltip content={<ForecastTooltip currency={currency} />} />
                <ReferenceLine x={todayStr} stroke="#ccc" strokeDasharray="3 3" label={{ value: "Oggi", fontSize: 10, fill: "#999" }} />
                <Bar dataKey="revenue" name="Fatturato" fill="#008060" fillOpacity={0.7} radius={[2, 2, 0, 0]} barSize={4} />
                <Line type="monotone" dataKey="ma7" name="MA 7gg" stroke="#FFB400" dot={false} strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="forecast" name="Previsione" stroke="#1E90FF" dot={false} strokeWidth={2} strokeDasharray="5 5" connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </BlockStack>
        </Card>

        {/* ── Riepilogo mensile ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Riepilogo e proiezioni mensili — {new Date().getFullYear()}</Text>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600 }}>Mese</th>
                    <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 600 }}>Fatturato reale</th>
                    <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 600 }}>Ordini</th>
                    <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 600 }}>Proiezione mese</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600 }}>Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyData.map((m) => {
                    const isCurrent = m.month === currentMonth;
                    const isPast = !m.isFuture && !isCurrent;
                    return (
                      <tr
                        key={m.month}
                        style={{
                          borderBottom: "1px solid #f0f0f0",
                          background: isCurrent ? "#f0f7ff" : "transparent",
                        }}
                      >
                        <td style={{ padding: "8px 12px", fontWeight: isCurrent ? 600 : 400 }}>
                          {monthLabel(m.month)} {m.month.slice(0, 4)}
                        </td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}>
                          {m.actual > 0 ? formatCurrency(m.actual, currency) : <span style={{ color: "#999" }}>—</span>}
                        </td>
                        <td style={{ padding: "8px 12px", textAlign: "right", color: "#666" }}>
                          {m.orders > 0 ? m.orders : "—"}
                        </td>
                        <td style={{ padding: "8px 12px", textAlign: "right", color: m.isFuture || isCurrent ? "#1E90FF" : "#999" }}>
                          {m.projected != null ? formatCurrency(m.projected, currency) : "—"}
                        </td>
                        <td style={{ padding: "8px 12px" }}>
                          {isPast && <Badge tone="success">Chiuso</Badge>}
                          {isCurrent && <Badge tone="info">In corso</Badge>}
                          {m.isFuture && <Badge tone="attention">Previsto</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "2px solid #e1e3e5", fontWeight: 600 }}>
                    <td style={{ padding: "8px 12px" }}>Totale anno</td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>{formatCurrency(ytdRevenue, currency)}</td>
                    <td />
                    <td style={{ padding: "8px 12px", textAlign: "right", color: "#1E90FF" }}>
                      {formatCurrency(projectedYear, currency)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <Text as="p" variant="bodySm" tone="subdued">
              Le previsioni si basano sulla regressione lineare degli ultimi 30 giorni. Fattori stagionali non considerati.
            </Text>
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
