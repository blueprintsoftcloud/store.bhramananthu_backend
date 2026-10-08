import { Request, Response } from "express";
import mongoose from "mongoose";
import { Product, Category, ProductAttributeValue, OrderItem, ProductVariant } from "../models/mongoose";
import { deleteFromCloudinary, uploadToCloudinary } from "../config/cloudinary";
import logger from "../utils/logger";
import { createAuditLog } from "../utils/auditLog";
import { sanitizeRichText } from "../utils/sanitizeHtml";
import { categoryHasSubcategories } from "../utils/categoryTree";
import { buildAttributeValueWhereConditions } from "../utils/attributeFilter";
import { syncProductFromVariants } from "../utils/productVariant";

// GET /api/products/list?categoryId=xxx&page=1&limit=20&status=all|active|disabled|out_of_stock&q=&attributeValueIds=&sortBy=  (admin)
export const productList = async (req: Request, res: Response) => {
  try {
    const { categoryId, page = "1", limit = "20", status, q, attributeValueIds, sortBy, sort } =
      req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "20") || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;
    const where: Prisma.ProductWhereInput = categoryId ? { categoryId: categoryId as string } : {};

    if (status === "active") where.isActive = true;
    else if (status === "disabled") where.isActive = false;
    else if (status === "out_of_stock") where.stock = { lte: 0 };

    if (q?.trim()) {
      const term = q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { code: { contains: term, mode: "insensitive" } },
        { brand: { contains: term, mode: "insensitive" } },
      ];
    }

    if (attributeValueIds?.trim()) {
      const { conditions } = await buildAttributeValueWhereConditions(attributeValueIds);
      if (conditions.length > 0) {
        where.AND = [...((where.AND as Prisma.ProductWhereInput[]) ?? []), ...conditions];
      }
    }

    const sortOption = sortBy || sort || "newest";
    let orderBy: Prisma.ProductOrderByWithRelationInput | Prisma.ProductOrderByWithRelationInput[] = { createdAt: "desc" };

    switch (sortOption) {
      case "stock_asc":
        orderBy = [{ stock: "asc" }, { name: "asc" }];
        break;
      case "stock_desc":
        orderBy = [{ stock: "desc" }, { name: "asc" }];
        break;
      case "name_asc":
        orderBy = [{ name: "asc" }];
        break;
      case "name_desc":
        orderBy = [{ name: "desc" }];
        break;
      case "price_asc":
        orderBy = [{ price: "asc" }];
        break;
      case "price_desc":
        orderBy = [{ price: "desc" }];
        break;
      case "oldest":
        orderBy = [{ createdAt: "asc" }];
        break;
      case "newest":
      default:
        orderBy = [{ createdAt: "desc" }];
        break;
    }

    const [list, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          attributeValues: {
            include: {
              attribute: { select: { id: true, name: true, type: true } },
              attributeValue: { select: { id: true, value: true } },
              variant: { select: { id: true, options: true } },
            },
          },
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    // Product.price is only the CHEAPEST active variant's price (syncProductFromVariants)
    // — the admin product grid showing that bare number reads as "the" price even
    // though other options can cost much more. Attach each variant product's actual
    // min–max range so the card can show "₹X – ₹Y" instead of one misleadingly
    // specific figure. One batch query for the whole page rather than N+1.
    const productIds = list.map((p: any) => p.id);
    const variants = productIds.length
      ? await prisma.productVariant.findMany({
          where: { productId: { in: productIds }, isActive: true },
          select: { productId: true, priceOverride: true },
        })
      : [];
    const basePriceById = new Map<string, number>(list.map((p: any) => [p.id, p.price ?? 0]));
    const pricesByProduct = new Map<string, number[]>();
    for (const v of variants as any[]) {
      const key = String(v.productId);
      const bucket = pricesByProduct.get(key);
      const price = v.priceOverride ?? basePriceById.get(key) ?? 0;
      if (bucket) bucket.push(price);
      else pricesByProduct.set(key, [price]);
    }
    const listWithPriceRange = list.map((p: any) => {
      const prices = pricesByProduct.get(p.id);
      const priceRange = prices && prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
      return { ...p, priceRange };
    });

    res.status(200).json({
      list: listWithPriceRange,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("productList error", err);
    res
      .status(500)
      .json({ message: "Error in viewing product list", error: err.message });
  }
};

// POST /api/products/add  (admin)
export const productAdd = async (req: Request, res: Response) => {
  try {
    const { code, name, description, price, purchasePrice, category, stock, discount, brand, metaTitle, metaDescription } = req.body;
    const sizesRaw = req.body.sizes;
    const sizes: string[] = Array.isArray(sizesRaw) ? sizesRaw : (sizesRaw ? [sizesRaw] : []);

    if (!code || !name || !category || !price) {
      return res
        .status(400)
        .json({ message: "Code, name, category and price are required" });
    }

    const existing = await prisma.product.findFirst({
      where: { code },
    });
    if (existing) {
      return res
        .status(400)
        .json({ message: "A product with this code already exists" });
    }

    // Verify category exists
    const cat = await prisma.category.findUnique({ where: { id: category } });
    if (!cat) {
      return res.status(400).json({ message: "Category not found" });
    }
    if (await categoryHasSubcategories(category)) {
      return res.status(409).json({
        message: "Cannot add a product here: this category already has subcategories. Choose a leaf category instead.",
        code: "CATEGORY_HAS_SUBCATEGORIES",
      });
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    let imageUrl: string | null = null;
    if (files?.image?.[0]) {
      imageUrl = await uploadToCloudinary(files.image[0].buffer, `products/${code}`);
    }

    const additionalImages: string[] = [];
    if (files?.images?.length) {
      for (let i = 0; i < files.images.length; i++) {
        const url = await uploadToCloudinary(files.images[i].buffer, `products/${code}/gallery_${i}`);
        additionalImages.push(url);
      }
    }

    const product = await prisma.product.create({
      data: {
        code,
        name,
        description: sanitizeRichText(description) ?? null,
        brand: brand ?? null,
        metaTitle: metaTitle ?? null,
        metaDescription: metaDescription ?? null,
        price: parseFloat(price),
        purchasePrice: purchasePrice != null ? parseFloat(purchasePrice) : null,
        categoryId: category,
        image: imageUrl,
        images: additionalImages,
        stock: stock ? parseInt(stock) : 0,
        stockQuantity: stock ? parseInt(stock) : 0,
        sizes,
        discount: discount ? parseFloat(discount) : 0,
      },
    });

    // Save dynamic attribute values
    if (req.body.attributeValues) {
      try {
        type AttrEntry = { attributeId: string; attributeValueId?: string; textValue?: string; variantId?: string };
        const entries: AttrEntry[] = JSON.parse(req.body.attributeValues);
        const rows: { productId: string; attributeId: string; attributeValueId?: string; textValue?: string; variantId?: string | null }[] = [];
        for (const entry of entries) {
          if (!entry.attributeId) continue;
          // MULTISELECT: comma-separated value IDs
          if (entry.attributeValueId && entry.attributeValueId.includes(",")) {
            for (const vid of entry.attributeValueId.split(",").filter(Boolean)) {
              rows.push({ productId: product.id, attributeId: entry.attributeId, attributeValueId: vid, variantId: entry.variantId || null });
            }
          } else if (entry.attributeValueId) {
            rows.push({ productId: product.id, attributeId: entry.attributeId, attributeValueId: entry.attributeValueId, variantId: entry.variantId || null });
          } else if (entry.textValue !== undefined) {
            rows.push({ productId: product.id, attributeId: entry.attributeId, textValue: String(entry.textValue), variantId: entry.variantId || null });
          }
        }
        if (rows.length > 0) {
          await prisma.productAttributeValue.createMany({ data: rows });
        }
      } catch (attrErr) {
        // Tolerate a malformed payload (bad JSON, garbage ids) without failing the
        // whole product add — but still log it, since this same bare catch previously
        // masked createMany being unimplemented on the Prisma bridge for a long time.
        logger.error("productAdd: failed to save attribute values", attrErr);
      }
    }

    await createAuditLog({ req, action: "ADD_PRODUCT", entity: "Product", entityId: product.id, details: { code: product.code, name: product.name, price: product.price, purchasePrice: product.purchasePrice, category: cat.name } });

    // `product` predates the attribute rows written just above — the frontend uses
    // this response to update its local product list/cache, so returning it as-is
    // would make a freshly-tagged product look untagged until a full page reload.
    // Re-fetch with attributeValues included so the response actually reflects what
    // was just saved (see productUpdate below for the same fix).
    const finalProduct = await prisma.product.findUnique({
      where: { id: product.id },
      include: {
        category: { select: { id: true, name: true } },
        attributeValues: {
          include: {
            attribute: { select: { id: true, name: true, type: true } },
            attributeValue: { select: { id: true, value: true } },
            variant: { select: { id: true, options: true } },
          },
        },
      },
    });

    res.status(201).json({ message: "Product added successfully", product: finalProduct });
  } catch (err: any) {
    logger.error("productAdd error", err);
    res
      .status(500)
      .json({ message: "Error in product adding", error: err.message });
  }
};

// PUT /api/products/update/:id  (admin)
export const productUpdate = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { code, name, description, price, purchasePrice, category, stock, discount, brand, metaTitle, metaDescription } = req.body;
    const sizesRaw = req.body.sizes;
    const sizes: string[] | undefined = sizesRaw !== undefined
      ? (Array.isArray(sizesRaw) ? sizesRaw : [sizesRaw])
      : undefined;

    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) {
      return res
        .status(404)
        .json({ message: "Cannot find product for updating" });
    }

    // Once a product has variants, its own stock/price/purchasePrice/discount are all
    // derived (see utils/productVariant.ts's syncProductFromVariants — kept in sync
    // from active variant stock and whichever variant is currently cheapest, every
    // time a variant changes) — not something this form should be able to overwrite
    // with a stale number; a direct edit here would just get silently reverted by the
    // next variant change anyway. The edit form hides all four fields once a product
    // has variants; this guard is what actually protects them regardless of what the
    // client sends. To change what a variant without its own override falls back to,
    // set that variant's own priceOverride/purchasePriceOverride/discountOverride via
    // Manage Variants instead.
    const hasActiveVariants = (await prisma.productVariant.count({ where: { productId: id, isActive: true } })) > 0;
    const stockOverride = hasActiveVariants ? undefined : stock;
    const priceInput = hasActiveVariants ? undefined : price;
    const purchasePriceInput = hasActiveVariants ? undefined : purchasePrice;
    const discountInput = hasActiveVariants ? undefined : discount;

    // Same pre-check productAdd already does — catch a duplicate code before it ever
    // reaches the DB's unique index, so the customer gets a clear message instead of a
    // raw E11000 error surfacing through the generic catch block below.
    if (code && code !== existing.code) {
      const dupe = await prisma.product.findFirst({ where: { code } });
      if (dupe && dupe.id !== id) {
        return res
          .status(409)
          .json({ message: "A product with this code already exists" });
      }
    }

    // `category` was previously reassigned with no existence/rule check at all —
    // only validate when it's an actual recategorize, same guard style as
    // categoryUpdate's reparent check.
    if (category && category !== String(existing.categoryId)) {
      const cat = await prisma.category.findUnique({ where: { id: category } });
      if (!cat) {
        return res.status(400).json({ message: "Category not found" });
      }
      if (await categoryHasSubcategories(category)) {
        return res.status(409).json({
          message: "Cannot move a product here: this category already has subcategories. Choose a leaf category instead.",
          code: "CATEGORY_HAS_SUBCATEGORIES",
        });
      }
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    let imageUrl = existing.image;
    if (files?.image?.[0]) {
      imageUrl = await uploadToCloudinary(
        files.image[0].buffer,
        `products/${code ?? existing.code}`,
      );
      // Replacing the main image orphaned the old one on Cloudinary forever — clean it up.
      if (existing.image) {
        await deleteFromCloudinary(existing.image).catch((e: unknown) =>
          logger.warn("Failed to delete replaced product image from Cloudinary", e),
        );
      }
    }

    // Handle additional images
    let updatedImages = [...(existing.images ?? [])];
    if (req.body.removeImages) {
      try {
        const toRemove: string[] = JSON.parse(req.body.removeImages);
        updatedImages = updatedImages.filter((img) => !toRemove.includes(img));
        // Explicitly removed gallery images were only dropped from the array, never
        // actually deleted from Cloudinary — clean them up too.
        await Promise.all(
          toRemove.map((url) =>
            deleteFromCloudinary(url).catch((e: unknown) =>
              logger.warn("Failed to delete removed gallery image from Cloudinary", e),
            ),
          ),
        );
      } catch { /* ignore parse errors */ }
    }
    if (files?.images?.length) {
      for (let i = 0; i < files.images.length; i++) {
        const url = await uploadToCloudinary(
          files.images[i].buffer,
          `products/${code ?? existing.code}/gallery_${Date.now()}_${i}`,
        );
        updatedImages.push(url);
      }
    }

    const updated = await prisma.product.update({
      where: { id },
      data: {
        code: code ?? existing.code,
        name: name ?? existing.name,
        description: description !== undefined ? sanitizeRichText(description) : existing.description,
        brand: brand !== undefined ? (brand.trim() || null) : existing.brand,
        metaTitle: metaTitle !== undefined ? metaTitle : existing.metaTitle,
        metaDescription: metaDescription !== undefined ? metaDescription : existing.metaDescription,
        price: priceInput ? parseFloat(priceInput) : existing.price,
        purchasePrice: purchasePriceInput !== undefined ? (purchasePriceInput !== null ? parseFloat(purchasePriceInput) : null) : existing.purchasePrice,
        categoryId: category ?? existing.categoryId,
        image: imageUrl,
        images: updatedImages,
        stock: stockOverride !== undefined ? parseInt(stockOverride) : existing.stock,
        stockQuantity: stockOverride !== undefined ? parseInt(stockOverride) : existing.stockQuantity,
        sizes: sizes ?? existing.sizes,
        discount: discountInput !== undefined ? parseFloat(discountInput) : existing.discount,
      },
      include: { category: { select: { id: true, name: true } } },
    });

    // Replace attribute values: delete old rows, insert new ones
    if (req.body.attributeValues !== undefined) {
      await prisma.productAttributeValue.deleteMany({ where: { productId: id } });
      try {
        type AttrEntry = { attributeId: string; attributeValueId?: string; textValue?: string; variantId?: string };
        const entries: AttrEntry[] = JSON.parse(req.body.attributeValues);
        const rows: { productId: string; attributeId: string; attributeValueId?: string; textValue?: string; variantId?: string | null }[] = [];
        for (const entry of entries) {
          if (!entry.attributeId) continue;
          if (entry.attributeValueId && entry.attributeValueId.includes(",")) {
            for (const vid of entry.attributeValueId.split(",").filter(Boolean)) {
              rows.push({ productId: id, attributeId: entry.attributeId, attributeValueId: vid, variantId: entry.variantId || null });
            }
          } else if (entry.attributeValueId) {
            rows.push({ productId: id, attributeId: entry.attributeId, attributeValueId: entry.attributeValueId, variantId: entry.variantId || null });
          } else if (entry.textValue !== undefined) {
            rows.push({ productId: id, attributeId: entry.attributeId, textValue: String(entry.textValue), variantId: entry.variantId || null });
          }
        }
        if (rows.length > 0) {
          await prisma.productAttributeValue.createMany({ data: rows });
        }
      } catch (attrErr) {
        logger.error("productUpdate: failed to save attribute values", attrErr);
      }
    }

    await createAuditLog({ req, action: "UPDATE_PRODUCT", entity: "Product", entityId: updated.id, details: { code: updated.code, name: updated.name, price: updated.price, purchasePrice: updated.purchasePrice } });

    if (hasActiveVariants) {
      await syncProductFromVariants(updated.id);
    }

    // `updated` predates the attribute-value delete+recreate above (and never even
    // included attributeValues to begin with) — re-fetch so the response reflects
    // what was actually just saved. Without this, the frontend's local product cache
    // gets overwritten with a version that looks untagged, and editing that same
    // product again before a page reload would silently wipe its real attribute data.
    const finalProduct = await prisma.product.findUnique({
      where: { id: updated.id },
      include: {
        category: { select: { id: true, name: true } },
        attributeValues: {
          include: {
            attribute: { select: { id: true, name: true, type: true } },
            attributeValue: { select: { id: true, value: true } },
            variant: { select: { id: true, options: true } },
          },
        },
      },
    });

    res
      .status(200)
      .json({ message: "Product updated successfully", product: finalProduct });
  } catch (err: any) {
    logger.error("productUpdate error", err);
    // Belt-and-braces for the race window between the pre-check above and this write
    // (e.g. two concurrent updates picking the same code) — same convention as
    // staff.controller.ts's createStaff.
    if (err?.code === 11000) {
      res.status(409).json({ message: "A product with this code already exists" });
      return;
    }
    res
      .status(500)
      .json({ message: "Error in product update", error: err.message });
  }
};

