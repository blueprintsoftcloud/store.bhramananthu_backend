import { Request, Response } from "express";
import { User, Product, ProductVariant, Order, OrderItem } from "../models/mongoose";
import logger from "../utils/logger";

// All handlers in this file use native MongoDB aggregation pipelines (via the Mongoose
// models directly, bypassing the Prisma-compatibility bridge) — no collection is ever
// pulled into Node memory to be looped/grouped in JavaScript. Where a handler still does
// a small amount of JS work (e.g. zero-filling missing calendar days for a chart), that
// work is bounded by the requested date range (≤90 entries), never by row count.

const pct = (curr: number, prev: number) => {
  if (prev === 0) return curr === 0 ? 0 : 100;
  return Math.round(((curr - prev) / prev) * 100);
};

const sumOf = (facetBucket: Array<{ sum?: number }>) => facetBucket[0]?.sum ?? 0;
const countOf = (facetBucket: Array<{ n?: number }>) => facetBucket[0]?.n ?? 0;

const parseDateRange = (from?: string, to?: string) => ({
  fromDate: from ? new Date(from) : undefined,
  toDate: to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : undefined,
});

// ── GET /api/analytics/summary ─────────────────────────────────────────────
// Summary stats cards: revenue, orders, customers, products, pending orders.
// 1 Order $facet + 1 User $facet + 1 Product count = 3 round trips (was 11).
export const getSummary = async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);
    const sixtyDaysAgo = new Date(now);
    sixtyDaysAgo.setDate(now.getDate() - 60);

    const [[orderFacets], [userFacets], totalProducts] = await Promise.all([
      Order.aggregate([
        {
          $facet: {
            totalRevenue: [
              { $match: { paymentStatus: "PAID", orderStatus: { $nin: ["CANCELLED", "RETURNED"] } } },
              { $group: { _id: null, sum: { $sum: "$finalAmount" } } },
            ],
            revenueThisMonth: [
              { $match: { paymentStatus: "PAID", orderStatus: { $nin: ["CANCELLED", "RETURNED"] }, createdAt: { $gte: thirtyDaysAgo } } },
              { $group: { _id: null, sum: { $sum: "$finalAmount" } } },
            ],
            revenuePrevMonth: [
              { $match: { paymentStatus: "PAID", orderStatus: { $nin: ["CANCELLED", "RETURNED"] }, createdAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo } } },
              { $group: { _id: null, sum: { $sum: "$finalAmount" } } },
            ],
            totalOrders: [{ $count: "n" }],
            ordersThisMonth: [{ $match: { createdAt: { $gte: thirtyDaysAgo } } }, { $count: "n" }],
            ordersPrevMonth: [
              { $match: { createdAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo } } },
              { $count: "n" },
            ],
            pendingOrders: [{ $match: { orderStatus: "PROCESSING" } }, { $count: "n" }],
          },
        },
      ]),
      User.aggregate([
        { $match: { role: "CUSTOMER" } },
        {
          $facet: {
            total: [{ $count: "n" }],
            thisMonth: [{ $match: { createdAt: { $gte: thirtyDaysAgo } } }, { $count: "n" }],
            prevMonth: [
              { $match: { createdAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo } } },
              { $count: "n" },
            ],
          },
        },
      ]),
      Product.countDocuments(),
    ]);

    const revenueThisMonth = sumOf(orderFacets.revenueThisMonth);
    const revenuePrevMonth = sumOf(orderFacets.revenuePrevMonth);
    const ordersThisMonth = countOf(orderFacets.ordersThisMonth);
    const ordersPrevMonth = countOf(orderFacets.ordersPrevMonth);
    const customersThisMonth = countOf(userFacets.thisMonth);
    const customersPrevMonth = countOf(userFacets.prevMonth);

    res.json({
      revenue: {
        total: sumOf(orderFacets.totalRevenue),
        thisMonth: revenueThisMonth,
        growthPct: pct(revenueThisMonth, revenuePrevMonth),
      },
      orders: {
        total: countOf(orderFacets.totalOrders),
        thisMonth: ordersThisMonth,
        processing: countOf(orderFacets.pendingOrders),
        growthPct: pct(ordersThisMonth, ordersPrevMonth),
      },
      customers: {
        total: countOf(userFacets.total),
        thisMonth: customersThisMonth,
        growthPct: pct(customersThisMonth, customersPrevMonth),
      },
      products: { total: totalProducts },
    });
  } catch (err: any) {
    logger.error("getSummary error", err);
    res.status(500).json({ message: "Error fetching analytics summary" });
  }
};

