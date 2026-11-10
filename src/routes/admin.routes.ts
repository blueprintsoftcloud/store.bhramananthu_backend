import { Router } from "express";
import { authMiddleware } from "../middleware/auth.middleware";
import { adminMiddleware } from "../middleware/admin.middleware";
import { adminOrStaff } from "../middleware/staffPermission.middleware";
import { profileData, updateAvatar, deleteAvatar } from "../controllers/profileAdmin.controller";
import {
  requestProfileUpdate,
  verifyAndUpdateProfile,
} from "../controllers/updateProfile.controller";
import {
  getAdminSummary,
  getDashboardData,
  getAllUsers,
  createAdminUser,
  updateUser,
  deleteUser,
  getReturningCustomerOrders,
} from "../controllers/admin.controller";
import { validate } from "../middleware/validate.middleware";
import { createUserSchema } from "../schemas/user.schema";
import {
  getCompanySettings,
  updateCompanySettings,
  getHomepageConfig,
  updateHeroConfig,
  updateNavbarConfig,
  updateFooterConfig,
  updateStorefrontTheme,
  updateAnnouncementTemplate,
  updateCarouselTemplate,
  updateDiscountTemplate,
  updateFeaturedTemplate,
  uploadAdminImage,
  deleteAdminImage,
  toggleAnnouncementBar,
} from "../controllers/companySettings.controller";
import upload from "../middleware/upload";
import {
  getTrackedCustomers,
  getCustomerWishlist,
  getCustomerCart,
} from "../controllers/customerTracker.controller";


const router = Router();

// Users management
router.get("/users", authMiddleware, adminMiddleware, getAllUsers);
router.post("/users", authMiddleware, adminMiddleware, validate(createUserSchema), createAdminUser);
router.patch("/users/:id", authMiddleware, adminMiddleware, updateUser);
router.delete("/users/:id", authMiddleware, adminMiddleware, deleteUser);

// Admin profile — never gated (admin always needs profile access)
router.get("/adminProfile", authMiddleware, adminMiddleware, profileData);
router.patch("/avatar", authMiddleware, adminMiddleware, upload.single("avatar"), updateAvatar);
router.delete("/avatar", authMiddleware, adminMiddleware, deleteAvatar);
router.post(
  "/adminProfile/request-update",
  authMiddleware,
  adminMiddleware,
  requestProfileUpdate,
);
router.post(
  "/adminProfile/verify-update",
  authMiddleware,
  adminMiddleware,
  verifyAndUpdateProfile,
);

// Dashboard summary
router.get("/summary", authMiddleware, adminOrStaff("ANALYTICS_VIEW"), getAdminSummary);

// Dashboard live snapshot — no feature gate (always accessible to admin/super-admin)
router.get("/dashboard", authMiddleware, adminMiddleware, getDashboardData);

// Returning / previous customer orders (dashboard + dedicated detail view)
router.get("/returning-customer-orders", authMiddleware, adminOrStaff(["ORDER_VIEW", "ORDER_UPDATE", "ANALYTICS_VIEW"]), getReturningCustomerOrders);

// Company settings — GET is public (invoice pages), PUT requires admin
router.get("/company-settings", getCompanySettings);
router.put("/company-settings", authMiddleware, adminMiddleware, upload.fields([{ name: "logo", maxCount: 1 }, { name: "favicon", maxCount: 1 }, { name: "ogImage", maxCount: 1 }, { name: "qrCode", maxCount: 1 }]), updateCompanySettings);
router.patch("/announcement-toggle", authMiddleware, adminMiddleware, toggleAnnouncementBar);

// Single-image upload and delete utility (hero images, etc.) — part of Homepage Manager
router.post("/upload-image", authMiddleware, adminOrStaff("BANNER_EDIT"), upload.single("image"), uploadAdminImage);
router.post("/delete-image", authMiddleware, adminOrStaff("BANNER_EDIT"), deleteAdminImage);

// Homepage config (hero + footer templates) — part of Homepage Manager
router.get("/homepage-config", authMiddleware, adminOrStaff("BANNER_VIEW"), getHomepageConfig);
router.put("/homepage-config/hero", authMiddleware, adminOrStaff("BANNER_EDIT"), updateHeroConfig);
router.put("/homepage-config/navbar", authMiddleware, adminOrStaff("BANNER_EDIT"), updateNavbarConfig);
router.put("/homepage-config/footer", authMiddleware, adminOrStaff("BANNER_EDIT"), updateFooterConfig);
router.put("/homepage-config/theme", authMiddleware, adminOrStaff("BANNER_EDIT"), updateStorefrontTheme);
// Presentation-only template pickers for the 4 sections that don't have per-template
// content of their own (see companySettings.controller.ts's SECTION_TEMPLATE_KEYS) —
// same BANNER_EDIT gate as every other homepage-layout write.
router.put("/homepage-config/announcement-template", authMiddleware, adminOrStaff("BANNER_EDIT"), updateAnnouncementTemplate);
router.put("/homepage-config/carousel-template", authMiddleware, adminOrStaff("BANNER_EDIT"), updateCarouselTemplate);
router.put("/homepage-config/discount-template", authMiddleware, adminOrStaff("BANNER_EDIT"), updateDiscountTemplate);
router.put("/homepage-config/featured-template", authMiddleware, adminOrStaff("BANNER_EDIT"), updateFeaturedTemplate);

// Customer Activity Tracker — admin/staff
router.get("/tracker/customers", authMiddleware, adminOrStaff("CUSTOMER_ACTIVITY_VIEW"), getTrackedCustomers);
router.get("/tracker/customers/:userId/wishlist", authMiddleware, adminOrStaff("CUSTOMER_ACTIVITY_VIEW"), getCustomerWishlist);
router.get("/tracker/customers/:userId/cart", authMiddleware, adminOrStaff("CUSTOMER_ACTIVITY_VIEW"), getCustomerCart);

export default router;
