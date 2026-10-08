// src/controllers/homeBanner.controller.ts
// Manages home-page banner content stored in the HomeBanner table.
// Types:
//   DISCOUNT_PANEL — image panels in the discount/offer grid section
//   CAROUSEL_ITEM  — slides in the "Curated Looks" carousel
//   PROMO_BANNER   — full-width promotional banner carousel (below hero)
// Section-level header text (title / subtitle) is stored in AppSetting.

import { Request, Response } from "express";
import { HomeBanner } from "../models/mongoose";
import { uploadToCloudinary, deleteFromCloudinary } from "../config/cloudinary";
import logger from "../utils/logger";
import { createAuditLog } from "../utils/auditLog";
import { getCached, invalidateCache } from "../utils/cache";

/** Public homepage payload changes rarely and is read on nearly every storefront page load. */
const PUBLIC_BANNERS_CACHE_KEY = "home-banners:public";

const invalidatePublicBannersCache = () =>
  Promise.all(
    ["all", ...VALID_TYPES].map((t) => invalidateCache(`${PUBLIC_BANNERS_CACHE_KEY}:${t}`)),
  );

const VALID_TYPES = ["DISCOUNT_PANEL", "CAROUSEL_ITEM", "PROMO_BANNER"] as const;
type BannerType = (typeof VALID_TYPES)[number];

// ─── Public endpoints ─────────────────────────────────────────────────────────

// GET /api/home-banners?type=DISCOUNT_PANEL   (public, no auth)
export const getPublicBanners = async (req: Request, res: Response) => {
  try {
    const { type } = req.query as { type?: string };
    const validType = type && VALID_TYPES.includes(type as BannerType) ? type : undefined;

    const payload = await getCached(`${PUBLIC_BANNERS_CACHE_KEY}:${validType ?? "all"}`, async () => {
      const where: Record<string, unknown> = { isActive: true };
      if (validType) where.type = validType;

      const banners = (await prisma.homeBanner.findMany({
        where,
        orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
      })) || [];

      // Return section header settings for all homepage sections
      const headerSettings = (await prisma.appSetting.findMany({
        where: {
          key: {
            in: [
              "HOME_DISCOUNT_TITLE", "HOME_DISCOUNT_SUBTITLE",
              "HOME_CAROUSEL_TITLE", "HOME_CAROUSEL_SUBTITLE",
              "HOME_FEATURED_TITLE", "HOME_FEATURED_SUBTITLE",
              "HOME_PROMO_TITLE", "HOME_PROMO_SUBTITLE",
            ],
          },
        },
      })) || [];

      const headers: Record<string, string> = {};
      for (const s of headerSettings) {
        headers[s.key] = s.value;
      }

      return {
        banners,
        discountSection: {
          title: headers["HOME_DISCOUNT_TITLE"] ?? "SPECIAL OFFERS & DISCOUNTS",
          subtitle: headers["HOME_DISCOUNT_SUBTITLE"] ?? "Authentic Ayurvedic Formulations at Great Value",
        },
        carouselSection: {
          title: headers["HOME_CAROUSEL_TITLE"] ?? "Curated Looks For You",
          subtitle: headers["HOME_CAROUSEL_SUBTITLE"] ?? "",
        },
        featuredSection: {
          title: headers["HOME_FEATURED_TITLE"] ?? "Featured Collections",
          subtitle: headers["HOME_FEATURED_SUBTITLE"] ?? "",
        },
        promoSection: {
          title: headers["HOME_PROMO_TITLE"] ?? "Special Offers",
          subtitle: headers["HOME_PROMO_SUBTITLE"] ?? "",
        },
      };
    });

    res.json(payload);
  } catch (err: any) {
    logger.error("getPublicBanners error", err);
    res.status(500).json({ message: "Failed to fetch banners" });
  }
};

// ─── Admin endpoints ──────────────────────────────────────────────────────────