// ── GET /api/analytics/revenue?days=30 ────────────────────────────────────
// Daily revenue for the last N days — bar/line chart data.
export const getRevenueByDay = async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(parseInt((req.query.days as string) ?? "30") || 30, 1), 90);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await Order.aggregate([
      { $match: { paymentStatus: "PAID", orderStatus: { $nin: ["CANCELLED", "RETURNED"] }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$finalAmount" },
          orders: { $sum: 1 },
        },
      },
    ]);
    const byDate = new Map(rows.map((r) => [r._id as string, r]));

    // Zero-fill missing days so the chart has no gaps — bounded by `days` (≤90), not by order count.
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split("T")[0];
      const row = byDate.get(key);
      result.push({ date: key, revenue: row?.revenue ?? 0, orders: row?.orders ?? 0 });
    }

    res.json(result);
  } catch (err: any) {
    logger.error("getRevenueByDay error", err);
    res.status(500).json({ message: "Error fetching revenue chart data" });
  }
};

// ── GET /api/analytics/order-status?from=YYYY-MM-DD&to=YYYY-MM-DD ─────────
// Count of orders grouped by orderStatus — pie chart data. from/to are optional
// (omitted = all-time, matches prior behavior); Reports & Analytics always passes them
// so this stays consistent with the rest of the page's date-scoped widgets.
export const getOrderStatusBreakdown = async (req: Request, res: Response) => {
  try {
    const statuses = ["PROCESSING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED"] as const;
    const { from, to } = req.query as Record<string, string | undefined>;
    const { fromDate, toDate } = parseDateRange(from, to);
    const dateMatch: Record<string, unknown> = {};
    if (fromDate) dateMatch.$gte = fromDate;
    if (toDate) dateMatch.$lte = toDate;
    const match = fromDate || toDate ? { createdAt: dateMatch } : {};

    const rows = await Order.aggregate([{ $match: match }, { $group: { _id: "$orderStatus", count: { $sum: 1 } } }]);
    const countByStatus = new Map(rows.map((r) => [r._id as string, r.count as number]));

    const result = statuses.map((status) => ({ status, count: countByStatus.get(status) ?? 0 }));
    res.json(result);
  } catch (err: any) {
    logger.error("getOrderStatusBreakdown error", err);
    res.status(500).json({ message: "Error fetching order status breakdown" });
  }
};

// ── GET /api/analytics/top-products?limit=5 ───────────────────────────────
// Top products by total revenue from their order items (all order items, any status —
// matches prior behavior). Revenue is price × quantity, computed in the pipeline (the
// previous implementation summed unit `price` alone, undercounting any line with qty > 1).
export const getTopProducts = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? "5") || 5, 1), 20);

    const result = await OrderItem.aggregate([
      {
        $group: {
          _id: "$productId",
          totalRevenue: { $sum: { $multiply: ["$price", "$quantity"] } },
          totalQuantitySold: { $sum: "$quantity" },
          orderCount: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: limit },
      { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "product" } },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          product: {
            $cond: [
              { $ifNull: ["$product", false] },
              { id: "$product._id", name: "$product.name", price: "$product.price", image: "$product.image" },
              null,
            ],
          },
          totalRevenue: 1,
          totalQuantitySold: 1,
          orderCount: 1,
        },
      },
    ]);

    res.json(result);
  } catch (err: any) {
    logger.error("getTopProducts error", err);
    res.status(500).json({ message: "Error fetching top products" });
  }
};

