import { Router } from "express";
import {
  placeOrder,
  verifyPayment,
  placeOrderPOD,
  placeOrderQR,
  cancelOrder,
  preCheckout,
  getOrders,
  getOrderById,
  getOrdersForAdmin,
  getOrderStats,
  updateStatus,
  refundOrder,
  getMyTransactions,
  getCustomerTransactions,
  searchCustomersForOrder,
  checkCustomerExists,
  checkRecentOrderForCustomer,
  getProductsForAdminOrder,
  placeAdminOrder,
  getBulkInvoices,
  markInvoicesPrinted,
  bulkUpdateStatus,
  lookupPincode,
  getShippingToggles,
} from "../controllers/order.controller";
import { authMiddleware } from "../middleware/auth.middleware";
import { uploadScreenshot } from "../middleware/upload";
import { adminOrStaff } from "../middleware/staffPermission.middleware";
import { adminOrSuperAdmin } from "../middleware/admin.middleware";
import { validate } from "../middleware/validate.middleware";
import { verifyPaymentSchema, updateOrderStatusSchema } from "../schemas/order.schema";

const router = Router();

// Customer routes — never gated
router.post("/place", authMiddleware, placeOrder);
router.post("/verifyPayment", authMiddleware, validate(verifyPaymentSchema), verifyPayment);
router.post("/placeOrderPOD", authMiddleware, placeOrderPOD);
router.post("/placeOrderQR", authMiddleware, uploadScreenshot.single("screenshot"), placeOrderQR);
router.post("/cancel/:id", authMiddleware, cancelOrder);
router.post("/pre-checkout", authMiddleware, preCheckout);
router.get("/myOrders", authMiddleware, getOrders);
router.get("/my-transactions", authMiddleware, getMyTransactions);
router.get("/shipping-toggles", authMiddleware, getShippingToggles);

// Admin/Staff routes — must be declared before /:id to avoid wildcard conflict
// AdminOrderManagement.tsx (the page these two back) is reachable by a staff member with
// EITHER ORDER_VIEW or ORDER_UPDATE alone — see StaffDashboard.tsx's buildNav and
// AppRoutes.tsx's RequireStaffPermission anyOf=["ORDER_VIEW","ORDER_UPDATE"] on this
// route. A staff member granted only ORDER_UPDATE (e.g. a fulfillment role that changes
// order status but was never given the separate "view" checkbox) previously saw the nav
// link and passed the route guard, then hit a 403 on every request the page actually
// makes — updating an order's status is meaningless without being able to see it, so
// ORDER_UPDATE implies enough access to view the list too.
router.get("/all", authMiddleware, adminOrStaff(["ORDER_VIEW", "ORDER_UPDATE"]), getOrdersForAdmin);
router.get("/stats", authMiddleware, adminOrStaff(["ORDER_VIEW", "ORDER_UPDATE"]), getOrderStats);
router.get("/bulk-invoices", authMiddleware, adminOrStaff(["ORDER_VIEW", "ORDER_UPDATE"]), getBulkInvoices);
router.post("/mark-invoices-printed", authMiddleware, adminOrStaff(["ORDER_VIEW", "ORDER_UPDATE"]), markInvoicesPrinted);
router.put("/bulk-update-status", authMiddleware, adminOrStaff("ORDER_UPDATE"), bulkUpdateStatus);
router.get("/customer-transactions", authMiddleware, adminOrStaff("ORDER_VIEW"), getCustomerTransactions);
router.put("/update/:id", authMiddleware, adminOrStaff("ORDER_UPDATE"), validate(updateOrderStatusSchema), updateStatus);
router.patch("/:id/refund", authMiddleware, adminOrStaff("ORDER_UPDATE"), refundOrder);

// Admin Order (place on behalf of customer)
router.get("/admin-order/search-customers", authMiddleware, adminOrSuperAdmin, searchCustomersForOrder);
router.get("/admin-order/check-customer", authMiddleware, adminOrSuperAdmin, checkCustomerExists);
router.get("/admin-order/check-recent-order", authMiddleware, adminOrSuperAdmin, checkRecentOrderForCustomer);
router.get("/admin-order/products", authMiddleware, adminOrSuperAdmin, getProductsForAdminOrder);
router.post("/admin-order/place", authMiddleware, adminOrSuperAdmin, placeAdminOrder);
router.get("/admin-order/lookup-pincode/:pincode", authMiddleware, adminOrSuperAdmin, lookupPincode);

router.get("/:id", authMiddleware, getOrderById); // single order — customer (own) or admin/staff

export default router;
