// src/controllers/productVariant.controller.ts
// Admin CRUD for ProductVariant — the option combinations (Storage×Color, Weight,
// Metal×Weight, whatever axes the admin names for THIS product) a product is actually
// sold in, each with its own stock (see mongoose.ts's ProductVariant for why this is
// separate from Product.stock and separate from the CategoryAttribute filter system).

import { Request, Response } from "express";
import { createAuditLog } from "../utils/auditLog";
import { computeOptionsKey, syncProductFromVariants } from "../utils/productVariant";
import { syncOptionGroupsToFilters } from "../utils/optionFilterSync";
import { uploadToCloudinary, deleteFromCloudinary } from "../config/cloudinary";
import logger from "../utils/logger";

// GET /api/product/:productId/variants  (admin)
export const listVariants = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const variants = await prisma.productVariant.findMany({
      where: { productId },
      orderBy: { createdAt: "asc" },
    });

    res.json({ variants });
  } catch (err: any) {
    res.status(500).json({ message: "Error fetching variants", error: err.message });
  }
};

// POST /api/product/:productId/variants  (admin) — add a single option-combination row
export const addVariant = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const { options, sku, stock, priceOverride, purchasePriceOverride, discountOverride, image, secondaryImage, images: rawImages } = req.body;

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const normalizedOptions: Record<string, string> =
      options && typeof options === "object"
        ? Object.fromEntries(
            Object.entries(options)
              .map(([k, v]) => [String(k).trim(), String(v ?? "").trim()])
              .filter(([k, v]) => k && v),
          )
        : {};
    const optionsKey = computeOptionsKey(normalizedOptions);
    if (!optionsKey) {
      return res.status(400).json({ message: "A variant needs at least one option (e.g. Size, Storage, Weight)" });
    }

    const primaryImg = image ? String(image).trim() : null;
    const secondaryImg = secondaryImage ? String(secondaryImage).trim() : null;
    const variantImages = Array.isArray(rawImages) && rawImages.length
      ? rawImages.map(String).filter(Boolean)
      : [primaryImg, secondaryImg].filter(Boolean) as string[];

    const requestedActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : Boolean(primaryImg);
    if (requestedActive && !primaryImg) {
      return res.status(400).json({ message: "1st image is required to add an active variant" });
    }

    const variant = await prisma.productVariant.create({
      data: {
        productId,
        options: normalizedOptions,
        optionsKey,
        sku: sku || undefined,
        stock: stock !== undefined ? parseInt(stock) : 0,
        priceOverride: priceOverride !== undefined && priceOverride !== null && priceOverride !== "" ? parseFloat(priceOverride) : null,
        purchasePriceOverride: purchasePriceOverride !== undefined && purchasePriceOverride !== null && purchasePriceOverride !== "" ? parseFloat(purchasePriceOverride) : null,
        discountOverride: discountOverride !== undefined && discountOverride !== null && discountOverride !== "" ? parseFloat(discountOverride) : null,
        image: primaryImg,
        secondaryImage: secondaryImg,
        images: variantImages,
        isActive: requestedActive,
      },
    });

    await syncProductFromVariants(productId);

    await createAuditLog({
      req,
      action: "ADD_PRODUCT_VARIANT",
      entity: "ProductVariant",
      entityId: variant.id,
      details: { productId, options: normalizedOptions },
    });

    res.status(201).json({ message: "Variant added", variant });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ message: "This option combination already exists for this product" });
    }
    res.status(500).json({ message: "Error adding variant", error: err.message });
  }
};