// ── GET /api/analytics/top-categories?from=YYYY-MM-DD&to=YYYY-MM-DD ───────
// Top categories by revenue through order items. Previously pulled every order item
// ever placed into Node memory (unbounded); now a single pipeline with $lookup + $group.
// from/to are optional — omitted, this is all-time (matches prior behavior).
export const getTopCategories = async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query as Record<string, string | undefined>;
    const { fromDate, toDate } = parseDateRange(from, to);
    const orderDateMatch: Record<string, unknown> = {};
    if (fromDate) orderDateMatch.$gte = fromDate;
    if (toDate) orderDateMatch.$lte = toDate;
    const dateStages =
      fromDate || toDate
        ? [
            { $lookup: { from: "orders", localField: "orderId", foreignField: "_id", as: "order" } },
            { $unwind: "$order" },
            { $match: { "order.createdAt": orderDateMatch } },
          ]
        : [];

    const result = await OrderItem.aggregate([
      ...dateStages,
      { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
      { $unwind: "$product" },
      {
        $group: {
          _id: "$product.categoryId",
          revenue: { $sum: { $multiply: ["$price", "$quantity"] } },
          unitsSold: { $sum: "$quantity" },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 30 },
      { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "category" } },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          id: "$_id",
          name: "$category.name",
          revenue: 1,
          unitsSold: 1,
        },
      },
    ]);

    res.json(result);
  } catch (err: any) {
    logger.error("getTopCategories error", err);
    res.status(500).json({ message: "Error fetching top categories" });
  }
};