// GET /api/home-banners/admin   (admin / super-admin)
export const getAllBannersAdmin = async (_req: Request, res: Response) => {
  try {
    const [banners, headerSettings] = await Promise.all([
      prisma.homeBanner.findMany({
        orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
      }),
      prisma.appSetting.findMany({
        where: {
          key: {
            in: [
              "HOME_DISCOUNT_TITLE", "HOME_DISCOUNT_SUBTITLE",
              "HOME_CAROUSEL_TITLE", "HOME_CAROUSEL_SUBTITLE",
              "HOME_FEATURED_TITLE", "HOME_FEATURED_SUBTITLE",
              "HOME_PROMO_TITLE", "HOME_PROMO_SUBTITLE",
            ],
          },
        },
      }),
    ]);

    const headers: Record<string, string> = {};
    for (const s of headerSettings) {
      headers[s.key] = s.value;
    }

    res.json({
      banners,
      discountSection: {
        title: headers["HOME_DISCOUNT_TITLE"] ?? "SHOP NOW AND SAVE 30%",
        subtitle: headers["HOME_DISCOUNT_SUBTITLE"] ?? "Grace at a Great Price! Sarees on Discount",
      },
      carouselSection: {
        title: headers["HOME_CAROUSEL_TITLE"] ?? "Curated Looks For You",
        subtitle: headers["HOME_CAROUSEL_SUBTITLE"] ?? "",
      },
      featuredSection: {
        title: headers["HOME_FEATURED_TITLE"] ?? "Featured Collections",
        subtitle: headers["HOME_FEATURED_SUBTITLE"] ?? "",
      },
      promoSection: {
        title: headers["HOME_PROMO_TITLE"] ?? "Special Offers",
        subtitle: headers["HOME_PROMO_SUBTITLE"] ?? "",
      },
    });
  } catch (err: any) {
    logger.error("getAllBannersAdmin error", err);
    res.status(500).json({ message: "Failed to fetch banners" });
  }
};

// PUT /api/home-banners/discount-header   (admin / super-admin)
export const updateDiscountHeader = async (req: Request, res: Response) => {
  try {
    const { title, subtitle } = req.body as { title?: string; subtitle?: string };

    const ops: Promise<unknown>[] = [];
    if (title !== undefined) {
      ops.push(
        prisma.appSetting.upsert({
          where: { key: "HOME_DISCOUNT_TITLE" },
          update: { value: title },
          create: { key: "HOME_DISCOUNT_TITLE", value: title },
        }),
      );
    }
    if (subtitle !== undefined) {
      ops.push(
        prisma.appSetting.upsert({
          where: { key: "HOME_DISCOUNT_SUBTITLE" },
          update: { value: subtitle },
          create: { key: "HOME_DISCOUNT_SUBTITLE", value: subtitle },
        }),
      );
    }

    await Promise.all(ops);
    await invalidatePublicBannersCache();
    await createAuditLog({ req, action: "UPDATE_HOMEPAGE_DISCOUNT_HEADER", entity: "AppSetting", details: { title, subtitle } });

    res.json({ message: "Discount section header updated", title, subtitle });
  } catch (err: any) {
    logger.error("updateDiscountHeader error", err);
    res.status(500).json({ message: "Failed to update header" });
  }
};

// PUT /api/home-banners/carousel-header   (admin / super-admin)
export const updateCarouselHeader = async (req: Request, res: Response) => {
  try {
    const { title, subtitle } = req.body as { title?: string; subtitle?: string };
    const ops: Promise<unknown>[] = [];
    if (title !== undefined) {
      ops.push(
        prisma.appSetting.upsert({
          where: { key: "HOME_CAROUSEL_TITLE" },
          update: { value: title },
          create: { key: "HOME_CAROUSEL_TITLE", value: title },
        }),
      );
    }
    if (subtitle !== undefined) {
      ops.push(
        prisma.appSetting.upsert({
          where: { key: "HOME_CAROUSEL_SUBTITLE" },
          update: { value: subtitle },
          create: { key: "HOME_CAROUSEL_SUBTITLE", value: subtitle },
        }),
      );
    }
    await Promise.all(ops);
    await invalidatePublicBannersCache();
    await createAuditLog({ req, action: "UPDATE_HOMEPAGE_CAROUSEL_HEADER", entity: "AppSetting", details: { title, subtitle } });
    res.json({ message: "Carousel section header updated", title, subtitle });
  } catch (err: any) {
    logger.error("updateCarouselHeader error", err);
    res.status(500).json({ message: "Failed to update header" });
  }
};

