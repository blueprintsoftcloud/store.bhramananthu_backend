import { Request, Response } from "express";
import crypto from "crypto";
import { Category, Product } from "../models/mongoose";
import { deleteFromCloudinary, uploadToCloudinary } from "../config/cloudinary";
import logger from "../utils/logger";
import { createAuditLog } from "../utils/auditLog";
import { invalidateCache } from "../utils/cache";
import {
  getSubtreeCategoryIds,
  wouldCreateCycle,
  categoryHasDirectProducts,
  categoryHasAttributes,
  getDirectProductCounts,
  getDirectSubcategoryCounts,
  invalidateSubtreeCache,
} from "../utils/categoryTree";

// The customer-facing nav list (product-user.controller.ts's getAllCategories) and
// per-category subtree lookups are cached with a 60s TTL backstop (see cache.ts) —
// every mutation below clears what it knows changed so customers don't wait out the
// TTL to see an admin's edit, while the TTL still bounds staleness for any path missed.
const invalidateCategoryListCache = () => invalidateCache("user-categories:nav");

// GET /api/categories
export const categoryList = async (req: Request, res: Response) => {
  try {
    const { search } = req.query;
    let whereClause: any = {};

    if (search && typeof search === "string" && search.trim() !== "") {
      const q = search.trim();
      whereClause = {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { code: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      };
    }

    const list = await prisma.category.findMany({
      where: whereClause,
      orderBy: { name: "asc" },
    });

    // Direct (non-recursive) product/subcategory counts per category, so the
    // frontend can decide what a node currently holds without extra round-trips —
    // see utils/categoryTree.ts's exclusivity-rule helpers.
    const ids = list.map((c: any) => c.id);
    const [productCounts, subcategoryCounts] = await Promise.all([
      getDirectProductCounts(ids),
      getDirectSubcategoryCounts(ids),
    ]);
    const enriched = list.map((c: any) => ({
      ...c,
      directProductCount: productCounts[c.id] ?? 0,
      directSubcategoryCount: subcategoryCounts[c.id] ?? 0,
    }));

    res.json({ list: enriched });
  } catch (err: any) {
    logger.error("categoryList error", err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/categories  (admin)
export const categoryAdd = async (req: Request, res: Response) => {
  try {
    const { code, name, description, parentId, showFilters } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }
    if (!parentId && !code) {
      return res.status(400).json({ message: "Code and Name are required" });
    }

    // A subcategory is never shown to customers as its own tile (see the catalog
    // browser / Edit modal, which both drop the Code field for subcategories too) —
    // its code is just internal bookkeeping, so generate one instead of requiring the
    // admin to type a value nobody will ever see.
    const resolvedCode: string = code || `SUB-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    if (parentId) {
      const parent = await prisma.category.findUnique({ where: { id: parentId } });
      if (!parent) {
        return res.status(400).json({ message: "Parent category not found" });
      }
      if (await categoryHasDirectProducts(parentId)) {
        return res.status(409).json({
          message: "Cannot add a subcategory here: this category already has direct products. Move or remove them first.",
          code: "PARENT_HAS_PRODUCTS",
        });
      }
      if (await categoryHasAttributes(parentId)) {
        return res.status(409).json({
          message: "Cannot add a subcategory here: this category already has attributes defined. Remove them first — attributes only apply to categories that hold products directly.",
          code: "PARENT_HAS_ATTRIBUTES",
        });
      }
    }

    // Upload image to Cloudinary if provided
    let imageUrl: string | null = null;
    if (req.file) {
      imageUrl = await uploadToCloudinary(
        req.file.buffer,
        `categories/${resolvedCode}`,
      );
    }

    const resolvedShowFilters = showFilters === false || showFilters === "false" ? false : true;

    const category = await prisma.category.create({
      data: {
        code: resolvedCode,
        name,
        description: description ?? null,
        image: imageUrl,
        parentId: parentId ?? null,
        showFilters: resolvedShowFilters,
      },
    });

    await createAuditLog({ req, action: "ADD_CATEGORY", entity: "Category", entityId: category.id, details: { code: category.code, name: category.name, parentId: parentId ?? null } });
    await invalidateCategoryListCache();
    if (parentId) await invalidateSubtreeCache(parentId);
    res.status(201).json({ message: "Admin added new category", category });
  } catch (err: any) {
    logger.error("categoryAdd error", err);
    res
      .status(500)
      .json({ message: "Error in category adding", error: err.message });
  }
};

// PUT /api/categories/:id  (admin)
export const categoryUpdate = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { code, name, description, parentId, showFilters } = req.body;

    const existing = await prisma.category.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: "Category not found" });
    }

    if (code && code !== existing.code) {
      const duplicate = await prisma.category.findFirst({
        where: {
          code: code,
          id: { not: id } // Crucial: Ignore the current category being edited
        }
      });

      if (duplicate) {
        return res.status(409).json({
          message: `Category code "${code}" already existed.`
        });
      }
    }

    // parentId omitted from the request = "not being changed"; present (including
    // empty/null) = an explicit move, possibly back to top-level.
    let nextParentId: string | null = existing.parentId ? String(existing.parentId) : null;
    if (parentId !== undefined) {
      const newParentId: string | null = parentId || null;
      // Only re-check the exclusivity rule when the parent is actually changing —
      // otherwise a grandfathered category that already conflicts (has both direct
      // products and subcategories from before the rule existed) would get blocked
      // from unrelated edits (e.g. renaming) that happen to resubmit its current parentId.
      const isActualMove = newParentId !== nextParentId;
      if (newParentId) {
        const parent = await prisma.category.findUnique({ where: { id: newParentId } });
        if (!parent) {
          return res.status(400).json({ message: "Parent category not found" });
        }
        if (await wouldCreateCycle(id, newParentId)) {
          return res.status(400).json({ message: "Cannot move a category under itself or one of its own subcategories" });
        }
        if (isActualMove && (await categoryHasDirectProducts(newParentId))) {
          return res.status(409).json({
            message: "Cannot move a subcategory here: this category already has direct products. Move or remove them first.",
            code: "PARENT_HAS_PRODUCTS",
          });
        }
        if (isActualMove && (await categoryHasAttributes(newParentId))) {
          return res.status(409).json({
            message: "Cannot move a subcategory here: this category already has attributes defined. Remove them first — attributes only apply to categories that hold products directly.",
            code: "PARENT_HAS_ATTRIBUTES",
          });
        }
      }
      nextParentId = newParentId;
    }

    let imageUrl = existing.image;
    if (req.file) {
      imageUrl = await uploadToCloudinary(
        req.file.buffer,
        `categories/${code ?? existing.code}`,
      );
      // Replacing the image orphaned the old one on Cloudinary forever — clean it up.
      if (existing.image) {
        await deleteFromCloudinary(existing.image).catch((e: unknown) =>
          logger.warn("Failed to delete replaced category image from Cloudinary", e),
        );
      }
    }

    const updateData: Record<string, unknown> = {
      code: code ?? existing.code,
      name: name ?? existing.name,
      description: description ?? existing.description,
      image: imageUrl,
      parentId: nextParentId,
    };
    if (showFilters !== undefined) {
      updateData.showFilters = showFilters === true || showFilters === "true" || showFilters === "1";
    }

    const updated = await prisma.category.update({
      where: { id },
      data: updateData,
    });

    await createAuditLog({ req, action: "UPDATE_CATEGORY", entity: "Category", entityId: updated.id, details: { code: updated.code, name: updated.name } });
    await Promise.all([
      invalidateCategoryListCache(),
      invalidateSubtreeCache(id),
      existing.parentId ? invalidateSubtreeCache(String(existing.parentId)) : Promise.resolve(),
      nextParentId ? invalidateSubtreeCache(nextParentId) : Promise.resolve(),
    ]);
    res
      .status(200)
      .json({ message: "Category updated successfully", category: updated });
  } catch (err: any) {
    logger.error("categoryUpdate error", err);
    res
      .status(500)
      .json({ message: "Error in category update", error: err.message });
  }
};

// DELETE /api/categories/:id  (admin)
export const categoryDelete = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Deleting a category deletes its ENTIRE subtree — every descendant subcategory
    // and every product anywhere within it — all-or-nothing, same safety semantics
    // as the single-level case this replaces (see the open-order block below).
    const subtreeIds = await getSubtreeCategoryIds(id);

    // 1. Find all products anywhere in the subtree
    const products = await prisma.product.findMany({
      where: { categoryId: { in: subtreeIds } },
      select: { id: true },
    });
    const productIds = products.map((p: any) => p.id);

    // 2. Block deletion if any open orders contain products anywhere in the subtree.
    // Silently auto-cancelling paid/confirmed orders on category delete would
    // cause unrecoverable revenue loss — admin must resolve orders first.
    if (productIds.length > 0) {
      const openOrderCount = await prisma.order.count({
        where: {
          orderStatus: { notIn: ["DELIVERED", "CANCELLED", "RETURNED"] },
          items: { some: { productId: { in: productIds } } },
        },
      });

      if (openOrderCount > 0) {
        return res.status(409).json({
          message: `Cannot delete: ${openOrderCount} open order${openOrderCount > 1 ? "s" : ""} contain products from this category or its subcategories. Wait until all orders are delivered, cancelled, or returned before deleting.`,
        });
      }

      // 3. Remove deleted products from all carts, then recalculate totals
      const affectedCarts = await prisma.cart.findMany({
        where: { items: { some: { productId: { in: productIds } } } },
        include: { items: { include: { product: true } } },
      });

      for (const cart of affectedCarts) {
        // Remove items for deleted products
        await prisma.cartItem.deleteMany({
          where: {
            cartId: cart.id,
            productId: { in: productIds },
          },
        });
        // Cart total is computed on-the-fly from CartItems — no stored total to update
      }

      // 4. Delete every cascaded product's Cloudinary assets (main + gallery images).
      // Previously the products were deleted but their images were never cleaned up —
      // a cascading category delete silently orphaned every image of every product in it.
      const productsWithImages = await prisma.product.findMany({
        where: { categoryId: { in: subtreeIds } },
        select: { image: true, images: true },
      });
      const allProductImages = productsWithImages.flatMap((p: any) => [p.image, ...(p.images ?? [])]).filter(Boolean) as string[];
      await Promise.all(
        allProductImages.map((url) =>
          deleteFromCloudinary(url).catch((e: unknown) =>
            logger.warn("Failed to delete cascaded product image from Cloudinary", e),
          ),
        ),
      );

      // 5. Delete the products themselves
      await prisma.product.deleteMany({ where: { categoryId: { in: subtreeIds } } });
    }

    // 6. Delete every category's own image in the subtree (root + every descendant —
    // the single-level version of this only ever cleaned up the root's own image).
    const categoriesInSubtree = await prisma.category.findMany({
      where: { id: { in: subtreeIds } },
      select: { image: true },
    });
    const allCategoryImages = categoriesInSubtree.map((c: any) => c.image).filter(Boolean) as string[];
    await Promise.all(
      allCategoryImages.map((url) =>
        deleteFromCloudinary(url).catch((e: unknown) =>
          logger.warn("Failed to delete category image from Cloudinary", e),
        ),
      ),
    );

    // 7. Delete every category in the subtree
    await prisma.category.deleteMany({ where: { id: { in: subtreeIds } } });
    await createAuditLog({
      req,
      action: "DELETE_CATEGORY",
      entity: "Category",
      entityId: id,
      details: { name: category.name, categoriesDeleted: subtreeIds.length, productsDeleted: productIds.length },
    });

    await Promise.all([
      invalidateCategoryListCache(),
      ...subtreeIds.map((subId: string) => invalidateSubtreeCache(subId)),
      category.parentId ? invalidateSubtreeCache(String(category.parentId)) : Promise.resolve(),
    ]);

    res.status(200).json({
      message: subtreeIds.length > 1
        ? `Category and ${subtreeIds.length - 1} subcategor${subtreeIds.length - 1 === 1 ? "y" : "ies"} deleted successfully`
        : "Category deleted successfully",
    });
  } catch (err: any) {
    logger.error("categoryDelete error", err);
    res
      .status(500)
      .json({ message: "Error in category Delete", error: err.message });
  }
};

// PATCH /api/category/:id/status (admin)
export const categoryToggleStatus = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { isActive } = req.body;

    if (isActive === undefined || typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive status must be a boolean" });
    }

    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Cascades to the whole subtree — every descendant subcategory and every
    // product anywhere within it, not just this exact category's direct products.
    const subtreeIds = await getSubtreeCategoryIds(id);

    await prisma.category.updateMany({
      where: { id: { in: subtreeIds } },
      data: { isActive },
    });

    await prisma.product.updateMany({
      where: { categoryId: { in: subtreeIds } },
      data: { isActive },
    });

    const updated = await prisma.category.findUnique({ where: { id } });

    await createAuditLog({
      req,
      action: isActive ? "ENABLE_CATEGORY" : "DISABLE_CATEGORY",
      entity: "Category",
      entityId: id,
      details: { name: category.name, isActive, categoriesAffected: subtreeIds.length },
    });

    await invalidateCategoryListCache();

    res.status(200).json({
      message: `Category ${isActive ? "enabled" : "disabled"} successfully along with all subcategories and products under it`,
      category: updated,
    });
  } catch (err: any) {
    logger.error("categoryToggleStatus error", err);
    res.status(500).json({ message: "Error toggling category status", error: err.message });
  }
};

// PATCH /api/category/nav-order  (admin) — bulk-update which top-level categories
// show in the site-wide mega menu and their left-to-right order. The Homepage
// Manager UI lets an admin toggle/reorder several at once and save in one call
// instead of one request per category.
export const updateCategoryNavSettings = async (req: Request, res: Response) => {
  try {
    const { items } = req.body as {
      items?: { id: string; showInNav?: boolean; navOrder?: number }[];
    };

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items array is required" });
    }

    const updated = [];
    for (const item of items) {
      if (!item?.id) continue;
      const category = await prisma.category.findUnique({ where: { id: item.id } });
      // Nav settings only ever apply to top-level categories — a subcategory has no
      // independent slot in the mega menu, it just rides along under its parent.
      if (!category || category.parentId) continue;

      const data: Record<string, unknown> = {};
      if (typeof item.showInNav === "boolean") data.showInNav = item.showInNav;
      if (typeof item.navOrder === "number") data.navOrder = item.navOrder;
      if (Object.keys(data).length === 0) continue;

      updated.push(await prisma.category.update({ where: { id: item.id }, data }));
    }

    await createAuditLog({
      req,
      action: "UPDATE_CATEGORY_NAV_SETTINGS",
      entity: "Category",
      entityId: "bulk",
      details: { count: updated.length },
    });

    if (updated.length > 0) await invalidateCategoryListCache();

    res.status(200).json({ message: "Navigation settings updated", categories: updated });
  } catch (err: any) {
    logger.error("updateCategoryNavSettings error", err);
    res.status(500).json({ message: "Error updating navigation settings", error: err.message });
  }
};

// PATCH /api/category/:id/filters-toggle (admin)
export const categoryToggleFilters = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { showFilters } = req.body;

    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    const nextShowFilters =
      typeof showFilters === "boolean"
        ? showFilters
        : !(category.showFilters ?? true);

    const updated = await prisma.category.update({
      where: { id },
      data: { showFilters: nextShowFilters },
    });

    await createAuditLog({
      req,
      action: nextShowFilters ? "ENABLE_CATEGORY_FILTERS" : "DISABLE_CATEGORY_FILTERS",
      entity: "Category",
      entityId: id,
      details: { name: category.name, showFilters: nextShowFilters },
    });

    await invalidateCategoryListCache();
    await invalidateSubtreeCache(id);

    res.status(200).json({
      message: `Category filters ${nextShowFilters ? "enabled" : "disabled"} successfully`,
      category: updated,
    });
  } catch (err: any) {
    logger.error("categoryToggleFilters error", err);
    res.status(500).json({ message: "Error toggling category filters", error: err.message });
  }
};


