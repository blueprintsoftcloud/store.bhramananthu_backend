import { Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User, Product, ProductVariant, Order, OrderItem, StaffProfile } from "../models/mongoose";
import logger from "../utils/logger";
import { createAuditLog } from "../utils/auditLog";

const calculatePercentage = (current: number, previous: number): number => {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / previous) * 100;
};

const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
};

type DashboardRange = "all" | "30d" | "7d" | "today";

/**
 * Window bounds for the dashboard's range filter. For "all", `windowStart` is undefined
 * (no date filter — a genuine all-time total) and the comparison period is the trailing
 * 30 vs previous 30 days, matching the summary's long-standing default behavior. For the
 * other three ranges, `windowStart` bounds both the headline number and its own
 * previous-equivalent-period comparison (e.g. this 7 days vs the prior 7 days).
 */
const getRangeWindow = (range: DashboardRange) => {
  const now = new Date();
  if (range === "today") {
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    return { windowStart: startOfToday, prevStart: startOfYesterday, prevEnd: startOfToday };
  }
  if (range === "7d") {
    const windowStart = daysAgo(7);
    const prevStart = daysAgo(14);
    return { windowStart, prevStart, prevEnd: windowStart };
  }
  if (range === "30d") {
    const windowStart = daysAgo(30);
    const prevStart = daysAgo(60);
    return { windowStart, prevStart, prevEnd: windowStart };
  }
  // "all" — headline numbers are true all-time totals; comparison still uses 30d vs prev-30d.
  return { windowStart: undefined, prevStart: daysAgo(60), prevEnd: daysAgo(30) };
};