// POST /api/product/:productId/variants/generate  (admin)
// Bulk-creates the cartesian product across however many option groups the admin
// defines — e.g. [{name:"Storage",values:["128GB","256GB"]}, {name:"Color",
// values:["Black","White"]}] produces 4 rows; a single group produces one row per
// value; any combination that already exists is skipped (same additive contract as
// CategoryAttributes.tsx's "add value" flow — never clobbers existing stock numbers).
export const generateVariants = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const rawGroups: Array<{ name?: string; values?: string[]; isFilterable?: boolean }> = Array.isArray(req.body.optionGroups)
      ? req.body.optionGroups
      : [];

    const groups = rawGroups
      .map((g) => ({
        name: (g.name ?? "").toString().trim(),
        values: [...new Set((Array.isArray(g.values) ? g.values : []).map((v) => v.toString().trim()).filter(Boolean))],
        // When set, this option also becomes (or reuses) a real Category Filter attribute
        // so it shows up in the storefront filter panel — see optionFilterSync.ts. Kept
        // per-group rather than a single flag since a product might want "Storage" as a
        // customer filter but "Batch Code" as a purchasable option only.
        isFilterable: Boolean(g.isFilterable),
      }))
      .filter((g) => g.name && g.values.length > 0);

    if (groups.length === 0) {
      return res.status(400).json({ message: "Provide at least one option (a name and at least one value)" });
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Product not found" });

    // Cartesian product across every group, in order — e.g. groups [Storage:[128,256],
    // Color:[Black,White]] → 4 combos, each an { Storage, Color } options object.
    let combos: Array<Record<string, string>> = [{}];
    for (const group of groups) {
      combos = combos.flatMap((combo) => group.values.map((value) => ({ ...combo, [group.name]: value })));
    }

    const existing = await prisma.productVariant.findMany({ where: { productId } });
    const existingKeys = new Set(existing.map((v: any) => v.optionsKey));
    const toCreate = combos
      .map((options) => ({ options, optionsKey: computeOptionsKey(options) }))
      .filter((c) => !existingKeys.has(c.optionsKey));

    const created = [];
    for (const combo of toCreate) {
      // Selling/purchase price default to 0, not null. Generated combinations start as
      // inactive (draft) until the admin uploads the required Slot 1 primary image and activates them.
      const variant = await prisma.productVariant.create({
        data: { productId, options: combo.options, optionsKey: combo.optionsKey, stock: 0, priceOverride: 0, purchasePriceOverride: 0, isActive: false },
      });
      created.push(variant);
    }

    await syncProductFromVariants(productId);

    await createAuditLog({
      req,
      action: "GENERATE_PRODUCT_VARIANTS",
      entity: "ProductVariant",
      entityId: productId,
      details: { productId, groups, createdCount: created.length, skippedCount: combos.length - created.length },
    });

    const variants = await prisma.productVariant.findMany({ where: { productId }, orderBy: { createdAt: "asc" } });

    // Fold any group marked filterable straight into a real Category Filter attribute
    // and tag every matching variant (existing + newly created) with it — this is what
    // removes the separate "go create it in Category Management, then come back and
    // assign it per variant" round trip. Best-effort: never blocks the response.
    try {
      if (product.categoryId) {
        await syncOptionGroupsToFilters(String(product.categoryId), productId, groups, variants);
      }
    } catch (syncErr) {
      logger.error("generateVariants: option-to-filter sync failed", syncErr);
    }

    res.status(201).json({
      message: `${created.length} variant(s) added${combos.length - created.length > 0 ? `, ${combos.length - created.length} already existed` : ""}`,
      variants,
    });
  } catch (err: any) {
    res.status(500).json({ message: "Error generating variants", error: err.message });
  }
};

// POST /api/product/:productId/variants/sync-filter  (admin)
// Turns ONE existing option axis (e.g. "Color") into a customer-facing filter on
// demand, straight from the Listproducts.tsx "Filter visibility" toggle — no
// retyping the option's values, no leaving the product. Unlike generateVariants,
// this never creates or touches ProductVariant rows: it reads whichever distinct
// values that axis already has across the product's real variants and hands them
// to the same optionFilterSync.ts helper generateVariants uses, so the resulting
// CategoryAttribute/CategoryAttributeValue/ProductAttributeValue rows are identical
// to what would exist had the toggle been on from the start.
export const syncVariantOptionFilter = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const optionName = (req.body.optionName ?? "").toString().trim();
    if (!optionName) return res.status(400).json({ message: "optionName is required" });

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Product not found" });
    if (!product.categoryId) return res.status(400).json({ message: "Product has no category" });

    const variants = await prisma.productVariant.findMany({ where: { productId } });
    const values: string[] = [
      ...new Set<string>(
        variants
          .map((v: any) => v.options?.[optionName])
          .filter((v: any) => typeof v === "string" && v.trim() !== ""),
      ),
    ];
    if (values.length === 0) {
      return res.status(404).json({ message: `No variants have a "${optionName}" option to sync` });
    }

    await syncOptionGroupsToFilters(
      String(product.categoryId),
      productId,
      [{ name: optionName, values, isFilterable: true }],
      variants,
    );

    const attributes = await prisma.categoryAttribute.findMany({
      where: { categoryId: String(product.categoryId) },
      include: { values: true },
    });
    const attribute = (attributes as any[]).find((a) => a.name.trim().toLowerCase() === optionName.toLowerCase());

    await createAuditLog({
      req,
      action: "SYNC_VARIANT_OPTION_FILTER",
      entity: "CategoryAttribute",
      entityId: attribute?.id ?? productId,
      details: { productId, optionName, values },
    });

    res.json({ message: `"${optionName}" is now a customer-facing filter`, attribute });
  } catch (err: any) {
    logger.error("syncVariantOptionFilter error", err);
    res.status(500).json({ message: "Error syncing filter", error: err.message });
  }
};

