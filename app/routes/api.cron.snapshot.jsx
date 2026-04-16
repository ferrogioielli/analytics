import { json } from "@remix-run/node";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { fetchProducts } from "../utils/shopify.server";

/**
 * Cron endpoint: salva una fotografia giornaliera dell'inventario
 * (un record per prodotto) in InventorySnapshot.
 *
 * Protetto da CRON_SECRET (env var) — Vercel Cron invia automaticamente
 * l'header `Authorization: Bearer <CRON_SECRET>`.
 *
 * Query params opzionali:
 *   - date=YYYY-MM-DD  override della data snapshot (default: ieri UTC)
 *
 * Il cron gira alle 01:30 UTC ≈ 02:30/03:30 ora italiana (dipende dall'ora legale).
 * Quando gira "oggi mattina UTC", la foto rappresenta lo stato "fine giornata di ieri".
 * Per questo la salviamo con snapshotDate = ieri.
 */
export const loader = async ({ request }) => {
  const authHeader = request.headers.get("Authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const dateOverride = url.searchParams.get("date");

  let snapshotDate;
  if (dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
    snapshotDate = new Date(`${dateOverride}T00:00:00Z`);
  } else {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(0, 0, 0, 0);
    snapshotDate = d;
  }

  // Recupera sessioni uniche per shop (solo offline: hanno accessToken persistente)
  const sessionsRaw = await prisma.session.findMany({
    where: { isOnline: false },
  });
  const shopsSeen = new Set();
  const sessions = sessionsRaw.filter((s) => {
    if (shopsSeen.has(s.shop)) return false;
    shopsSeen.add(s.shop);
    return true;
  });

  const results = [];

  for (const session of sessions) {
    try {
      const { admin } = await unauthenticated.admin(session.shop);
      const products = await fetchProducts(admin);

      const rows = products.map((p) => {
        const edges = p.variants?.edges || [];
        const totalQty = edges.reduce(
          (s, e) => s + (e.node.inventoryQuantity || 0),
          0,
        );
        const stockValueCost = edges.reduce((s, e) => {
          const cost = parseFloat(e.node.inventoryItem?.unitCost?.amount || 0);
          const qty = e.node.inventoryQuantity || 0;
          return s + cost * qty;
        }, 0);
        const stockValueRetail = edges.reduce((s, e) => {
          const price = parseFloat(e.node.price || 0);
          const qty = e.node.inventoryQuantity || 0;
          return s + price * qty;
        }, 0);
        const prices = edges
          .map((e) => parseFloat(e.node.price || 0))
          .filter((v) => Number.isFinite(v));
        const avgPrice =
          prices.length > 0
            ? prices.reduce((s, v) => s + v, 0) / prices.length
            : 0;

        return {
          snapshotDate,
          shop: session.shop,
          productId: p.id,
          title: p.title || "",
          vendor: p.vendor || "",
          productType: p.productType || "",
          tags: p.tags || [],
          status: p.status || "ACTIVE",
          totalQty,
          stockValueCost,
          stockValueRetail,
          avgPrice,
        };
      });

      // Idempotente: sostituisce eventuali righe precedenti per la stessa data+shop
      await prisma.$transaction([
        prisma.inventorySnapshot.deleteMany({
          where: { snapshotDate, shop: session.shop },
        }),
        prisma.inventorySnapshot.createMany({
          data: rows,
        }),
      ]);

      results.push({ shop: session.shop, count: rows.length });
    } catch (err) {
      console.error(`Snapshot error for shop ${session.shop}:`, err);
      results.push({
        shop: session.shop,
        error: err.message || "unknown error",
      });
    }
  }

  return json({
    ok: true,
    date: snapshotDate.toISOString().slice(0, 10),
    results,
  });
};
