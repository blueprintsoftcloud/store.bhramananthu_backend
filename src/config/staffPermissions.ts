// src/config/staffPermissions.ts
// Canonical list of all granular permissions that can be assigned to a STAFF user.
// Admin assigns any subset of these when creating/editing a staff member.

export const STAFF_PERMISSIONS = [
  // Category
  "CATEGORY_VIEW",
  "CATEGORY_ADD",
  "CATEGORY_EDIT",
  "CATEGORY_DELETE",
  // Product
  "PRODUCT_VIEW",
  "PRODUCT_ADD",
  "PRODUCT_EDIT",
  "PRODUCT_DELETE",
  // Order
  "ORDER_VIEW",
  "ORDER_UPDATE",
  "ORDER_CREATE",
  // Coupon
  "COUPON_VIEW",
  "COUPON_ADD",
  "COUPON_EDIT",
  "COUPON_DELETE",
  // Reports & Analytics
  "ANALYTICS_VIEW",
  // Homepage / Banner Management
  "BANNER_VIEW",
  "BANNER_ADD",
  "BANNER_EDIT",
  "BANNER_DELETE",
  // Warehouse & Shipping Settings
  "SETTINGS_VIEW",
  "SETTINGS_EDIT",
  // Payments (payment transaction logs — distinct from Order Management)
  "PAYMENT_VIEW",
  // Customer Activity Tracker
  "CUSTOMER_ACTIVITY_VIEW",
] as const;

export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

// Grouped for display in the UI
export const PERMISSION_GROUPS = [
  {
    label: "Category Management",
    permissions: [
      { key: "CATEGORY_VIEW" as StaffPermission, label: "View / List Categories" },
      { key: "CATEGORY_ADD" as StaffPermission, label: "Add Category" },
      { key: "CATEGORY_EDIT" as StaffPermission, label: "Edit Category" },
      { key: "CATEGORY_DELETE" as StaffPermission, label: "Delete Category" },
    ],
  },
  {
    label: "Product Management",
    permissions: [
      { key: "PRODUCT_VIEW" as StaffPermission, label: "View / List Products" },
      { key: "PRODUCT_ADD" as StaffPermission, label: "Add Product" },
      { key: "PRODUCT_EDIT" as StaffPermission, label: "Edit Product" },
      { key: "PRODUCT_DELETE" as StaffPermission, label: "Delete Product" },
    ],
  },
  {
    label: "Order Management",
    permissions: [
      { key: "ORDER_VIEW" as StaffPermission, label: "View Orders" },
      { key: "ORDER_UPDATE" as StaffPermission, label: "Update Order Status" },
      { key: "ORDER_CREATE" as StaffPermission, label: "Place Orders (Counter / Customer)" },
    ],
  },
  {
    label: "Coupon Management",
    permissions: [
      { key: "COUPON_VIEW" as StaffPermission, label: "View / List Coupons" },
      { key: "COUPON_ADD" as StaffPermission, label: "Add Coupon" },
      { key: "COUPON_EDIT" as StaffPermission, label: "Edit / Toggle Coupon" },
      { key: "COUPON_DELETE" as StaffPermission, label: "Delete Coupon" },
    ],
  },
  {
    label: "Reports & Analytics",
    permissions: [
      { key: "ANALYTICS_VIEW" as StaffPermission, label: "View Reports & Analytics" },
    ],
  },
  {
    label: "Warehouse & Shipping Settings",
    permissions: [
      { key: "SETTINGS_VIEW" as StaffPermission, label: "View Warehouse & Shipping Settings" },
      { key: "SETTINGS_EDIT" as StaffPermission, label: "Edit Warehouse & Shipping Settings" },
    ],
  },
  {
    label: "Payments",
    permissions: [
      { key: "PAYMENT_VIEW" as StaffPermission, label: "View Payment Transaction Logs" },
    ],
  },
  {
    label: "Customer Activity",
    permissions: [
      { key: "CUSTOMER_ACTIVITY_VIEW" as StaffPermission, label: "View Customer Activity Tracker" },
    ],
  },
] as const;