// PUT /api/product/:productId/variants/:variantId  (admin) — update stock/price/sku/active,
// and (new) the option combination itself — e.g. fixing "Size: 18 Inch" to "Size: 17 Inch"
// on a row that was generated with a typo, without deleting and re-adding it.
export const updateVariant = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const variantId = req.params.variantId as string;
    const { stock, priceOverride, purchasePriceOverride, discountOverride, sku, isActive, options, image, secondaryImage, images: rawImages } = req.body;

    const existing = await prisma.productVariant.findFirst({ where: { id: variantId, productId } });
    if (!existing) return res.status(404).json({ message: "Variant not found" });

    let normalizedOptions: Record<string, string> | undefined;
    let optionsKey: string | undefined;
    if (options && typeof options === "object") {
      normalizedOptions = Object.fromEntries(
        Object.entries(options)
          .map(([k, v]) => [String(k).trim(), String(v ?? "").trim()])
          .filter(([k, v]) => k && v),
      ) as Record<string, string>;
      optionsKey = computeOptionsKey(normalizedOptions);
      if (!optionsKey) {
        return res.status(400).json({ message: "A variant needs at least one option (e.g. Size, Storage, Weight)" });
      }
      const conflict = await prisma.productVariant.findFirst({ where: { productId, optionsKey } });
      if (conflict && conflict.id !== variantId) {
        return res.status(409).json({ message: "This option combination already exists for this product" });
      }
    }

    const nextPrimaryImg = image !== undefined ? (image ? String(image).trim() : null) : existing.image;
    const nextSecondaryImg = secondaryImage !== undefined ? (secondaryImage ? String(secondaryImage).trim() : null) : existing.secondaryImage;
    const nextImages = Array.isArray(rawImages)
      ? rawImages.map(String).filter(Boolean)
      : (image !== undefined || secondaryImage !== undefined)
        ? ([nextPrimaryImg, nextSecondaryImg].filter(Boolean) as string[])
        : existing.images;

    const willBeActive = isActive !== undefined ? Boolean(isActive) : existing.isActive;
    if (willBeActive && !nextPrimaryImg) {
      return res.status(400).json({ message: "1st image is required for active variants" });
    }

    const updated = await prisma.productVariant.update({
      where: { id: variantId },
      data: {
        ...(normalizedOptions ? { options: normalizedOptions, optionsKey } : {}),
        stock: stock !== undefined ? (parseInt(stock) || 0) : existing.stock,
        priceOverride:
          priceOverride === undefined
            ? existing.priceOverride
            : priceOverride === null || priceOverride === ""
              ? null
              : parseFloat(priceOverride),
        purchasePriceOverride:
          purchasePriceOverride === undefined
            ? existing.purchasePriceOverride
            : purchasePriceOverride === null || purchasePriceOverride === ""
              ? null
              : parseFloat(purchasePriceOverride),
        discountOverride:
          discountOverride === undefined
            ? existing.discountOverride
            : discountOverride === null || discountOverride === ""
              ? null
              : parseFloat(discountOverride),
        sku: sku !== undefined ? sku : existing.sku,
        isActive: isActive !== undefined ? Boolean(isActive) : existing.isActive,
        image: nextPrimaryImg,
        secondaryImage: nextSecondaryImg,
        images: nextImages,
      },
    });

    await syncProductFromVariants(productId);

    // The combination changed — any axis that's currently a customer-facing filter
    // (e.g. Color) needs its tag on THIS variant moved from the old value to the new
    // one, otherwise it'd keep showing under the value it no longer has. Re-derives
    // each axis's current isFilterable straight from its CategoryAttribute (never
    // flips one on that wasn't already) and only ever touches this one variant.
    if (normalizedOptions) {
      try {
        const product = await prisma.product.findUnique({ where: { id: productId } });
        if (product?.categoryId) {
          const categoryId = String(product.categoryId);
          const attrs = await prisma.categoryAttribute.findMany({ where: { categoryId } });
          const attrByLowerName = new Map((attrs as any[]).map((a) => [String(a.name).trim().toLowerCase(), a]));
          const groups = Object.entries(normalizedOptions).map(([name, value]) => ({
            name,
            values: [value],
            isFilterable: Boolean(attrByLowerName.get(name.trim().toLowerCase())?.isFilterable),
          }));
          await syncOptionGroupsToFilters(categoryId, productId, groups, [updated]);
        }
      } catch (syncErr) {
        logger.error("updateVariant: option-to-filter re-sync failed", syncErr);
      }
    }

    res.json({ message: "Variant updated", variant: updated });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ message: "This option combination already exists for this product" });
    }
    res.status(500).json({ message: "Error updating variant", error: err.message });
  }
};