// GET /api/admin/summary  (admin)
export const getAdminSummary = async (req: Request, res: Response) => {
  try {
    const last30 = daysAgo(30);
    const prev30 = daysAgo(60);

    // ── Stats Cards ─────────────────────────────────────────────────────────
    const [
      orderTotal,
      orderCurrent,
      orderPrev,
      userTotal,
      userCurrent,
      userPrev,
      productTotal,
      productCurrent,
      productPrev,
    ] = await Promise.all([
      Order.countDocuments(),
      Order.countDocuments({ createdAt: { $gte: last30 } }),
      Order.countDocuments({ createdAt: { $gte: prev30, $lt: last30 } }),

      User.countDocuments({ role: "CUSTOMER" }),
      User.countDocuments({
        role: "CUSTOMER", createdAt: { $gte: last30 },
      }),
      User.countDocuments({
        role: "CUSTOMER", createdAt: { $gte: prev30, $lt: last30 },
      }),

      Product.countDocuments(),
      Product.countDocuments({ createdAt: { $gte: last30 } }),
      Product.countDocuments({
        createdAt: { $gte: prev30, $lt: last30 },
      }),
    ]);

    // Revenue (sum of finalAmount on PAID orders)
    const revenueAll = await Order.aggregate([
      { $match: { paymentStatus: "PAID" } },
      { $group: { _id: null, total: { $sum: "$finalAmount" } } }
    ]);
    const revenueCurrent = await Order.aggregate([
      { $match: { paymentStatus: "PAID", createdAt: { $gte: last30 } } },
      { $group: { _id: null, total: { $sum: "$finalAmount" } } }
    ]);
    const revenuePrev = await Order.aggregate([
      { $match: { paymentStatus: "PAID", createdAt: { $gte: prev30, $lt: last30 } } },
      { $group: { _id: null, total: { $sum: "$finalAmount" } } }
    ]);

    // ── Sales Chart (last 7 days) — grouped in the database, not in a JS loop over
    // every matching order ────────────────────────────────────────────────────────
    const sevenDaysAgo = daysAgo(7);
    const salesByDateAgg = await Order.aggregate([
      { $match: { paymentStatus: "PAID", createdAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$finalAmount" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const salesChart = salesByDateAgg.map((d: any) => ({ _id: d._id, revenue: d.revenue, orders: d.orders }));

    // ── Latest Orders ────────────────────────────────────────────────────────
    const latestOrders = await Order.find()
      .populate({
        path: 'user',
        select: 'id username email'
      })
      .populate({
        path: 'items',
        populate: {
          path: 'product',
          select: 'id name price image'
        }
      })
      .sort({ createdAt: -1 })
      .limit(10);

    res.status(200).json({
      summary: {
        revenue: {
          total: revenueAll[0]?.total ?? 0,
          growth: calculatePercentage(
            revenueCurrent[0]?.total ?? 0,
            revenuePrev[0]?.total ?? 0,
          ),
        },
        orders: {
          total: orderTotal,
          growth: calculatePercentage(orderCurrent, orderPrev),
        },
        users: {
          total: userTotal,
          growth: calculatePercentage(userCurrent, userPrev),
        },
        products: {
          total: productTotal,
          growth: calculatePercentage(productCurrent, productPrev),
        },
      },
      salesChart,
      latestOrders,
    });
  } catch (err: any) {
    logger.error("getAdminSummary error", err);
    res.status(500).json({ message: "Error loading dashboard data" });
  }
};

// GET /api/admin/dashboard?range=all|30d|7d|today  (admin) — full live snapshot for dashboard home
export const getDashboardData = async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const sevenDaysAgo = daysAgo(7);
    const thirtyDaysAgo = daysAgo(30);
    const sixtyDaysAgo = daysAgo(60);

    const requestedRange = req.query.range as string | undefined;
    const validRanges: DashboardRange[] = ["all", "30d", "7d", "today"];
    const range: DashboardRange = validRanges.includes(requestedRange as DashboardRange)
      ? (requestedRange as DashboardRange)
      : "all";
    const { windowStart, prevStart, prevEnd } = getRangeWindow(range);
    // Today's actual calendar-day boundary — independent of the `range` filter above.
    // The "Daily Orders"/"Daily Revenue" cards need this regardless of what range the
    // rest of the dashboard is scoped to; "thisMonth" below never means "today" (it's
    // either a 30-day window or a duplicate of "total", see the comment below it).
    const { windowStart: startOfToday } = getRangeWindow("today");

    // "total" is a true all-time figure only when range === "all"; otherwise it's bounded
    // by the same window as "thisMonth" below (the two cards read as one number in the UI
    // for every range except "all", where they intentionally differ — see getRangeWindow).
    const totalDateFilter = range === "all" ? {} : { createdAt: { $gte: windowStart } };
    const windowDateFilter = range === "all" ? { createdAt: { $gte: thirtyDaysAgo } } : totalDateFilter;
    const prevDateFilter = { createdAt: { $gte: prevStart, $lt: prevEnd } };
    const todayDateFilter = { createdAt: { $gte: startOfToday } };
    // Same window as totalDateFilter, but keyed for a $match stage running after an
    // OrderItem→Order $lookup/$unwind (categoryRevenue/topProductItems below), where the
    // order's own createdAt lives under "order.createdAt" instead of "createdAt".
    const orderDateMatch = range === "all" ? {} : { "order.createdAt": { $gte: windowStart } };

    const [
      // Summary stats
      totalRevenueAgg,
      thisMonthRevenueAgg,
      prevMonthRevenueAgg,
      totalOrders,
      thisMonthOrders,
      prevMonthOrders,
      todayRevenueAgg,
      todayOrders,
      pendingOrders,
      totalCustomers,
      thisMonthCustomers,
      prevMonthCustomers,
      totalProducts,
      // Sales chart last 7 days — grouped in the database
      salesByDateAgg,
      // Order status counts
      processingCount,
      confirmedCount,
      shippedCount,
      deliveredCount,
      cancelledCount,
      returnedCount,
      // Low stock products
      lowStockProducts,
      // Recent orders
      recentOrders,
      // Payment methods
      onlineAgg,
      codAgg,
      // Category revenue breakdown
      categoryRevenue,
      // Top products
      topProductItems,
    ] = await Promise.all([
      Order.aggregate([{ $match: { paymentStatus: "PAID", ...totalDateFilter } }, { $group: { _id: null, total: { $sum: "$finalAmount" } } }]),
      Order.aggregate([{ $match: { paymentStatus: "PAID", ...windowDateFilter } }, { $group: { _id: null, total: { $sum: "$finalAmount" } } }]),
      Order.aggregate([{ $match: { paymentStatus: "PAID", ...prevDateFilter } }, { $group: { _id: null, total: { $sum: "$finalAmount" } } }]),
      Order.countDocuments(totalDateFilter),
      Order.countDocuments(windowDateFilter),
      Order.countDocuments(prevDateFilter),
      Order.aggregate([{ $match: { paymentStatus: "PAID", ...todayDateFilter } }, { $group: { _id: null, total: { $sum: "$finalAmount" } } }]),
      Order.countDocuments(todayDateFilter),
      Order.countDocuments({ orderStatus: "PROCESSING" }),
      User.countDocuments({ role: "CUSTOMER", ...totalDateFilter }),
      User.countDocuments({ role: "CUSTOMER", ...windowDateFilter }),
      User.countDocuments({ role: "CUSTOMER", ...prevDateFilter }),
      Product.countDocuments(),
      // Last 7 days revenue chart — grouped by day in the database, not by fetching
      // every matching order into Node and looping.
      Order.aggregate([
        { $match: { paymentStatus: "PAID", createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$finalAmount" },
            orders: { $sum: 1 },
          },
        },
      ]),
      // Order status breakdown
      Order.countDocuments({ orderStatus: "PROCESSING" }),
      Order.countDocuments({ orderStatus: "CONFIRMED" }),
      Order.countDocuments({ orderStatus: "SHIPPED" }),
      Order.countDocuments({ orderStatus: "DELIVERED" }),
      Order.countDocuments({ orderStatus: "CANCELLED" }),
      Order.countDocuments({ orderStatus: "RETURNED" }),
      // Low stock: products with stock <= 10, ordered by stock asc
      Product.find({ stock: { $lte: 10 } })
        .select('id name stock image')
        .populate('categoryId', 'name')
        .sort({ stock: 1 })
        .limit(50),
      // Recent orders
      Order.find()
        .select('id finalAmount orderStatus paymentStatus paymentMethod createdAt shippingAddress')
        .populate('userId', 'username email')
        .sort({ createdAt: -1 })
        .limit(20),
      // Payment methods — now scoped to the selected range, same as the summary cards.
      Order.aggregate([{ $match: { paymentMethod: "ONLINE", ...totalDateFilter } }, { $group: { _id: null, total: { $sum: "$finalAmount" }, count: { $sum: 1 } } }]),
      Order.aggregate([{ $match: { paymentMethod: "POD", ...totalDateFilter } }, { $group: { _id: null, total: { $sum: "$finalAmount" }, count: { $sum: 1 } } }]),
      // Category revenue — a single aggregation pipeline joining OrderItem → Order (to
      // filter PAID + the selected date range) → Product → Category and grouping by
      // category, replacing what used to be up to 5,000 orders and 50,000 order items
      // pulled into Node memory and reduced with a JS loop.
      OrderItem.aggregate([
        { $lookup: { from: "orders", localField: "orderId", foreignField: "_id", as: "order" } },
        { $unwind: "$order" },
        { $match: { "order.paymentStatus": "PAID", ...orderDateMatch } },
        { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
        { $unwind: "$product" },
        {
          $group: {
            _id: "$product.categoryId",
            revenue: { $sum: { $multiply: ["$price", "$quantity"] } },
            unitsSold: { $sum: "$quantity" },
          },
        },
        { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "category" } },
        { $unwind: "$category" },
        { $project: { _id: 0, id: "$_id", name: "$category.name", revenue: 1, unitsSold: 1 } },
        { $sort: { revenue: -1 } },
        { $limit: 20 },
      ]),
      // Top products by revenue — also scoped to PAID + the selected range now (previously
      // matched on OrderItem directly with no join at all, so it silently counted items
      // from every order regardless of payment status or date).
      OrderItem.aggregate([
        { $lookup: { from: "orders", localField: "orderId", foreignField: "_id", as: "order" } },
        { $unwind: "$order" },
        { $match: { "order.paymentStatus": "PAID", ...orderDateMatch } },
        { $group: { _id: "$productId", totalPrice: { $sum: { $multiply: ["$price", "$quantity"] } }, totalQuantity: { $sum: "$quantity" } } },
        { $sort: { totalPrice: -1 } },
        { $limit: 20 }
      ]),
    ]);

    // ── Sales chart (last 7 days) — fill the fixed 7-day skeleton (constant-size loop,
    // not proportional to order volume) with the per-day totals the database already
    // grouped above. ──────────────────────────────────────────────────────────────
    const salesByDate: Record<string, { date: string; revenue: number; orders: number }> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = d.toISOString().split("T")[0];
      salesByDate[key] = { date: key, revenue: 0, orders: 0 };
    }
    for (const day of salesByDateAgg) {
      if (salesByDate[day._id]) {
        salesByDate[day._id].revenue = day.revenue;
        salesByDate[day._id].orders = day.orders;
      }
    }

    // Category breakdown is now computed entirely in the database (see the
    // OrderItem.aggregate pipeline above) — already sorted and limited to 6.
    const topCategories = categoryRevenue;

    // ── Resolve top product names ──────────────────────────────────────────
    const productIds = topProductItems.map((i: any) => i._id);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('id name price image');
    const productMap = Object.fromEntries(products.map((p: any) => [p.id, p]));
    const topProducts = topProductItems.map((item: any) => ({
      product: productMap[item._id] ?? null,
      totalRevenue: item.totalPrice ?? 0,
      totalQuantitySold: item.totalQuantity ?? 0,
    }));

    const pct = (curr: number, prev: number) => {
      if (prev === 0) return curr === 0 ? 0 : 100;
      return Math.round(((curr - prev) / prev) * 100);
    };

    let returningData: { orders: any[]; stats: any } = {
      orders: [],
      stats: { totalOrders: 0, totalRevenue: 0, uniqueCustomersCount: 0, averageOrderValue: 0, monthLabel: "This Month" },
    };
    try {
      returningData = await fetchReturningCustomerOrdersData({ limit: 5 });
    } catch (retErr) {
      logger.warn("getDashboardData: returningCustomerOrders failed, falling back to empty", retErr);
    }

    res.json({
      summary: {
        revenue: {
          total: totalRevenueAgg[0]?.total ?? 0,
          thisMonth: thisMonthRevenueAgg[0]?.total ?? 0,
          today: todayRevenueAgg[0]?.total ?? 0,
          growthPct: pct(thisMonthRevenueAgg[0]?.total ?? 0, prevMonthRevenueAgg[0]?.total ?? 0),
        },
        orders: {
          total: totalOrders,
          thisMonth: thisMonthOrders,
          today: todayOrders,
          pending: pendingOrders,
          growthPct: pct(thisMonthOrders, prevMonthOrders),
        },
        customers: {
          total: totalCustomers,
          thisMonth: thisMonthCustomers,
          growthPct: pct(thisMonthCustomers, prevMonthCustomers),
        },
        products: { total: totalProducts },
      },
      salesChart: Object.values(salesByDate),
      orderStatus: [
        { status: "PROCESSING", count: processingCount },
        { status: "CONFIRMED", count: confirmedCount },
        { status: "SHIPPED", count: shippedCount },
        { status: "DELIVERED", count: deliveredCount },
        { status: "CANCELLED", count: cancelledCount },
        { status: "RETURNED", count: returnedCount },
      ].filter((s) => s.count > 0),
      topCategories,
      topProducts,
      lowStockProducts,
      recentOrders,
      returningCustomerOrders: returningData.orders,
      returningCustomerStats: returningData.stats,
      paymentMethods: [
        { method: "ONLINE", count: onlineAgg[0]?.count ?? 0, revenue: onlineAgg[0]?.total ?? 0 },
        { method: "COD", count: codAgg[0]?.count ?? 0, revenue: codAgg[0]?.total ?? 0 },
      ],
    });
  } catch (err: any) {
    logger.error("getDashboardData error", err);
    res.status(500).json({ message: "Error loading dashboard snapshot" });
  }
};

// GET /api/admin/users?page=1&limit=20  (admin)
export const getAllUsers = async (req: Request, res: Response) => {
  try {
    const { page = "1", limit = "20", role, search } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "20") || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;

    // SUPER_ADMIN is always excluded — Admin is unaware of Super Admin's presence.
    // If a role filter is provided, respect it but never expose SUPER_ADMIN.
    const allowedRoles: ("CUSTOMER" | "ADMIN")[] = ["CUSTOMER", "ADMIN"];
    const requestedRole = role?.toUpperCase() as "CUSTOMER" | "ADMIN" | undefined;
    const where: any =
      requestedRole && allowedRoles.includes(requestedRole)
        ? { role: requestedRole }
        : { role: { $in: allowedRoles } };

    if (search && search.trim() !== "") {
      const regex = new RegExp(search.trim(), "i");
      where.$or = [
        { username: regex },
        { email: regex },
        { phone: regex },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(where)
        .select('id username email phone role createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize),
      User.countDocuments(where),
    ]);

    res.json({
      users,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getAllUsers error", err);
    res.status(500).json({ message: "Error fetching users" });
  }
};

// POST /api/admin/users  (admin)
export const createAdminUser = async (req: Request, res: Response) => {
  try {
    const { username, phone, password, role } = req.body as {
      username: string;
      email: string;
      phone: string;
      password: string;
      role: string;
    };
    // Normalize once — emails are matched/stored case-insensitively everywhere.
    const email: string = String(req.body.email).trim().toLowerCase();

    const emailExisted = await User.findOne({ email });
    if (emailExisted)
      return res.status(400).json({ Error: "An account with this email address already exists." });

    const phoneExisted = await User.findOne({ phone });
    if (phoneExisted)
      return res.status(400).json({ Error: "An account with this phone number already exists." });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Admin cannot create another SUPER_ADMIN through this endpoint
    if (role.toUpperCase() === "SUPER_ADMIN" && req.user?.role !== "SUPER_ADMIN") {
      return res.status(403).json({ message: "Cannot create a Super Admin account via this endpoint." });
    }

    const normalizedRole = role.toUpperCase() as "CUSTOMER" | "ADMIN" | "SUPER_ADMIN";

    await User.create({
      username,
      email,
      phone,
      password: hashedPassword,
      role: normalizedRole,
      isVerified: true,
    });

    await createAuditLog({ req, action: "CREATE_USER", entity: "User", details: { username, email, role: normalizedRole } });
    res.json({ message: `User created successfully with role: ${normalizedRole}.` });
  } catch (err: any) {
    logger.error("createAdminUser error", err);
    if (err?.code === "P2002") {
      const field = err?.meta?.target?.includes("email") ? "email address" : "phone number";
      return res.status(400).json({ Error: `An account with this ${field} already exists.` });
    }
    res
      .status(500)
      .json({ message: "Error in creating user", Error: err.message });
  }
};

// PATCH /api/admin/users/:id  (admin)
export const updateUser = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { username, phone } = req.body as {
      username?: string;
      email?: string;
      phone?: string;
    };
    // Normalize once — emails are matched/stored case-insensitively everywhere.
    const email: string | undefined = req.body.email !== undefined
      ? (req.body.email ? String(req.body.email).trim().toLowerCase() : req.body.email)
      : undefined;

    const existing = await User.findById(id).select('id role');
    if (!existing) return res.status(404).json({ message: "User not found." });
    if (existing.role === "SUPER_ADMIN") {
      return res.status(403).json({ message: "Cannot modify a Super Admin account." });
    }

    // Check uniqueness conflicts
    if (email || phone) {
      const orConditions: any[] = [];
      if (email) orConditions.push({ email });
      if (phone) orConditions.push({ phone });
      const conflict = await User.findOne({
        _id: { $ne: id },
        $or: orConditions
      }).select('id');
      if (conflict) {
        return res.status(400).json({ message: "Email or phone already in use by another account." });
      }
    }

    const updated = await User.findByIdAndUpdate(
      id,
      {
        ...(username !== undefined && { username }),
        ...(email !== undefined && { email }),
        ...(phone !== undefined && { phone }),
      },
      { new: true }
    ).select('id username email phone role');

    await createAuditLog({
      req,
      action: "UPDATE_USER",
      entity: "User",
      entityId: id,
      details: { username, email, phone },
    });

    return res.json({ message: "User updated successfully.", user: updated });
  } catch (err: any) {
    logger.error("updateUser error", err);
    return res.status(500).json({ message: "Error updating user." });
  }
};

// DELETE /api/admin/users/:id  (admin)
export const deleteUser = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const target = await User.findById(id).select('id role');
    if (!target) return res.status(404).json({ message: "User not found." });
    if (target.role === "SUPER_ADMIN") {
      return res.status(403).json({ message: "Cannot delete a Super Admin account." });
    }
    if (req.user?.id === id) {
      return res.status(400).json({ message: "You cannot delete your own account." });
    }

    if (target.role === "ADMIN") {
      // Find all staff profiles managed by this admin
      const staffProfiles = await StaffProfile.find({ managedBy: id });
      const staffUserIds = staffProfiles.map((sp) => sp.userId);

      // Delete staff profiles
      await StaffProfile.deleteMany({ managedBy: id });

      // Delete staff users
      if (staffUserIds.length > 0) {
        await User.deleteMany({ _id: { $in: staffUserIds } });
      }
    }

    await User.findByIdAndDelete(id);
    await createAuditLog({ req, action: "DELETE_USER", entity: "User", entityId: id, details: { role: target.role } });
    return res.json({ message: "User deleted successfully." });
  } catch (err: any) {
    logger.error("deleteUser error", err);
    return res.status(500).json({ message: "Error deleting user." });
  }
};

