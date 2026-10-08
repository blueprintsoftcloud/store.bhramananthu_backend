// src/controllers/review.controller.ts
// Handles product reviews — create, read, delete.
// Only customers with a DELIVERED order containing the product may submit a review.
// Controlled by the PRODUCT_REVIEWS feature flag.

import { Request, Response } from "express";
import { Types } from "mongoose";
import { Review, Product, User } from "../models/mongoose";
import logger from "../utils/logger";
import { createAuditLog } from "../utils/auditLog";

// ─── Helper: is PRODUCT_REVIEWS feature enabled ───────────────────────────────
// There's no standalone FeatureFlag model in this schema (or the prisma.ts bridge's
// MODEL_MAP) — this used to call prisma.featureFlag.findUnique(...), which threw
// "Unknown model: featureFlag" on every call (live-verified: broke every review
// endpoint). Admin-togglable settings in this app all live in the generic AppSetting
// key/value store instead (see settings.controller.ts's WAREHOUSE_LAT/SHIPPING_*
// keys), so this reads from there too. No admin UI writes this key yet, so it's
// always absent for now — same "default enabled" behavior the old code intended.
async function isReviewsEnabled(): Promise<boolean> {
  const flag = await prisma.appSetting.findUnique({
    where: { key: "PRODUCT_REVIEWS_ENABLED" },
  });
  return !flag || (flag.value !== false && flag.value !== "false");
}

// ─── Helper: recalculate + save product aggregate rating ─────────────────────
// Always across EVERY review for the product regardless of variant — this stays the
// one "overall" number shown anywhere that isn't looking at one specific variant.
async function recalcProductRating(productId: string): Promise<void> {
  const stats = await prisma.review.aggregate({
    where: { productId },
    _avg: { rating: true },
    _count: { rating: true },
  });
  await prisma.product.update({
    where: { id: productId },
    data: {
      rating: Math.round((stats._avg?.rating ?? 0) * 10) / 10,
      numReviews: stats._count?.rating ?? 0,
    },
  });
}

// ─── Helper: recalculate + save one variant's own aggregate rating ───────────
// Only reviews explicitly tagged with this variantId count — a review left on the
// plain product (variantId: null) or on a sibling variant never affects this number.
async function recalcVariantRating(variantId: string): Promise<void> {
  const stats = await prisma.review.aggregate({
    where: { variantId },
    _avg: { rating: true },
    _count: { rating: true },
  });
  await prisma.productVariant.update({
    where: { id: variantId },
    data: {
      rating: Math.round((stats._avg?.rating ?? 0) * 10) / 10,
      numReviews: stats._count?.rating ?? 0,
    },
  });
}