// Helper: deletes a Cloudinary asset only if NO other variant or product in the database is using that exact URL
async function safeDeleteVariantImage(url: string | null | undefined, currentVariantId?: string, productId?: string) {
  if (!url || typeof url !== "string" || !url.trim()) return;
  try {
    const cleanUrl = url.trim();
    // 1. Check if any other variant of this product or any product uses this image
    const otherVariantCount = await prisma.productVariant.count({
      where: {
        ...(currentVariantId ? { id: { not: currentVariantId } } : {}),
        OR: [{ image: cleanUrl }, { secondaryImage: cleanUrl }],
      },
    });
    if (otherVariantCount > 0) {
      // Still in use by other variants — do not delete from Cloudinary!
      return;
    }

    // 2. Check if the parent product or any other product uses this image as cover/gallery
    const productCount = await prisma.product.count({
      where: {
        image: cleanUrl,
      },
    });
    if (productCount > 0) {
      // Still in use by product cover — do not delete from Cloudinary!
      return;
    }

    await deleteFromCloudinary(cleanUrl).catch((e: unknown) =>
      logger.warn("Failed to delete variant image from Cloudinary", e),
    );
  } catch (e) {
    logger.warn("safeDeleteVariantImage check error", e);
  }
}

// DELETE /api/product/:productId/variants/:variantId  (admin)
export const deleteVariant = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const variantId = req.params.variantId as string;

    const existing = await prisma.productVariant.findFirst({ where: { id: variantId, productId } });
    if (!existing) return res.status(404).json({ message: "Variant not found" });

    // Clean up variant images from Cloudinary ONLY if not shared with other variants
    const imagesToDelete = [existing.image, existing.secondaryImage, ...(existing.images ?? [])].filter(Boolean) as string[];
    if (imagesToDelete.length > 0) {
      await Promise.all(
        imagesToDelete.map((url) => safeDeleteVariantImage(url, variantId, productId))
      );
    }

    // Cart/order items referencing this variant keep their variantId (a stale
    // reference, same tradeoff the rest of this app already makes — e.g. Order never
    // re-validates its productId still exists either). It's a purchase-history
    // record, not a live pointer that needs to keep resolving.
    await prisma.productVariant.delete({ where: { id: variantId } });

    await syncProductFromVariants(productId);

    await createAuditLog({
      req,
      action: "DELETE_PRODUCT_VARIANT",
      entity: "ProductVariant",
      entityId: variantId,
      details: { productId, options: existing.options },
    });

    res.json({ message: "Variant deleted" });
  } catch (err: any) {
    res.status(500).json({ message: "Error deleting variant", error: err.message });
  }
};