// DELETE /api/products/delete/:id  (admin)
export const productDelete = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      return res
        .status(404)
        .json({ message: "Cannot find product for deleting" });
    }

    // Block deletion if any open orders contain this product.
    // Auto-cancelling paid/confirmed orders on product delete causes silent
    // revenue loss — admin must resolve orders first.
    const openOrderCount = await prisma.order.count({
      where: {
        orderStatus: { notIn: ["DELIVERED", "CANCELLED", "RETURNED"] },
        items: { some: { productId: id } },
      },
    });

    if (openOrderCount > 0) {
      return res.status(409).json({
        message: `Cannot delete: ${openOrderCount} open order${openOrderCount > 1 ? "s" : ""} contain this product. Wait until all orders are delivered, cancelled, or returned before deleting.`,
      });
    }

    // Remove from all carts
    await prisma.cartItem.deleteMany({ where: { productId: id } });

    // Remove from wishlists
    await prisma.wishlist.deleteMany({ where: { productId: id } });

    // Delete main image + every gallery image + all variant images from Cloudinary
    const variants = await prisma.productVariant.findMany({ where: { productId: id } });
    const variantImagesToDelete = variants
      .flatMap((v: any) => [v.image, v.secondaryImage, ...(v.images ?? [])])
      .filter(Boolean) as string[];

    const imagesToDelete = [
      ...new Set([product.image, ...(product.images ?? []), ...variantImagesToDelete].filter(Boolean) as string[]),
    ];

    await Promise.all(
      imagesToDelete.map((url) =>
        deleteFromCloudinary(url).catch((e: unknown) =>
          logger.warn("Failed to delete product/variant image from Cloudinary", e),
        ),
      ),
    );

    // Delete variant records before product delete
    await prisma.productVariant.deleteMany({ where: { productId: id } });
    await prisma.product.delete({ where: { id } });
    await createAuditLog({ req, action: "DELETE_PRODUCT", entity: "Product", entityId: id, details: { code: product.code, name: product.name } });

    res.status(200).json({ message: "Product deleted successfully" });
  } catch (err: any) {
    logger.error("productDelete error", err);
    res
      .status(500)
      .json({ message: "Error in product deleting", error: err.message });
  }
};

