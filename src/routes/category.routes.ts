import { Router } from "express";
import {
  categoryList,
  categoryAdd,
  categoryUpdate,
  categoryDelete,
  categoryToggleStatus,
  categoryToggleFilters,
  updateCategoryNavSettings,
} from "../controllers/category.controller";
import {
  getCategoryAttributes,
  addCategoryAttribute,
  updateCategoryAttribute,
  deleteCategoryAttribute,
  addAttributeValue,
  updateAttributeValue,
  deleteAttributeValue,
} from "../controllers/attribute.controller";
import { authMiddleware } from "../middleware/auth.middleware";
import { adminOrStaff } from "../middleware/staffPermission.middleware";
import upload from "../middleware/upload";
import { validate } from "../middleware/validate.middleware";
import { categoryAddSchema, categoryUpdateSchema } from "../schemas/category.schema";

const router = Router();

// Public — customers need this to browse
router.get("/list", categoryList);

// Admin/Staff — gated by granular permission
router.post(
  "/add",
  authMiddleware,
  adminOrStaff("CATEGORY_ADD"),
  upload.single("image"),
  validate(categoryAddSchema),
  categoryAdd,
);
router.put(
  "/update/:id",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  upload.single("image"),
  validate(categoryUpdateSchema),
  categoryUpdate,
);
router.delete(
  "/delete/:id",
  authMiddleware,
  adminOrStaff("CATEGORY_DELETE"),
  categoryDelete,
);
router.patch(
  "/:id/status",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  categoryToggleStatus,
);
router.patch(
  "/:id/filters-toggle",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  categoryToggleFilters,
);
router.patch(
  "/nav-order",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  updateCategoryNavSettings,
);

// ── Category Attribute routes ──────────────────────────────────────────────────
// Public: anyone can read attributes (needed for product-add form + customer filter)
router.get("/:categoryId/attributes", getCategoryAttributes);

// Admin/Staff — manage attributes
router.post(
  "/:categoryId/attributes",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  addCategoryAttribute,
);
router.put(
  "/:categoryId/attributes/:attrId",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  updateCategoryAttribute,
);
router.delete(
  "/:categoryId/attributes/:attrId",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  deleteCategoryAttribute,
);

// Admin/Staff — manage attribute values
router.post(
  "/:categoryId/attributes/:attrId/values",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  addAttributeValue,
);
router.put(
  "/:categoryId/attributes/:attrId/values/:valueId",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  updateAttributeValue,
);
router.delete(
  "/:categoryId/attributes/:attrId/values/:valueId",
  authMiddleware,
  adminOrStaff("CATEGORY_EDIT"),
  deleteAttributeValue,
);

export default router;