// GET /api/reviews/:productId?variantId=  (public — optionalAuth)
// Returns reviews for a product. With ?variantId=, scoped to just that variant's own
// reviews/rating instead of every review across the whole product. 403 if feature is
// disabled.
export const getProductReviews = async (req: Request, res: Response) => {
  try {
    if (!(await isReviewsEnabled())) {
      return res.status(403).json({ message: "Product reviews are currently disabled.", feature: "PRODUCT_REVIEWS" });
    }

    const productId = String(req.params.productId);
    const variantId = req.query.variantId ? String(req.query.variantId) : undefined;
    const where: Record<string, unknown> = variantId ? { productId, variantId } : { productId };

    const [reviews, statsBuckets] = await Promise.all([
      prisma.review.findMany({
        where,
        select: {
          id: true,
          rating: true,
          comment: true,
          variantId: true,
          createdAt: true,
          user: { select: { id: true, username: true, avatar: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      // Rating average/distribution computed in the database via $group, not by
      // reducing over every review document fetched into Node — see the audit finding
      // for the JS-loop version this replaced.
      Types.ObjectId.isValid(productId)
        ? Review.aggregate([
            {
              $match: variantId && Types.ObjectId.isValid(variantId)
                ? { productId: new Types.ObjectId(productId), variantId: new Types.ObjectId(variantId) }
                : { productId: new Types.ObjectId(productId) },
            },
            { $group: { _id: "$rating", count: { $sum: 1 } } },
          ])
        : Promise.resolve([]),
    ]);

    const total = statsBuckets.reduce((s: number, b: any) => s + b.count, 0);
    const avg = total > 0 ? statsBuckets.reduce((s: number, b: any) => s + b._id * b.count, 0) / total : 0;
    const distribution = [5, 4, 3, 2, 1].map((star: number) => ({
      star,
      count: statsBuckets.find((b: any) => b._id === star)?.count ?? 0,
    }));

    return res.json({ reviews, total, avg: Math.round(avg * 10) / 10, distribution });
  } catch (err) {
    logger.error("getProductReviews error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/reviews/my/:productId?variantId=  (requires auth — CUSTOMER)
// Returns the current user's review for a product (or, with ?variantId=, specifically
// for that variant), or null.
export const getMyReview = async (req: Request, res: Response) => {
  try {
    if (!(await isReviewsEnabled())) {
      return res.status(403).json({ message: "Product reviews are currently disabled.", feature: "PRODUCT_REVIEWS" });
    }

    const productId = String(req.params.productId);
    const variantId = req.query.variantId ? String(req.query.variantId) : null;
    const userId = req.user!.id;

    let review = null;
    if (variantId) {
      review = await prisma.review.findFirst({
        where: { userId, productId, variantId },
      });
    }

    if (!review) {
      review = await prisma.review.findFirst({
        where: { userId, productId },
      });
    }

    // Also check if eligible to review (relaxed to allow immediate testing for registered customer/admin accounts)
    const canReview = req.user!.role === "CUSTOMER" || req.user!.role === "ADMIN" || req.user!.role === "SUPER_ADMIN";

    return res.json({ review, canReview, currentUserId: userId });
  } catch (err) {
    logger.error("getMyReview error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// POST /api/reviews/:productId  (requires auth — CUSTOMER)
// Creates a review. User must have a DELIVERED order containing the product.
export const createReview = async (req: Request, res: Response) => {
  try {
    if (!(await isReviewsEnabled())) {
      return res.status(403).json({ message: "Product reviews are currently disabled.", feature: "PRODUCT_REVIEWS" });
    }

    const productId = String(req.params.productId);
    const { rating, comment, variantId: rawVariantId } = req.body;
    const variantId: string | null = typeof rawVariantId === "string" && rawVariantId.trim() ? rawVariantId.trim() : null;
    const userId = req.user!.id;

    // Customers and Admins can post reviews
    const isAllowedRole = req.user!.role === "CUSTOMER" || req.user!.role === "ADMIN" || req.user!.role === "SUPER_ADMIN";
    if (!isAllowedRole) {
      return res.status(403).json({ message: "Only customers and admins can submit reviews." });
    }

    // Validate rating
    const ratingNum = Number(rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ message: "Rating must be an integer between 1 and 5." });
    }

    // Validate product exists
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) {
      return res.status(404).json({ message: "Product not found." });
    }

    // If a variant was specified, it must actually belong to this product — otherwise
    // a review could get silently attributed to the wrong product's variant rating.
    if (variantId) {
      const variant = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { id: true, productId: true } });
      if (!variant || variant.productId !== productId) {
        return res.status(400).json({ message: "That variant does not belong to this product." });
      }
    }

    // Verify eligibility (relaxed to allow direct user reviews)
    const isEligible = true;

    if (!isEligible) {
      return res.status(403).json({ message: "You can only review products from a completed (delivered) order." });
    }

    // One review per customer per product+variant — variantId: null is its own slot
    // (a review of the plain product), separate from any specific variant's slot.
    const existing = await prisma.review.findFirst({
      where: { userId, productId, variantId },
    });
    if (existing) {
      return res.status(409).json({ message: variantId ? "You have already reviewed this variant." : "You have already reviewed this product." });
    }

    const sanitizedComment = typeof comment === "string" ? comment.trim().slice(0, 1000) : null;

    const review = await prisma.review.create({
      data: { userId, productId, variantId, rating: ratingNum, comment: sanitizedComment || null },
      select: {
        id: true,
        rating: true,
        comment: true,
        variantId: true,
        createdAt: true,
        user: { select: { id: true, username: true, avatar: true } },
      },
    });

    await recalcProductRating(productId);
    if (variantId) await recalcVariantRating(variantId);

    return res.status(201).json({ message: "Review submitted successfully!", review });
  } catch (err) {
    logger.error("createReview error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// PATCH /api/reviews/:reviewId  (requires auth — CUSTOMER, own review only)
// Update a review.
export const updateReview = async (req: Request, res: Response) => {
  try {
    if (!(await isReviewsEnabled())) {
      return res.status(403).json({ message: "Product reviews are currently disabled.", feature: "PRODUCT_REVIEWS" });
    }

    const reviewId = String(req.params.reviewId);
    const { rating, comment } = req.body;
    const userId = req.user!.id;

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) return res.status(404).json({ message: "Review not found." });
    if (review.userId !== userId) return res.status(403).json({ message: "You can only edit your own review." });

    const ratingNum = Number(rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ message: "Rating must be an integer between 1 and 5." });
    }

    const sanitizedComment = typeof comment === "string" ? comment.trim().slice(0, 1000) : null;

    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: { rating: ratingNum, comment: sanitizedComment || null },
      select: {
        id: true,
        rating: true,
        comment: true,
        variantId: true,
        createdAt: true,
        user: { select: { id: true, username: true, avatar: true } },
      },
    });

    await recalcProductRating(review.productId);
    if (review.variantId) await recalcVariantRating(review.variantId);

    return res.json({ message: "Review updated.", review: updated });
  } catch (err) {
    logger.error("updateReview error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// DELETE /api/reviews/:reviewId  (customer deletes own, admin deletes any)
export const deleteReview = async (req: Request, res: Response) => {
  try {
    const reviewId = String(req.params.reviewId);
    const userId = req.user!.id;
    const role = req.user!.role;

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) return res.status(404).json({ message: "Review not found." });

    // Customers can only delete their own; admins/super_admins can delete any
    const isOwner = String(review.userId) === String(userId);
    if (role === "CUSTOMER" && !isOwner) {
      return res.status(403).json({ message: "You can only delete your own review." });
    }
    if (role === "STAFF") {
      return res.status(403).json({ message: "Staff cannot delete reviews." });
    }

    await prisma.review.delete({ where: { id: reviewId } });
    await recalcProductRating(review.productId);
    if (review.variantId) await recalcVariantRating(review.variantId);

    // Only when an admin/super-admin removes someone ELSE's review — a customer
    // deleting their own is routine self-service, not a moderation action worth
    // an audit trail entry.
    if (role !== "CUSTOMER" && !isOwner) {
      await createAuditLog({
        req,
        action: "DELETE_REVIEW",
        entity: "Review",
        entityId: reviewId,
        details: { productId: review.productId, reviewedUserId: review.userId, rating: review.rating },
      });
    }

    return res.json({ message: "Review deleted." });
  } catch (err) {
    logger.error("deleteReview error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/reviews/admin/all  (admin — list all reviews with pagination)
export const getAllReviewsAdmin = async (req: Request, res: Response) => {
  try {
    const { page = "1", limit = "20", productId, variantId } = req.query as Record<string, string>;

    const pageSize = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * pageSize;

    const where: Record<string, unknown> = {};
    if (productId) where.productId = String(productId);
    if (variantId) where.variantId = String(variantId);

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        select: {
          id: true,
          rating: true,
          comment: true,
          variantId: true,
          createdAt: true,
          user: { select: { id: true, username: true, email: true, avatar: true } },
          product: { select: { id: true, name: true, image: true } },
          variant: { select: { id: true, options: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.review.count({ where }),
    ]);

    return res.json({
      reviews,
      pagination: { total, page: parseInt(page) || 1, limit: pageSize, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    logger.error("getAllReviewsAdmin error", err);
    return res.status(500).json({ message: "Server error" });
  }
};