// PATCH /api/product/:id/status (admin)
export const productToggleStatus = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { isActive } = req.body;

    if (isActive === undefined || typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive status must be a boolean" });
    }

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const updated = await prisma.product.update({
      where: { id },
      data: { isActive },
    });

    await createAuditLog({
      req,
      action: isActive ? "ENABLE_PRODUCT" : "DISABLE_PRODUCT",
      entity: "Product",
      entityId: id,
      details: { name: product.name, isActive },
    });

    res.status(200).json({
      message: `Product ${isActive ? "enabled" : "disabled"} successfully`,
      product: updated,
    });
  } catch (err: any) {
    logger.error("productToggleStatus error", err);
    res.status(500).json({ message: "Error toggling product status", error: err.message });
  }
};

// GET /api/product/stock-summary (admin)
export const adminStockSummary = async (req: Request, res: Response) => {
  try {
    const [allProducts, variants] = await Promise.all([
      Product.find({}).select("id _id name stock stockQuantity price basePrice purchasePrice isActive").lean(),
      ProductVariant.find({}).select("id _id productId stock priceOverride isActive").lean(),
    ]);

    const totalProducts = allProducts.length;
    let inStockProducts = 0;
    let lowStockProducts = 0;
    let outOfStockProducts = 0;
    let activeProducts = 0;
    let totalInventoryUnits = 0;
    let totalInventoryValue = 0;

    for (const p of allProducts as any[]) {
      if (p.isActive) activeProducts++;
      const stock = typeof p.stock === "number" ? p.stock : (p.stockQuantity ?? 0);
      totalInventoryUnits += Math.max(0, stock);
      const unitCost = p.purchasePrice ?? p.price ?? 0;
      totalInventoryValue += Math.max(0, stock) * unitCost;

      if (stock <= 0) {
        outOfStockProducts++;
      } else if (stock <= 5) {
        lowStockProducts++;
      } else {
        inStockProducts++;
      }
    }

    res.status(200).json({
      summary: {
        totalProducts,
        activeProducts,
        inStockProducts,
        lowStockProducts,
        outOfStockProducts,
        totalVariants: variants.length,
        totalInventoryUnits,
        totalInventoryValue: Math.round(totalInventoryValue),
      },
    });
  } catch (err: any) {
    logger.error("adminStockSummary error", err);
    res.status(500).json({ message: "Error loading inventory summary", error: err.message });
  }
};