// ── GET /api/analytics/profit?from=YYYY-MM-DD&to=YYYY-MM-DD ───────────────
// Profit summary: total revenue, total cost (purchase price), gross profit, margin %.
export const getProfitSummary = async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query as Record<string, string | undefined>;
    const { fromDate, toDate } = parseDateRange(from, to);

    const dateMatch: Record<string, unknown> = {};
    if (fromDate) dateMatch.$gte = fromDate;
    if (toDate) dateMatch.$lte = toDate;
    const orderMatch: Record<string, unknown> = { paymentStatus: "PAID" };
    if (fromDate || toDate) orderMatch.createdAt = dateMatch;

    const costPipelineFor = (match: Record<string, unknown>) => [
      { $lookup: { from: "orders", localField: "orderId", foreignField: "_id", as: "order" } },
      { $unwind: "$order" },
      { $match: match },
      { $lookup: { from: "productvariants", localField: "variantId", foreignField: "_id", as: "variant" } },
      { $unwind: { path: "$variant", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          effectiveUnitCost: {
            $cond: [
              { $gt: ["$variant.purchasePriceOverride", 0] },
              "$variant.purchasePriceOverride",
              {
                $cond: [
                  { $gt: ["$product.purchasePrice", 0] },
                  "$product.purchasePrice",
                  0,
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalCost: {
            $sum: { $multiply: ["$effectiveUnitCost", "$quantity"] },
          },
          itemsWithCost: { $sum: { $cond: [{ $gt: ["$effectiveUnitCost", 0] }, 1, 0] } },
          itemsTotal: { $sum: 1 },
        },
      },
    ];

    const orderMatchKeyed = (m: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [`order.${k}`, v]));

    const [revenueAggArr, [costAgg]] = await Promise.all([
      Order.aggregate([
        { $match: orderMatch },
        { $group: { _id: null, sum: { $sum: "$finalAmount" }, count: { $sum: 1 } } },
      ]),
      OrderItem.aggregate(costPipelineFor(orderMatchKeyed(orderMatch)) as any),
    ]);

    const totalRevenue = revenueAggArr[0]?.sum ?? 0;
    const orderCount = revenueAggArr[0]?.count ?? 0;
    const totalCost = costAgg?.totalCost ?? 0;
    const itemsWithCost = costAgg?.itemsWithCost ?? 0;
    const itemsTotal = costAgg?.itemsTotal ?? 0;

    const grossProfit = totalRevenue - totalCost;
    const marginPct = totalRevenue > 0 ? Math.round((grossProfit / totalRevenue) * 100) : 0;

    // Previous period comparison (same duration, immediately before the range)
    let prevRevenue = 0;
    let prevProfit = 0;
    if (fromDate && toDate) {
      const diffMs = toDate.getTime() - fromDate.getTime();
      const prevFrom = new Date(fromDate.getTime() - diffMs);
      const prevTo = new Date(fromDate.getTime() - 1);
      const prevOrderMatch = { paymentStatus: "PAID", createdAt: { $gte: prevFrom, $lte: prevTo } };

      const [prevRevenueAggArr, [prevCostAgg]] = await Promise.all([
        Order.aggregate([{ $match: prevOrderMatch }, { $group: { _id: null, sum: { $sum: "$finalAmount" } } }]),
        OrderItem.aggregate(costPipelineFor(orderMatchKeyed(prevOrderMatch)) as any),
      ]);
      prevRevenue = prevRevenueAggArr[0]?.sum ?? 0;
      prevProfit = prevRevenue - (prevCostAgg?.totalCost ?? 0);
    }

    res.json({
      revenue: totalRevenue,
      cost: totalCost,
      grossProfit,
      marginPct,
      orderCount,
      coveragePct: itemsTotal > 0 ? Math.round((itemsWithCost / itemsTotal) * 100) : 100,
      growth: {
        revenue: pct(totalRevenue, prevRevenue),
        profit: pct(grossProfit, prevProfit),
      },
    });
  } catch (err: any) {
    logger.error("getProfitSummary error", err);
    res.status(500).json({ message: "Error fetching profit summary" });
  }
};

// ── GET /api/analytics/profit-by-day?from=YYYY-MM-DD&to=YYYY-MM-DD ────────
// Daily revenue vs cost vs profit for chart. Two aggregations (revenue+orders per day
// from Order; cost per day from OrderItem→Order/Product lookups), merged by day key —
// the merge is O(days) (≤90), not O(orders).
export const getProfitByDay = async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query as Record<string, string | undefined>;
    const days = 30;
    const fromDate = from
      ? new Date(from)
      : (() => { const d = new Date(); d.setDate(d.getDate() - days); return d; })();
    const toDate = to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : new Date();

    const [revenueRows, costRows] = await Promise.all([
      Order.aggregate([
        { $match: { paymentStatus: "PAID", createdAt: { $gte: fromDate, $lte: toDate } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$finalAmount" },
            orders: { $sum: 1 },
          },
        },
      ]),
      OrderItem.aggregate([
        { $lookup: { from: "orders", localField: "orderId", foreignField: "_id", as: "order" } },
        { $unwind: "$order" },
        { $match: { "order.paymentStatus": "PAID", "order.createdAt": { $gte: fromDate, $lte: toDate } } },
        { $lookup: { from: "productvariants", localField: "variantId", foreignField: "_id", as: "variant" } },
        { $unwind: { path: "$variant", preserveNullAndEmptyArrays: true } },
        { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            effectiveUnitCost: {
              $cond: [
                { $gt: ["$variant.purchasePriceOverride", 0] },
                "$variant.purchasePriceOverride",
                {
                  $cond: [
                    { $gt: ["$product.purchasePrice", 0] },
                    "$product.purchasePrice",
                    0,
                  ],
                },
              ],
            },
          },
        },
        { $match: { effectiveUnitCost: { $gt: 0 } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$order.createdAt" } },
            cost: { $sum: { $multiply: ["$effectiveUnitCost", "$quantity"] } },
          },
        },
      ]),
    ]);

    const revenueByDate = new Map(revenueRows.map((r) => [r._id as string, r]));
    const costByDate = new Map(costRows.map((r) => [r._id as string, r.cost as number]));

    const diffDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
    const capped = diffDays > 90;
    // When the selected range is longer than 90 days, anchor the shown window to its
    // END (most recent activity) instead of walking forward from the START — a
    // "This Year"-style long range used to silently render its OLDEST 90 days and go
    // blank for everything after, even when the real orders were all near `to`.
    const seriesStart = capped
      ? (() => { const d = new Date(toDate); d.setDate(d.getDate() - 90); return d; })()
      : fromDate;
    const seriesDays = capped ? 90 : diffDays;

    const result = [];
    for (let i = 0; i <= seriesDays; i++) {
      const d = new Date(seriesStart);
      d.setDate(seriesStart.getDate() + i);
      const key = d.toISOString().split("T")[0];
      const revRow = revenueByDate.get(key);
      const revenue = revRow?.revenue ?? 0;
      const cost = costByDate.get(key) ?? 0;
      result.push({ date: key, revenue, cost, profit: revenue - cost, orders: revRow?.orders ?? 0 });
    }

    res.json(result);
  } catch (err: any) {
    logger.error("getProfitByDay error", err);
    res.status(500).json({ message: "Error fetching profit chart data" });
  }
};