// PUT /api/product/:productId/variants/attribute-values  (admin)
// Replaces every VARIANT-SCOPED Category Filter tag (ProductAttributeValue rows with a
// variantId) for this product — used by the standalone Manage Variants modal
// (ProductVariantsModal.tsx), which edits per-variant tags without going through the
// full Edit Product form's own attributeValues save (product.controller.ts's
// productUpdate). Deliberately scoped to variantId-carrying rows only: whole-product
// tags (variantId null, only meaningful pre-variants) are a separate concept owned by
// that other form and are left untouched here.
export const updateVariantAttributeValues = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Product not found" });

    type AttrEntry = { attributeId: string; attributeValueId?: string; textValue?: string; variantId: string };
    const entries: AttrEntry[] = Array.isArray(req.body.attributeValues) ? req.body.attributeValues : [];

    const variantIds = (await prisma.productVariant.findMany({ where: { productId }, select: { id: true } })).map(
      (v: any) => v.id,
    );
    if (variantIds.length > 0) {
      await prisma.productAttributeValue.deleteMany({ where: { productId, variantId: { in: variantIds } } });
    }

    const rows: { productId: string; attributeId: string; attributeValueId?: string; textValue?: string; variantId: string }[] = [];
    for (const entry of entries) {
      if (!entry.attributeId || !entry.variantId) continue;
      if (entry.attributeValueId && entry.attributeValueId.includes(",")) {
        for (const vid of entry.attributeValueId.split(",").filter(Boolean)) {
          rows.push({ productId, attributeId: entry.attributeId, attributeValueId: vid, variantId: entry.variantId });
        }
      } else if (entry.attributeValueId) {
        rows.push({ productId, attributeId: entry.attributeId, attributeValueId: entry.attributeValueId, variantId: entry.variantId });
      } else if (entry.textValue !== undefined && entry.textValue !== "") {
        rows.push({ productId, attributeId: entry.attributeId, textValue: String(entry.textValue), variantId: entry.variantId });
      }
    }
    if (rows.length > 0) {
      await prisma.productAttributeValue.createMany({ data: rows });
    }

    await createAuditLog({
      req,
      action: "UPDATE_PRODUCT",
      entity: "Product",
      entityId: productId,
      details: { variantAttributeValuesUpdated: rows.length },
    });

    res.json({ message: "Variant attribute values updated" });
  } catch (err: any) {
    logger.error("updateVariantAttributeValues error", err);
    res.status(500).json({ message: "Error updating variant attribute values", error: err.message });
  }
};

// POST /api/product/:productId/variants/:variantId/images  (admin)
// Accepts multipart image (Slot 1) and/or secondaryImage (Slot 2) files, or JSON image URLs,
// uploads them to Cloudinary, and saves image, secondaryImage, and images: [image, secondaryImage].
export const uploadVariantImages = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const variantId = req.params.variantId as string;

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const existing = await prisma.productVariant.findFirst({ where: { id: variantId, productId } });
    if (!existing) return res.status(404).json({ message: "Variant not found" });

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const body = req.body || {};

    let primaryUrl: string | null = existing.image ?? null;
    let secondaryUrl: string | null = existing.secondaryImage ?? null;

    const code = product.code || productId;

    // Slot 1: Primary Image
    if (files?.image?.[0]) {
      if (existing.image) {
        safeDeleteVariantImage(existing.image, variantId, productId);
      }
      primaryUrl = await uploadToCloudinary(
        files.image[0].buffer,
        `products/${code}/variants/${variantId}/primary_${Date.now()}`
      );
    } else if (body.image !== undefined) {
      const nextImg = body.image ? String(body.image).trim() : null;
      if (!nextImg && existing.image) {
        safeDeleteVariantImage(existing.image, variantId, productId);
      }
      primaryUrl = nextImg;
    }

    // Slot 2: Secondary Image
    if (files?.secondaryImage?.[0]) {
      if (existing.secondaryImage) {
        safeDeleteVariantImage(existing.secondaryImage, variantId, productId);
      }
      secondaryUrl = await uploadToCloudinary(
        files.secondaryImage[0].buffer,
        `products/${code}/variants/${variantId}/secondary_${Date.now()}`
      );
    } else if (body.secondaryImage !== undefined) {
      const nextSecondary = body.secondaryImage ? String(body.secondaryImage).trim() : null;
      if (!nextSecondary && existing.secondaryImage) {
        safeDeleteVariantImage(existing.secondaryImage, variantId, productId);
      }
      secondaryUrl = nextSecondary;
    }

    const images = [primaryUrl, secondaryUrl].filter(Boolean) as string[];

    const updated = await prisma.productVariant.update({
      where: { id: variantId },
      data: {
        image: primaryUrl,
        secondaryImage: secondaryUrl,
        images,
      },
    });

    await syncProductFromVariants(productId);

    await createAuditLog({
      req,
      action: "UPDATE_PRODUCT_VARIANT",
      entity: "ProductVariant",
      entityId: variantId,
      details: { productId, image: primaryUrl, secondaryImage: secondaryUrl },
    });

    res.json({ message: "Variant images updated", variant: updated });
  } catch (err: any) {
    logger.error("uploadVariantImages error", err);
    res.status(500).json({ message: "Error uploading variant images", error: err.message });
  }
};