// GET /api/product/detail/:id (admin)
export const productAdminDetail = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true, image: true } },
        attributeValues: {
          include: {
            attribute: { select: { id: true, name: true, type: true } },
            attributeValue: { select: { id: true, value: true } },
            variant: { select: { id: true, options: true } },
          },
        },
      },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const variants = await prisma.productVariant.findMany({
      where: { productId: id },
      orderBy: { createdAt: "asc" },
    });

    // Compute sales metrics from OrderItem
    let salesStats = { totalUnitsSold: 0, totalRevenue: 0, totalOrdersCount: 0 };
    try {
      const salesAggregate = await OrderItem.aggregate([
        { $match: { productId: new mongoose.Types.ObjectId(id) } },
        {
          $lookup: {
            from: "orders",
            localField: "orderId",
            foreignField: "_id",
            as: "order",
          },
        },
        { $unwind: "$order" },
        { $match: { "order.orderStatus": { $nin: ["CANCELLED", "RETURNED"] } } },
        {
          $group: {
            _id: "$productId",
            totalUnitsSold: { $sum: "$quantity" },
            totalRevenue: { $sum: { $multiply: ["$quantity", "$price"] } },
            totalOrders: { $addToSet: "$orderId" },
          },
        },
      ]);

      if (salesAggregate && salesAggregate[0]) {
        salesStats = {
          totalUnitsSold: salesAggregate[0].totalUnitsSold ?? 0,
          totalRevenue: Math.round(salesAggregate[0].totalRevenue ?? 0),
          totalOrdersCount: Array.isArray(salesAggregate[0].totalOrders) ? salesAggregate[0].totalOrders.length : 0,
        };
      }
    } catch (salesErr) {
      logger.warn("productAdminDetail: salesAggregate failed, falling back to 0", salesErr);
    }

    res.status(200).json({
      product,
      variants,
      salesStats,
    });
  } catch (err: any) {
    logger.error("productAdminDetail error", err);
    res.status(500).json({ message: "Error fetching product details", error: err.message });
  }
};