// ── GET /api/analytics/top-products-profit?limit=10 ───────────────────────
// Top products by profit margin, restricted to PAID orders (matches prior behavior).
export const getTopProductsByProfit = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? "10") || 10, 1), 50);
    const { from, to } = req.query as Record<string, string | undefined>;
    const { fromDate, toDate } = parseDateRange(from, to);

    const orderDateMatch: Record<string, unknown> = {};
    if (fromDate) orderDateMatch.$gte = fromDate;
    if (toDate) orderDateMatch.$lte = toDate;
    const orderMatch: Record<string, unknown> = { "order.paymentStatus": "PAID" };
    if (fromDate || toDate) orderMatch["order.createdAt"] = orderDateMatch;

    const result = await OrderItem.aggregate([
      { $lookup: { from: "orders", localField: "orderId", foreignField: "_id", as: "order" } },
      { $unwind: "$order" },
      { $match: orderMatch },
      { $lookup: { from: "productvariants", localField: "variantId", foreignField: "_id", as: "variant" } },
      { $unwind: { path: "$variant", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          effectiveUnitCost: {
            $cond: [
              { $gt: ["$variant.purchasePriceOverride", 0] },
              "$variant.purchasePriceOverride",
              {
                $cond: [
                  { $gt: ["$product.purchasePrice", 0] },
                  "$product.purchasePrice",
                  0,
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$productId",
          product: { $first: "$product" },
          totalRevenue: { $sum: { $multiply: ["$price", "$quantity"] } },
          totalQuantitySold: { $sum: "$quantity" },
          orderCount: { $sum: 1 },
          totalCostSum: {
            $sum: { $multiply: ["$effectiveUnitCost", "$quantity"] },
          },
          itemsWithCost: {
            $sum: { $cond: [{ $gt: ["$effectiveUnitCost", 0] }, 1, 0] },
          },
        },
      },
      {
        $addFields: {
          totalCost: {
            $cond: [
              { $gt: ["$itemsWithCost", 0] },
              "$totalCostSum",
              null,
            ],
          },
        },
      },
      {
        $addFields: {
          grossProfit: {
            $cond: [{ $ne: ["$totalCost", null] }, { $subtract: ["$totalRevenue", "$totalCost"] }, null],
          },
        },
      },
      {
        $addFields: {
          marginPct: {
            $cond: [
              { $and: [{ $ne: ["$grossProfit", null] }, { $gt: ["$totalRevenue", 0] }] },
              { $round: [{ $multiply: [{ $divide: ["$grossProfit", "$totalRevenue"] }, 100] }, 0] },
              null,
            ],
          },
        },
      },
      { $sort: { grossProfit: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          product: {
            $cond: [
              { $ifNull: ["$product", false] },
              {
                id: "$product._id",
                name: "$product.name",
                price: "$product.price",
                purchasePrice: "$product.purchasePrice",
                image: "$product.image",
              },
              null,
            ],
          },
          totalRevenue: 1,
          totalQuantitySold: 1,
          orderCount: 1,
          totalCost: 1,
          grossProfit: 1,
          marginPct: 1,
        },
      },
    ]);

    res.json(result);
  } catch (err: any) {
    logger.error("getTopProductsByProfit error", err);
    res.status(500).json({ message: "Error fetching top products by profit" });
  }
};

// ── GET /api/analytics/payment-methods?from=YYYY-MM-DD&to=YYYY-MM-DD ──────
// Breakdown of payment methods (ONLINE vs POD) with revenue.
// from/to are optional — omitted, this is all-time (matches prior behavior).
export const getPaymentMethodBreakdown = async (req: Request, res: Response) => {
  try {
    const methods = ["ONLINE", "POD"] as const;
    const { from, to } = req.query as Record<string, string | undefined>;
    const { fromDate, toDate } = parseDateRange(from, to);
    const dateMatch: Record<string, unknown> = {};
    if (fromDate) dateMatch.$gte = fromDate;
    if (toDate) dateMatch.$lte = toDate;
    const match = fromDate || toDate ? { createdAt: dateMatch } : {};

    const rows = await Order.aggregate([
      { $match: match },
      { $group: { _id: "$paymentMethod", count: { $sum: 1 }, revenue: { $sum: "$finalAmount" } } },
    ]);
    const byMethod = new Map(rows.map((r) => [r._id as string, r]));

    const results = methods.map((method) => ({
      method,
      count: byMethod.get(method)?.count ?? 0,
      revenue: byMethod.get(method)?.revenue ?? 0,
    }));
    res.json(results);
  } catch (err: any) {
    logger.error("getPaymentMethodBreakdown error", err);
    res.status(500).json({ message: "Error fetching payment method data" });
  }
};

// ── GET /api/analytics/summary-with-range?from=YYYY-MM-DD&to=YYYY-MM-DD ───
// Summary stats gated by date range. Same $facet approach as getSummary.
export const getSummaryWithRange = async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query as Record<string, string | undefined>;
    const { fromDate, toDate } = parseDateRange(from, to);

    const dateMatch: Record<string, unknown> = {};
    if (fromDate) dateMatch.$gte = fromDate;
    if (toDate) dateMatch.$lte = toDate;

    let prevMatch: Record<string, unknown> = {};
    let currentMatch: Record<string, unknown> = Object.keys(dateMatch).length ? { createdAt: dateMatch } : {};

    if (fromDate && toDate) {
      const diffMs = toDate.getTime() - fromDate.getTime();
      prevMatch = { createdAt: { $gte: new Date(fromDate.getTime() - diffMs), $lte: new Date(fromDate.getTime() - 1) } };
    } else {
      const now = new Date();
      const thirtyAgo = new Date(); thirtyAgo.setDate(now.getDate() - 30);
      const sixtyAgo = new Date(); sixtyAgo.setDate(now.getDate() - 60);
      prevMatch = { createdAt: { $gte: sixtyAgo, $lte: thirtyAgo } };
      if (!fromDate && !toDate) {
        currentMatch = { createdAt: { $gte: thirtyAgo } };
      }
    }

    const [[orderFacets], [userFacets], totalProducts] = await Promise.all([
      Order.aggregate([
        {
          $facet: {
            totalRevenue: [
              { $match: { paymentStatus: "PAID", ...currentMatch } },
              { $group: { _id: null, sum: { $sum: "$finalAmount" } } },
            ],
            prevRevenue: [
              { $match: { paymentStatus: "PAID", ...prevMatch } },
              { $group: { _id: null, sum: { $sum: "$finalAmount" } } },
            ],
            totalOrders: [{ $match: currentMatch }, { $count: "n" }],
            prevOrders: [{ $match: prevMatch }, { $count: "n" }],
            pendingOrders: [{ $match: { orderStatus: "PROCESSING" } }, { $count: "n" }],
          },
        },
      ]),
      User.aggregate([
        { $match: { role: "CUSTOMER" } },
        {
          $facet: {
            total: [{ $match: currentMatch }, { $count: "n" }],
            prev: [{ $match: prevMatch }, { $count: "n" }],
          },
        },
      ]),
      Product.countDocuments(),
    ]);

    const totalOrders = countOf(orderFacets.totalOrders);
    const prevOrders = countOf(orderFacets.prevOrders);
    const totalCustomers = countOf(userFacets.total);
    const prevCustomers = countOf(userFacets.prev);
    const totalRevenue = sumOf(orderFacets.totalRevenue);
    const prevRevenue = sumOf(orderFacets.prevRevenue);

    res.json({
      revenue: {
        total: totalRevenue,
        growthPct: pct(totalRevenue, prevRevenue),
      },
      orders: {
        total: totalOrders,
        processing: countOf(orderFacets.pendingOrders),
        growthPct: pct(totalOrders, prevOrders),
      },
      customers: {
        total: totalCustomers,
        growthPct: pct(totalCustomers, prevCustomers),
      },
      products: { total: totalProducts },
    });
  } catch (err: any) {
    logger.error("getSummaryWithRange error", err);
    res.status(500).json({ message: "Error fetching summary" });
  }
};