// ── Returning / Previous Customer Orders Query Helper ───────────────────────────
export interface ReturningCustomerOrdersQueryOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  paymentMethod?: string;
  sortBy?: "newest" | "oldest" | "amount_desc" | "amount_asc" | "prior_desc";
  month?: number;
  year?: number;
  from?: string;
  to?: string;
}

export const fetchReturningCustomerOrdersData = async (options: ReturningCustomerOrdersQueryOptions = {}) => {
  const now = new Date();
  let windowStart: Date;
  let windowEnd: Date;

  if (options.from || options.to) {
    windowStart = options.from ? new Date(options.from) : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    windowEnd = options.to ? new Date(options.to) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (options.year && options.month) {
    windowStart = new Date(options.year, options.month - 1, 1, 0, 0, 0, 0);
    windowEnd = new Date(options.year, options.month, 0, 23, 59, 59, 999);
  } else {
    // Current calendar month (1st of month to end of month)
    windowStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  const monthLabel = windowStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // 1. Genuine returning customers:
  // Must have ordered strictly prior to windowStart
  const priorCustomerIds = await Order.distinct("userId", {
    userId: { $ne: null },
    createdAt: { $lt: windowStart },
  });

  // AND must have placed order(s) within the current month window
  const returningUserIds = await Order.distinct("userId", {
    userId: { $in: priorCustomerIds },
    createdAt: { $gte: windowStart, $lte: windowEnd },
  });

  if (returningUserIds.length === 0) {
    return {
      customers: [],
      orders: [],
      stats: {
        totalReturningCustomers: 0,
        totalThisMonthQty: 0,
        totalThisMonthRevenue: 0,
        totalPriorQty: 0,
        totalLifetimeQty: 0,
        monthLabel,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        totalOrders: 0,
        totalRevenue: 0,
        uniqueCustomersCount: 0,
        averageOrderValue: 0,
      },
      pagination: {
        page: 1,
        limit: options.limit || 20,
        total: 0,
        totalPages: 1,
      },
    };
  }

  // Fetch all orders for all returning customers across all time
  const allOrders = await Order.find({
    userId: { $in: returningUserIds }
  }).sort({ createdAt: -1 }).lean();

  const allOrderIds = allOrders.map((o: any) => o._id);
  const orderItems = await OrderItem.find({
    orderId: { $in: allOrderIds }
  })
    .populate("productId", "name image code price basePrice")
    .populate("variantId", "options priceOverride sku")
    .lean();

  // Index items by orderId with clear bottle and pack counts
  const itemsByOrderId = new Map<string, any[]>();
  for (const it of orderItems) {
    const oid = String(it.orderId);
    if (!itemsByOrderId.has(oid)) itemsByOrderId.set(oid, []);
    const v = it.variantId as any;
    const optStr = v?.options ? Object.values(v.options).join(", ") : "";
    const qty = it.quantity || 1;
    const matchBottles = (optStr || "").match(/(\d+)\s*Bottle/i);
    const bottlesPerPack = matchBottles ? parseInt(matchBottles[1], 10) : 1;
    const totalBottles = qty * bottlesPerPack;

    let friendlyLabel = "";
    if (bottlesPerPack === 1) {
      friendlyLabel = qty === 1 ? "1 Bottle" : `${qty} Bottles`;
    } else {
      friendlyLabel = qty === 1
        ? `1 Pack of ${bottlesPerPack} Bottles (${bottlesPerPack} bottles)`
        : `${qty} Packs of ${bottlesPerPack} Bottles (${totalBottles} bottles total)`;
    }

    itemsByOrderId.get(oid)!.push({
      ...it,
      variantName: optStr || (it.productId as any)?.name || "Standard",
      quantity: qty,
      bottlesPerPack,
      totalBottles,
      friendlyLabel,
    });
  }

  // Fetch user profiles
  const users = await User.find({ _id: { $in: returningUserIds } })
    .select("username email phone avatar role")
    .lean();
  const userMap = new Map<string, any>(users.map((u: any) => [String(u._id), u]));

  // Group orders by user
  const ordersByUser = new Map<string, any[]>();
  for (const o of allOrders) {
    const uid = String(o.userId);
    if (!ordersByUser.has(uid)) ordersByUser.set(uid, []);
    ordersByUser.get(uid)!.push(o);
  }

  let overallNewPacks = 0;
  let overallNewBottles = 0;
  let overallNewRevenue = 0;
  let overallPriorPacks = 0;
  let overallPriorBottles = 0;
  let overallLifetimeBottles = 0;

  const customerRows: any[] = [];

  for (const uid of returningUserIds.map((id: any) => String(id))) {
    const user = userMap.get(uid);
    const userOrders = ordersByUser.get(uid) || [];

    const monthlyMap = new Map<string, {
      month: string;
      isThisMonth: boolean;
      packs: number;
      bottles: number;
      quantity: number;
      amount: number;
      orderCount: number;
      items: string[];
      orders: any[];
    }>();

    let userPriorPacks = 0;
    let userPriorBottles = 0;
    let userPriorSpend = 0;
    let userThisMonthPacks = 0;
    let userThisMonthBottles = 0;
    let userThisMonthSpend = 0;
    const thisMonthOrders: any[] = [];

    for (const o of userOrders) {
      const d = new Date(o.createdAt);
      const mKey = d.toLocaleString("en-US", { month: "short", year: "numeric" });
      const isThisMonth = d >= windowStart && d <= windowEnd;
      const items = itemsByOrderId.get(String(o._id)) || [];
      const orderPacks = items.reduce((sum: number, it: any) => sum + (it.quantity || 1), 0);
      const orderBottles = items.reduce((sum: number, it: any) => sum + (it.totalBottles || it.quantity || 1), 0);

      if (!monthlyMap.has(mKey)) {
        monthlyMap.set(mKey, {
          month: mKey,
          isThisMonth,
          packs: 0,
          bottles: 0,
          quantity: 0,
          amount: 0,
          orderCount: 0,
          items: [],
          orders: [],
        });
      }

      const mEntry = monthlyMap.get(mKey)!;
      mEntry.packs += orderPacks;
      mEntry.bottles += orderBottles;
      mEntry.quantity += orderBottles;
      mEntry.amount += (o.finalAmount || 0);
      mEntry.orderCount += 1;
      for (const it of items) {
        mEntry.items.push(it.friendlyLabel);
      }
      mEntry.orders.push({
        id: o._id,
        _id: o._id,
        orderStatus: o.orderStatus,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        finalAmount: o.finalAmount,
        createdAt: o.createdAt,
        items,
        shippingAddress: o.shippingAddress,
        deliveryPartnerName: o.deliveryPartnerName,
        trackingId: o.trackingId,
        trackingLink: o.trackingLink,
        packs: orderPacks,
        bottles: orderBottles,
      });

      if (isThisMonth) {
        userThisMonthPacks += orderPacks;
        userThisMonthBottles += orderBottles;
        userThisMonthSpend += (o.finalAmount || 0);
        thisMonthOrders.push({
          id: o._id,
          _id: o._id,
          orderStatus: o.orderStatus,
          paymentStatus: o.paymentStatus,
          paymentMethod: o.paymentMethod,
          finalAmount: o.finalAmount,
          createdAt: o.createdAt,
          items,
          shippingAddress: o.shippingAddress,
          deliveryPartnerName: o.deliveryPartnerName,
          trackingId: o.trackingId,
          trackingLink: o.trackingLink,
          packs: orderPacks,
          bottles: orderBottles,
          quantity: orderBottles,
        });
      } else {
        userPriorPacks += orderPacks;
        userPriorBottles += orderBottles;
        userPriorSpend += (o.finalAmount || 0);
      }
    }

    overallNewPacks += userThisMonthPacks;
    overallNewBottles += userThisMonthBottles;
    overallNewRevenue += userThisMonthSpend;
    overallPriorPacks += userPriorPacks;
    overallPriorBottles += userPriorBottles;
    overallLifetimeBottles += (userPriorBottles + userThisMonthBottles);

    const allMonthlyHistory = Array.from(monthlyMap.values());
    const priorMonthsBreakdown = allMonthlyHistory.filter((m) => !m.isThisMonth);
    const latestOrder = thisMonthOrders[0] || userOrders[0];

    const customerObj = {
      _id: uid,
      id: uid,
      username: user?.username || latestOrder?.shippingAddress?.name || "Customer",
      phone: user?.phone || latestOrder?.shippingAddress?.phone || "N/A",
      email: user?.email || "No email",
      city: latestOrder?.shippingAddress?.city || "N/A",
      state: latestOrder?.shippingAddress?.state || "N/A",
      address: latestOrder?.shippingAddress,
    };

    customerRows.push({
      userId: uid,
      customer: customerObj,
      latestOrder: {
        ...latestOrder,
        user: customerObj,
      },
      thisMonthOrders,
      thisMonthOrdersCount: thisMonthOrders.length,
      thisMonthPacks: userThisMonthPacks,
      thisMonthBottles: userThisMonthBottles,
      thisMonthQty: userThisMonthBottles,
      thisMonthSpend: Math.round(userThisMonthSpend),
      priorTotalPacks: userPriorPacks,
      priorTotalBottles: userPriorBottles,
      priorTotalQty: userPriorBottles,
      priorTotalSpend: Math.round(userPriorSpend),
      priorMonthsBreakdown,
      lifetimeTotalPacks: userPriorPacks + userThisMonthPacks,
      lifetimeTotalBottles: userPriorBottles + userThisMonthBottles,
      lifetimeTotalQty: userPriorBottles + userThisMonthBottles,
      lifetimeTotalSpend: Math.round(userPriorSpend + userThisMonthSpend),
      allMonthlyHistory,
    });
  }

  // Filter by search query if present
  let filteredRows = customerRows;
  if (options.search && options.search.trim()) {
    const q = options.search.trim().toLowerCase();
    filteredRows = customerRows.filter((r) => {
      const c = r.customer;
      return (
        c.username?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.city?.toLowerCase().includes(q) ||
        c.state?.toLowerCase().includes(q) ||
        String(r.latestOrder?.id || "").toLowerCase().includes(q)
      );
    });
  }

  // Sort by latest order date descending
  filteredRows.sort((a, b) => {
    const dateA = new Date(a.latestOrder?.createdAt || 0).getTime();
    const dateB = new Date(b.latestOrder?.createdAt || 0).getTime();
    return dateB - dateA;
  });

  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.max(1, Number(options.limit) || 20);
  const skip = (page - 1) * limit;
  const paginatedRows = filteredRows.slice(skip, skip + limit);

  // Backward-compatible orders list
  const enrichedOrders = paginatedRows.map((r) => ({
    id: r.latestOrder.id,
    _id: r.latestOrder.id,
    finalAmount: r.latestOrder.finalAmount,
    totalAmount: r.latestOrder.finalAmount,
    orderStatus: r.latestOrder.orderStatus,
    paymentStatus: r.latestOrder.paymentStatus,
    paymentMethod: r.latestOrder.paymentMethod,
    shippingAddress: r.latestOrder.shippingAddress,
    deliveryPartnerName: r.latestOrder.deliveryPartnerName,
    trackingId: r.latestOrder.trackingId,
    trackingLink: r.latestOrder.trackingLink,
    createdAt: r.latestOrder.createdAt,
    user: r.customer,
    customer: r.customer,
    items: r.latestOrder.items || [],
    itemsCount: r.thisMonthBottles,
    thisMonthPacks: r.thisMonthPacks,
    thisMonthBottles: r.thisMonthBottles,
    thisMonthQty: r.thisMonthBottles,
    thisMonthSpend: r.thisMonthSpend,
    priorTotalPacks: r.priorTotalPacks,
    priorTotalBottles: r.priorTotalBottles,
    priorTotalQty: r.priorTotalBottles,
    priorTotalSpend: r.priorTotalSpend,
    priorMonthsBreakdown: r.priorMonthsBreakdown,
    lifetimeTotalPacks: r.lifetimeTotalPacks,
    lifetimeTotalBottles: r.lifetimeTotalBottles,
    lifetimeTotalQty: r.lifetimeTotalBottles,
    lifetimeTotalSpend: r.lifetimeTotalSpend,
    allMonthlyHistory: r.allMonthlyHistory,
    allThisMonthOrders: r.thisMonthOrders,
    isReturningCustomer: true,
  }));

  const stats = {
    totalReturningCustomers: customerRows.length,
    totalThisMonthBottles: overallNewBottles,
    totalThisMonthPacks: overallNewPacks,
    totalThisMonthQty: overallNewBottles,
    totalThisMonthRevenue: Math.round(overallNewRevenue),
    totalPriorBottles: overallPriorBottles,
    totalPriorQty: overallPriorBottles,
    totalLifetimeBottles: overallLifetimeBottles,
    totalLifetimeQty: overallLifetimeBottles,
    averageThisMonthSpend: customerRows.length ? Math.round(overallNewRevenue / customerRows.length) : 0,
    monthLabel,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    totalOrders: customerRows.length,
    totalRevenue: Math.round(overallNewRevenue),
    uniqueCustomersCount: customerRows.length,
    averageOrderValue: customerRows.length ? Math.round(overallNewRevenue / customerRows.length) : 0,
  };

  return {
    customers: paginatedRows,
    orders: enrichedOrders,
    stats,
    pagination: {
      page,
      limit,
      total: filteredRows.length,
      totalPages: Math.ceil(filteredRows.length / limit) || 1,
    },
  };
};

// GET /api/admin/returning-customer-orders
export const getReturningCustomerOrders = async (req: Request, res: Response) => {
  try {
    const { page, limit, search, status, paymentMethod, sortBy, month, year, from, to } = req.query as any;
    const result = await fetchReturningCustomerOrdersData({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      search: search ? String(search) : undefined,
      status: status ? String(status) : undefined,
      paymentMethod: paymentMethod ? String(paymentMethod) : undefined,
      sortBy: sortBy ? String(sortBy) as any : undefined,
      month: month ? Number(month) : undefined,
      year: year ? Number(year) : undefined,
      from: from ? String(from) : undefined,
      to: to ? String(to) : undefined,
    });
    return res.status(200).json(result);
  } catch (err: any) {
    logger.error("getReturningCustomerOrders error", err);
    return res.status(500).json({ message: "Error fetching returning customer orders", error: err.message });
  }
};