// POST /api/product/:productId/variants/apply-images-all  (admin)
// Sets the same image(s) across ALL variants of a product without duplicate uploads.
// Accepts:
// 1. JSON payload: { sourceVariantId, slot?: "primary" | "secondary" | "both" }
//    OR { image?: string, secondaryImage?: string, slot?: "primary" | "secondary" | "both" }
// 2. Multipart file upload: req.files.image (Slot 1) and/or req.files.secondaryImage (Slot 2)
export const applyImagesToAllVariants = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const body = req.body || {};
    const code = product.code || productId;
    const slot: "primary" | "secondary" | "both" = body.slot || "both";

    let targetImage: string | undefined = undefined;
    let targetSecondaryImage: string | undefined = undefined;

    // If sourceVariantId is provided, fetch its images
    if (body.sourceVariantId) {
      const source = await prisma.productVariant.findFirst({
        where: { id: String(body.sourceVariantId), productId },
      });
      if (!source) {
        return res.status(404).json({ message: "Source variant not found" });
      }
      if (slot === "primary" || slot === "both") {
        targetImage = source.image || undefined;
      }
      if (slot === "secondary" || slot === "both") {
        targetSecondaryImage = source.secondaryImage || undefined;
      }
    } else {
      // 1. Check if files were uploaded directly in multipart form
      if (files?.image?.[0]) {
        targetImage = await uploadToCloudinary(
          files.image[0].buffer,
          `products/${code}/variants/shared_primary_${Date.now()}`
        );
      } else if (body.image !== undefined) {
        targetImage = body.image ? String(body.image).trim() : undefined;
      }

      if (files?.secondaryImage?.[0]) {
        targetSecondaryImage = await uploadToCloudinary(
          files.secondaryImage[0].buffer,
          `products/${code}/variants/shared_secondary_${Date.now()}`
        );
      } else if (body.secondaryImage !== undefined) {
        targetSecondaryImage = body.secondaryImage ? String(body.secondaryImage).trim() : undefined;
      }
    }

    if (targetImage === undefined && targetSecondaryImage === undefined) {
      return res.status(400).json({ message: "No image specified to apply across variants" });
    }

    const allVariants = await prisma.productVariant.findMany({ where: { productId } });
    if (allVariants.length === 0) {
      return res.status(400).json({ message: "No variants exist for this product" });
    }

    // Update all variants of this product
    for (const v of allVariants) {
      const newPrimary = targetImage !== undefined ? targetImage : v.image;
      const newSecondary = targetSecondaryImage !== undefined ? targetSecondaryImage : v.secondaryImage;
      const newImages = [newPrimary, newSecondary].filter(Boolean) as string[];

      await prisma.productVariant.update({
        where: { id: v.id },
        data: {
          image: newPrimary,
          secondaryImage: newSecondary,
          images: newImages,
        },
      });
    }

    await syncProductFromVariants(productId);

    const updatedVariants = await prisma.productVariant.findMany({
      where: { productId },
      orderBy: { createdAt: "asc" },
    });

    await createAuditLog({
      req,
      action: "APPLY_IMAGES_ALL_VARIANTS",
      entity: "ProductVariant",
      entityId: productId,
      details: {
        productId,
        variantCount: updatedVariants.length,
        image: targetImage,
        secondaryImage: targetSecondaryImage,
        slot,
      },
    });

    res.json({
      message: `Image applied to all ${updatedVariants.length} variants successfully`,
      variants: updatedVariants,
    });
  } catch (err: any) {
    logger.error("applyImagesToAllVariants error", err);
    res.status(500).json({ message: "Error applying images to all variants", error: err.message });
  }
};