// ── GET /api/analytics/customer-insights?from=YYYY-MM-DD&to=YYYY-MM-DD ────
// New vs returning customers within the range, plus the top spenders. "Returning" means
// the customer has at least one earlier PAID order before the range started — for an
// all-time view (no fromDate) there's no "before", so everyone is counted as new rather
// than guessing a boundary.
export const getCustomerInsights = async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query as Record<string, string | undefined>;
    const { fromDate, toDate } = parseDateRange(from, to);
    const dateMatch: Record<string, unknown> = {};
    if (fromDate) dateMatch.$gte = fromDate;
    if (toDate) dateMatch.$lte = toDate;
    const currentMatch: Record<string, unknown> = { paymentStatus: "PAID", ...(Object.keys(dateMatch).length ? { createdAt: dateMatch } : {}) };

    const perCustomer = await Order.aggregate([
      { $match: currentMatch },
      { $group: { _id: "$userId", ordersInPeriod: { $sum: 1 }, spentInPeriod: { $sum: "$finalAmount" } } },
      ...(fromDate
        ? [
            {
              $lookup: {
                from: "orders",
                let: { uid: "$_id" },
                pipeline: [
                  { $match: { $expr: { $and: [{ $eq: ["$userId", "$$uid"] }, { $eq: ["$paymentStatus", "PAID"] }, { $lt: ["$createdAt", fromDate] }] } } },
                  { $count: "n" },
                ],
                as: "priorOrders",
              },
            },
            { $addFields: { isReturning: { $gt: [{ $size: "$priorOrders" }, 0] } } },
          ]
        : [{ $addFields: { isReturning: false } }]),
      { $sort: { spentInPeriod: -1 } },
    ]);

    const newCount = perCustomer.filter((c) => !c.isReturning).length;
    const returningCount = perCustomer.filter((c) => c.isReturning).length;

    const topCustomerIds = perCustomer.slice(0, 30).map((c) => c._id).filter(Boolean);
    const users = await User.find({ _id: { $in: topCustomerIds } }).select("username email").lean();
    const userById = new Map(users.map((u: any) => [String(u._id), u]));
    const topCustomers = perCustomer.slice(0, 30).map((c) => ({
      id: c._id ? String(c._id) : null,
      username: c._id ? (userById.get(String(c._id)) as any)?.username ?? "Unknown" : "Guest",
      email: c._id ? (userById.get(String(c._id)) as any)?.email ?? "" : "",
      orders: c.ordersInPeriod,
      totalSpent: c.spentInPeriod,
      isReturning: c.isReturning,
    }));

    res.json({ newCount, returningCount, topCustomers });
  } catch (err: any) {
    logger.error("getCustomerInsights error", err);
    res.status(500).json({ message: "Error fetching customer insights" });
  }
};