// PUT /api/home-banners/featured-header   (admin / super-admin)
export const updateFeaturedHeader = async (req: Request, res: Response) => {
  try {
    const { title, subtitle } = req.body as { title?: string; subtitle?: string };
    const ops: Promise<unknown>[] = [];
    if (title !== undefined) {
      ops.push(
        prisma.appSetting.upsert({
          where: { key: "HOME_FEATURED_TITLE" },
          update: { value: title },
          create: { key: "HOME_FEATURED_TITLE", value: title },
        }),
      );
    }
    if (subtitle !== undefined) {
      ops.push(
        prisma.appSetting.upsert({
          where: { key: "HOME_FEATURED_SUBTITLE" },
          update: { value: subtitle },
          create: { key: "HOME_FEATURED_SUBTITLE", value: subtitle },
        }),
      );
    }
    await Promise.all(ops);
    await invalidatePublicBannersCache();
    await createAuditLog({ req, action: "UPDATE_HOMEPAGE_FEATURED_HEADER", entity: "AppSetting", details: { title, subtitle } });
    res.json({ message: "Featured section header updated", title, subtitle });
  } catch (err: any) {
    logger.error("updateFeaturedHeader error", err);
    res.status(500).json({ message: "Failed to update header" });
  }
};

// PUT /api/home-banners/promo-header   (admin / super-admin)
export const updatePromoHeader = async (req: Request, res: Response) => {
  try {
    const { title, subtitle } = req.body as { title?: string; subtitle?: string };
    const ops: Promise<unknown>[] = [];
    if (title !== undefined) {
      ops.push(
        prisma.appSetting.upsert({
          where: { key: "HOME_PROMO_TITLE" },
          update: { value: title },
          create: { key: "HOME_PROMO_TITLE", value: title },
        }),
      );
    }
    if (subtitle !== undefined) {
      ops.push(
        prisma.appSetting.upsert({
          where: { key: "HOME_PROMO_SUBTITLE" },
          update: { value: subtitle },
          create: { key: "HOME_PROMO_SUBTITLE", value: subtitle },
        }),
      );
    }
    await Promise.all(ops);
    await invalidatePublicBannersCache();
    await createAuditLog({ req, action: "UPDATE_HOMEPAGE_PROMO_HEADER", entity: "AppSetting", details: { title, subtitle } });
    res.json({ message: "Promo banner section header updated", title, subtitle });
  } catch (err: any) {
    logger.error("updatePromoHeader error", err);
    res.status(500).json({ message: "Failed to update header" });
  }
};

