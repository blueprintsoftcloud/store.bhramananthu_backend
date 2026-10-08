import { Router } from "express";
import {
  productList,
  productAdd,
  productUpdate,
  productDelete,
  productToggleStatus,
  adminStockSummary,
  productAdminDetail,
  quickStockUpdate,
} from "../controllers/product.controller";
import {
  listVariants,
  addVariant,
  generateVariants,
  syncVariantOptionFilter,
  updateVariant,
  deleteVariant,
  updateVariantAttributeValues,
  uploadVariantImages,
  applyImagesToAllVariants,
} from "../controllers/productVariant.controller";
import { authMiddleware } from "../middleware/auth.middleware";
import { adminOrStaff } from "../middleware/staffPermission.middleware";
import upload from "../middleware/upload";
import { validate } from "../middleware/validate.middleware";
import { productAddSchema, productUpdateSchema } from "../schemas/product.schema";

const router = Router();

// Admin/Staff only — gated by PRODUCT_MANAGEMENT feature flag + granular permission
router.get("/stock-summary", authMiddleware, adminOrStaff("PRODUCT_VIEW"), adminStockSummary);
router.get("/detail/:id", authMiddleware, adminOrStaff("PRODUCT_VIEW"), productAdminDetail);
router.patch("/:id/quick-stock", authMiddleware, adminOrStaff("PRODUCT_EDIT"), quickStockUpdate);

router.get("/list", authMiddleware, adminOrStaff("PRODUCT_VIEW"), productList);
router.post(
  "/add",
  authMiddleware,
  adminOrStaff("PRODUCT_ADD"),
  upload.fields([{ name: "image", maxCount: 1 }, { name: "images", maxCount: 5 }]),
  validate(productAddSchema),
  productAdd,
);
router.put(
  "/update/:id",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  upload.fields([{ name: "image", maxCount: 1 }, { name: "images", maxCount: 5 }]),
  validate(productUpdateSchema),
  productUpdate,
);
router.delete(
  "/delete/:id",
  authMiddleware,
  adminOrStaff("PRODUCT_DELETE"),
  productDelete,
);
router.patch(
  "/:id/status",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  productToggleStatus,
);

// Admin/Staff — variant (size/color) stock management
router.get(
  "/:productId/variants",
  authMiddleware,
  adminOrStaff("PRODUCT_VIEW"),
  listVariants,
);
router.post(
  "/:productId/variants",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  addVariant,
);
router.post(
  "/:productId/variants/generate",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  generateVariants,
);
router.post(
  "/:productId/variants/sync-filter",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  syncVariantOptionFilter,
);
router.put(
  "/:productId/variants/attribute-values",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  updateVariantAttributeValues,
);
router.post(
  "/:productId/variants/apply-images-all",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "secondaryImage", maxCount: 1 },
  ]),
  applyImagesToAllVariants,
);
router.post(
  "/:productId/variants/:variantId/images",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "secondaryImage", maxCount: 1 },
  ]),
  uploadVariantImages,
);
router.put(
  "/:productId/variants/:variantId",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  updateVariant,
);
router.delete(
  "/:productId/variants/:variantId",
  authMiddleware,
  adminOrStaff("PRODUCT_EDIT"),
  deleteVariant,
);

export default router;