// ── GET /api/analytics/sales-by-location?from=YYYY-MM-DD&to=YYYY-MM-DD ────
// Revenue by shipping state. from/to optional (all-time when omitted).
export const getSalesByLocation = async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query as Record<string, string | undefined>;
    const { fromDate, toDate } = parseDateRange(from, to);
    const dateMatch: Record<string, unknown> = {};
    if (fromDate) dateMatch.$gte = fromDate;
    if (toDate) dateMatch.$lte = toDate;
    const match: Record<string, unknown> = { paymentStatus: "PAID", ...(Object.keys(dateMatch).length ? { createdAt: dateMatch } : {}) };

    const result = await Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ["$shippingAddress.state", "Unknown"] },
          revenue: { $sum: "$finalAmount" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 30 },
      { $project: { _id: 0, state: "$_id", revenue: 1, orders: 1 } },
    ]);

    res.json(result);
  } catch (err: any) {
    logger.error("getSalesByLocation error", err);
    res.status(500).json({ message: "Error fetching sales by location" });
  }
};

// ── GET /api/analytics/coupon-performance?from=YYYY-MM-DD&to=YYYY-MM-DD ───
// Discount actually given out through orders (not Coupon.usedCount, which is all-time
// and can't be scoped to a date range) — grouped by coupon, plus the overall total.
export const getCouponPerformance = async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query as Record<string, string | undefined>;
    const { fromDate, toDate } = parseDateRange(from, to);
    const dateMatch: Record<string, unknown> = {};
    if (fromDate) dateMatch.$gte = fromDate;
    if (toDate) dateMatch.$lte = toDate;
    const match: Record<string, unknown> = {
      paymentStatus: "PAID",
      couponId: { $ne: null },
      ...(Object.keys(dateMatch).length ? { createdAt: dateMatch } : {}),
    };

    const [byCoupon] = await Order.aggregate([
      { $match: match },
      { $group: { _id: "$couponId", discountGiven: { $sum: "$discountAmount" }, redemptions: { $sum: 1 } } },
      {
        $facet: {
          top: [
            { $sort: { discountGiven: -1 } },
            { $limit: 8 },
            { $lookup: { from: "coupons", localField: "_id", foreignField: "_id", as: "coupon" } },
            { $unwind: { path: "$coupon", preserveNullAndEmptyArrays: true } },
            { $project: { _id: 0, code: { $ifNull: ["$coupon.code", "Deleted coupon"] }, discountGiven: 1, redemptions: 1 } },
          ],
          // Totals cover every coupon used, not just the top 8 shown above.
          totals: [
            { $group: { _id: null, totalDiscountGiven: { $sum: "$discountGiven" }, totalRedemptions: { $sum: "$redemptions" } } },
          ],
        },
      },
    ]);

    res.json({
      totalDiscountGiven: byCoupon.totals[0]?.totalDiscountGiven ?? 0,
      totalRedemptions: byCoupon.totals[0]?.totalRedemptions ?? 0,
      topCoupons: byCoupon.top,
    });
  } catch (err: any) {
    logger.error("getCouponPerformance error", err);
    res.status(500).json({ message: "Error fetching coupon performance" });
  }
};