// PATCH /api/product/:id/quick-stock (admin)
export const quickStockUpdate = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { stock, variantStocks } = req.body as {
      stock?: number;
      variantStocks?: Record<string, number>;
    };

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const hasVariants = (await prisma.productVariant.count({ where: { productId: id } })) > 0;

    if (hasVariants && variantStocks && typeof variantStocks === "object") {
      // Update individual variant stocks
      for (const [vId, vStock] of Object.entries(variantStocks)) {
        if (typeof vStock === "number" && vStock >= 0) {
          await prisma.productVariant.update({
            where: { id: vId },
            data: { stock: Math.floor(vStock) },
          });
        }
      }
      await syncProductFromVariants(id);
    } else if (typeof stock === "number" && stock >= 0) {
      await prisma.product.update({
        where: { id },
        data: { stock: Math.floor(stock), stockQuantity: Math.floor(stock) },
      });
    }

    await createAuditLog({
      req,
      action: "UPDATE_PRODUCT_STOCK",
      entity: "Product",
      entityId: id,
      details: {
        productName: product.name,
        newStock: stock,
        variantStocks,
      },
    });

    const updated = await prisma.product.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true } },
      },
    });

    const updatedVariants = await prisma.productVariant.findMany({
      where: { productId: id },
    });

    res.status(200).json({
      message: "Stock updated successfully",
      product: updated,
      variants: updatedVariants,
    });
  } catch (err: any) {
    logger.error("quickStockUpdate error", err);
    res.status(500).json({ message: "Error updating stock", error: err.message });
  }
};