// GET /api/home-banners/featured-products  (admin / super-admin)
// Returns ALL products with their isFeatured status so the admin can toggle them.
export const getFeaturedProducts = async (req: Request, res: Response) => {
  try {
    const { search = "", page = "1", limit = "20" } = req.query as Record<string, string | undefined>;
    const pageSize = Math.min(Math.max(parseInt(limit ?? "20") || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;
    const where = {
      isActive: true,
      ...(search
        ? { name: { contains: search as string, mode: "insensitive" as const } }
        : {}),
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          code: true,
          image: true,
          price: true,
          isFeatured: true,
          featuredOrder: true,
          category: { select: { id: true, name: true } },
        },
        orderBy: [{ isFeatured: "desc" }, { featuredOrder: "asc" }, { name: "asc" }],
        skip,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    res.json({
      products,
      pagination: { total, page: Math.max(parseInt(page ?? "1") || 1, 1), limit: pageSize, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err: any) {
    logger.error("getFeaturedProducts error", err);
    res.status(500).json({ message: "Failed to fetch featured products" });
  }
};

// PATCH /api/home-banners/featured-products/:productId/toggle  (admin / super-admin)
export const toggleFeaturedProduct = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const updated = await prisma.product.update({
      where: { id: productId },
      data: { isFeatured: !product.isFeatured },
      select: { id: true, name: true, isFeatured: true, featuredOrder: true },
    });

    await createAuditLog({
      req,
      action: updated.isFeatured ? "FEATURE_PRODUCT" : "UNFEATURE_PRODUCT",
      entity: "Product",
      entityId: productId,
      details: { name: product.name, isFeatured: updated.isFeatured },
    });
    res.json(updated);
  } catch (err: any) {
    logger.error("toggleFeaturedProduct error", err);
    res.status(500).json({ message: "Failed to toggle featured status" });
  }
};

// PATCH /api/home-banners/featured-products/:productId/order  (admin / super-admin)
export const setFeaturedProductOrder = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;
    const { order } = req.body as { order?: number };
    if (order === undefined || isNaN(Number(order))) {
      return res.status(400).json({ message: "order must be a number" });
    }
    const updated = await prisma.product.update({
      where: { id: productId },
      data: { featuredOrder: Number(order) },
      select: { id: true, name: true, isFeatured: true, featuredOrder: true },
    });
    res.json(updated);
  } catch (err: any) {
    logger.error("setFeaturedProductOrder error", err);
    res.status(500).json({ message: "Failed to set featured order" });
  }
};

// POST /api/home-banners   (admin / super-admin)  multipart/form-data
export const createBanner = async (req: Request, res: Response) => {
  try {
    const type = req.body.type as string | undefined;
    const title = req.body.title as string | undefined;
    const discount = req.body.discount as string | undefined;
    const description = req.body.description as string | undefined;
    const sortOrder = req.body.sortOrder as string | undefined;

    if (!type || !VALID_TYPES.includes(type as BannerType)) {
      return res.status(400).json({ message: "type must be DISCOUNT_PANEL, CAROUSEL_ITEM, or PROMO_BANNER" });
    }
    if (!title?.trim()) return res.status(400).json({ message: "title is required" });
    if (!req.file) return res.status(400).json({ message: "image file is required" });

    const imageUrl = await uploadToCloudinary(req.file.buffer, "home-banners");

    const banner = await prisma.homeBanner.create({
      data: {
        type,
        title: title.trim(),
        image: imageUrl,
        discount: discount?.trim() || null,
        description: description?.trim() || null,
        sortOrder: sortOrder ? parseInt(sortOrder, 10) : 0,
        isActive: true,
      },
    });

    await invalidatePublicBannersCache();
    await createAuditLog({ req, action: "CREATE_HOME_BANNER", entity: "HomeBanner", entityId: banner.id, details: { type, title } });

    res.status(201).json(banner);
  } catch (err: any) {
    logger.error("createBanner error", err);
    res.status(500).json({ message: "Failed to create banner" });
  }
};

// PUT /api/home-banners/:id   (admin / super-admin)  multipart/form-data
export const updateBanner = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const title = req.body.title as string | undefined;
    const discount = req.body.discount as string | undefined;
    const description = req.body.description as string | undefined;
    const sortOrder = req.body.sortOrder as string | undefined;
    const isActive = req.body.isActive as string | undefined;

    const existing = await prisma.homeBanner.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Banner not found" });

    let imageUrl = existing.image;
    if (req.file) {
      // Upload new image and delete old one
      imageUrl = await uploadToCloudinary(req.file.buffer, "home-banners");
      await deleteFromCloudinary(existing.image).catch(() => { });
    }

    const banner = await prisma.homeBanner.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: title.trim() }),
        image: imageUrl,
        ...(discount !== undefined && { discount: discount.trim() || null }),
        ...(description !== undefined && { description: description.trim() || null }),
        ...(sortOrder !== undefined && { sortOrder: parseInt(sortOrder, 10) }),
        ...(isActive !== undefined && { isActive: isActive === "true" }),
      },
    });

    await invalidatePublicBannersCache();
    await createAuditLog({ req, action: "UPDATE_HOME_BANNER", entity: "HomeBanner", entityId: id, details: { title } });

    res.json(banner);
  } catch (err: any) {
    logger.error("updateBanner error", err);
    res.status(500).json({ message: "Failed to update banner" });
  }
};

// DELETE /api/home-banners/:id   (admin / super-admin)
export const deleteBanner = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);

    const existing = await prisma.homeBanner.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Banner not found" });

    await prisma.homeBanner.delete({ where: { id } });
    await deleteFromCloudinary(existing.image).catch(() => { });

    await invalidatePublicBannersCache();
    await createAuditLog({ req, action: "DELETE_HOME_BANNER", entity: "HomeBanner", entityId: id, details: {} });

    res.json({ message: "Banner deleted" });
  } catch (err: any) {
    logger.error("deleteBanner error", err);
    res.status(500).json({ message: "Failed to delete banner" });
  }
};

// PATCH /api/home-banners/:id/toggle   (admin / super-admin)
export const toggleBanner = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.homeBanner.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Banner not found" });

    const banner = await prisma.homeBanner.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });
    await invalidatePublicBannersCache();

    res.json(banner);
  } catch (err: any) {
    logger.error("toggleBanner error", err);
    res.status(500).json({ message: "Failed to toggle banner" });
  }
};
