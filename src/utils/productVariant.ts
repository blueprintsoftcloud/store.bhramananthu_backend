import { deleteFromCloudinary } from "../config/cloudinary";
import logger from "./logger";

// src/utils/productVariant.ts
// Shared helper for ProductVariant's `options` map — see mongoose.ts's ProductVariant
// for the full design (admin-named axes like "Storage"/"RAM"/"Weight" instead of a
// fixed Size/Color pair, so every business's variant needs fit, not just apparel's).

/**
 * Canonical, order-independent string form of an options map — e.g.
 * `{ Color: "Black", Storage: "128GB" }` and `{ Storage: "128GB", Color: "Black" }`
 * both produce `"Color:Black|Storage:128GB"`. Used as a real indexed field
 * (ProductVariant.optionsKey) because Mongo can't uniquely index a Mixed subdocument
 * by content in a key-order-independent way on its own.
 */
export function computeOptionsKey(options: Record<string, string>): string {
  return Object.entries(options)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([key, value]) => [key.trim(), String(value).trim()] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
}

/**
 * Keeps Product.stock, Product.price, Product.purchasePrice, and Product.discount in
 * sync with the product's variants. Every OTHER stock/price read in the app (the
 * category/admin "in stock" filters, the low-stock alert service, the admin dashboard
 * widget, list/grid cards, the Product Details modal, the edit form's Margin display)
 * queries these Product fields directly and has no idea ProductVariant exists — rather
 * than teach each of those call sites about variants, this keeps the Product fields
 * themselves accurate so they all stay correct with zero changes. Call after ANY
 * variant stock/price change — admin add/generate/update/delete
 * (productVariant.controller.ts) AND real customer activity: order-placement deduction
 * (order.controller.ts's deductStock) and order-cancellation restore
 * (inventory.service.ts's restoreStockNow). The latter two only ever move stock, not
 * price, but recomputing everything here anyway is a cheap no-op for the rest and keeps
 * this to one function instead of several near-identical variant-fetching helpers.
 *
 * Stock: the sum of active variants' stock — a product with zero (active) options has
 * zero purchasable units, so this correctly goes to 0 when the last option is
 * deactivated, not just left stuck at its old total.
 *
 * Price/cost/discount: found from ONE variant — whichever is cheapest by effective
 * price (`priceOverride`, falling back to the product's own current price for a variant
 * that doesn't override it — the same fallback ProductDetailPage.tsx's `effectivePrice`
 * already uses once a variant is picked). That variant's `purchasePriceOverride` and
 * `discountOverride` (each falling back to the product's own current value) become the
 * new Product.purchasePrice/discount too — so the top-level Margin/Discount figures
 * stay a coherent pair with the "starting from" price they're computed against, instead
 * of comparing a cost or promotion meant for a different option entirely. Unlike stock,
 * zero active variants does NOT zero these out (a card reading "₹0" looks like a
 * giveaway, not "unavailable") — they're left at their last values instead, same as
 * when there are no variants at all.
 *
 * A product with zero variant ROWS (deleted back down to none, or never had any) is
 * left fully untouched — every field reverts to admin-controlled via the product form,
 * exactly as before this feature existed.
 *
 * `client` defaults to the global `prisma` bridge but should be the transaction-bound
 * `tx` when called from inside `prisma.$transaction(async (tx) => {...})` (see
 * deductStock's own client param) — so the resync reads/writes within the same
 * transaction as the stock decrement it's following, not a separate one.
 */
export async function syncProductFromVariants(productId: string, client: any = prisma): Promise<void> {
  const allVariants = await client.productVariant.findMany({ where: { productId } });
  if (allVariants.length === 0) return;

  const activeVariants = allVariants.filter((v: { isActive: boolean }) => v.isActive);
  const stock = activeVariants.reduce((sum: number, v: { stock: number }) => sum + (v.stock || 0), 0);

  const product = await client.product.findUnique({
    where: { id: productId },
    select: { price: true, purchasePrice: true, discount: true, image: true },
  });
  const currentPrice = product?.price ?? 0;
  const oldProductImage = product?.image;

  let price = currentPrice;
  let purchasePrice = product?.purchasePrice ?? null;
  let discount = product?.discount ?? 0;

  if (activeVariants.length > 0) {
    const cheapest = activeVariants.reduce(
      (min: { priceOverride: number | null }, v: { priceOverride: number | null }) =>
        (v.priceOverride ?? currentPrice) < (min.priceOverride ?? currentPrice) ? v : min,
      activeVariants[0],
    );
    price = cheapest.priceOverride ?? currentPrice;
    purchasePrice = cheapest.purchasePriceOverride ?? purchasePrice;
    discount = cheapest.discountOverride != null ? cheapest.discountOverride : 0;
  }

  // Auto-sync product cover image from the first variant that has an image so search/listings
  // have a cover photo without uploading duplicate files.
  const firstWithImage = activeVariants.find((v: any) => v.image) || allVariants.find((v: any) => v.image);
  const imageUpdate = firstWithImage?.image ? { image: firstWithImage.image } : {};

  // stockQuantity mirrors stock on every other write path (product.controller.ts's
  // productAdd/productUpdate) — nothing currently reads it, but keeping it in sync here
  // too avoids the two fields silently drifting apart for whoever looks at it next.
  await client.product.update({
    where: { id: productId },
    data: { stock, stockQuantity: stock, price, purchasePrice, discount, ...imageUpdate },
  });

  // If the cover image was replaced with a variant image, check if the old standalone product image is now orphaned
  if (firstWithImage?.image && oldProductImage && oldProductImage !== firstWithImage.image) {
    const isOldImageUsedByVariant = allVariants.some(
      (v: any) =>
        v.image === oldProductImage ||
        v.secondaryImage === oldProductImage ||
        (Array.isArray(v.images) && v.images.includes(oldProductImage)),
    );
    if (!isOldImageUsedByVariant) {
      const otherProductCount = await client.product.count({
        where: { id: { not: productId }, image: oldProductImage },
      });
      if (otherProductCount === 0) {
        await deleteFromCloudinary(oldProductImage).catch((e: unknown) =>
          logger.warn("Failed to delete orphaned standalone product image from Cloudinary after variant sync", e),
        );
      }
    }
  }
}

/** One row in a customer-facing listing (search results / category page) after
 * variant expansion — either a plain single-SKU product (variantId null) or one
 * specific active variant of a product, carrying that variant's own effective
 * price/discount/stock instead of the product's "cheapest active variant" summary. */
export interface ExpandedListingRow {
  id: string;
  variantId: string | null;
  variantOptions: Record<string, string> | null;
  price: number;
  discount: number;
  stock: number;
  image?: string | null;
  secondaryImage?: string | null;
  images?: string[];
  [key: string]: unknown;
}

/**
 * Turns a flat product list into a listing-ready row list where a product with
 * active variants becomes ONE ROW PER ACTIVE VARIANT (each with that variant's own
 * price/discount/stock) instead of a single "starting from" row — see
 * product-user.controller.ts's searchProducts/getProductsByCategoryId, the two
 * customer-facing browsing surfaces this applies to. A product with zero active
 * variants passes through unchanged as a single row (variantId null), identical to
 * how it always rendered.
 *
 * Deliberately NOT used by the admin product list (product.controller.ts's
 * productList) — that page manages products, not purchase options, and still needs
 * exactly one row per product to edit/delete/manage variants on.
 */
export async function expandProductsWithVariants<T extends { id: string; price: number; discount?: number | null; stock?: number | null; image?: string | null; images?: string[] }>(
  products: T[],
  client: any = prisma,
): Promise<ExpandedListingRow[]> {
  if (products.length === 0) return [];

  const productIds = products.map((p) => p.id);
  const variants = await client.productVariant.findMany({
    where: { productId: { in: productIds }, isActive: true },
    orderBy: { createdAt: "asc" },
  });

  const variantsByProduct = new Map<string, any[]>();
  for (const v of variants) {
    const key = String(v.productId);
    const bucket = variantsByProduct.get(key);
    if (bucket) bucket.push(v);
    else variantsByProduct.set(key, [v]);
  }

  const rows: ExpandedListingRow[] = [];
  for (const product of products) {
    const productVariants = variantsByProduct.get(product.id) ?? [];
    if (productVariants.length === 0) {
      rows.push({
        ...product,
        variantId: null,
        variantOptions: null,
        price: product.price,
        discount: product.discount ?? 0,
        stock: product.stock ?? 0,
        image: product.image ?? null,
        secondaryImage: product.images?.[0] ?? null,
        images: product.images ?? [],
      });
      continue;
    }
    for (const v of productVariants) {
      rows.push({
        ...product,
        variantId: v.id,
        variantOptions: v.options,
        // Variant's specific images (Slot 1 & Slot 2), falling back to product images
        image: v.image || product.image || null,
        secondaryImage: v.secondaryImage || (v.images?.[1] ? v.images[1] : (product.images?.[0] ?? null)),
        images: v.images?.length ? v.images : (product.images ?? []),
        // Variant price & discount: if the variant has no explicit discount override, it has 0% discount
        price: v.priceOverride ?? product.price,
        discount: v.discountOverride != null ? v.discountOverride : 0,
        stock: v.stock,
        // Each variant's OWN rating, not the parent product's — a variant with no
        // reviews of its own shows 0/no-reviews rather than inheriting a sibling
        // variant's score. See review.controller.ts's recalcVariantRating.
        rating: v.rating ?? 0,
        numReviews: v.numReviews ?? 0,
      });
    }
  }
  return rows;
}

/** Sort keys a listing endpoint accepts, shared between search and category browsing. */
export type ListingSort = "price-asc" | "price-desc" | "newest" | "rating" | "popular" | "featured" | string | undefined;

/**
 * Applies price/on-sale filtering, sort, and pagination AFTER variant expansion —
 * has to run post-expansion because a filter like "under ₹500" or "on sale" is only
 * meaningful against each row's own effective price/discount, not the product's
 * synced-from-cheapest-variant summary (a product could have one variant under ₹500
 * and another well above it). `Array.prototype.sort` is stable (ES2019+), so the
 * "no sort key matched" case leaves the DB's own ORDER BY intact rather than
 * reshuffling rows.
 */
export function paginateListingRows<T extends { id: string; price: number; discount?: number; rating?: number }>(
  rows: T[],
  opts: {
    minPrice?: number;
    maxPrice?: number;
    // "N★ & above" — applied per-row (each variant's own rating) rather than as a
    // pre-expansion Product.rating filter, so a 5★ variant of an otherwise 2★-average
    // product still shows up, and a 0★ (no-reviews-yet) sibling variant doesn't ride
    // along on a product-level rating it never actually earned.
    minRating?: number;
    onSaleOnly?: boolean;
    inStockOnly?: boolean;
    sort?: ListingSort;
    page: number;
    pageSize: number;
  } & { stock?: never },
): { items: T[]; total: number } {
  let filtered = rows;
  if (opts.minPrice !== undefined) filtered = filtered.filter((r) => r.price >= opts.minPrice!);
  if (opts.maxPrice !== undefined) filtered = filtered.filter((r) => r.price <= opts.maxPrice!);
  if (opts.minRating !== undefined) filtered = filtered.filter((r) => (r.rating ?? 0) >= opts.minRating!);
  if (opts.onSaleOnly) filtered = filtered.filter((r) => (r.discount ?? 0) > 0);
  if (opts.inStockOnly) filtered = filtered.filter((r) => (r as unknown as { stock: number }).stock > 0);

  // Listing cards show exactly ONE row per product — picking a specific size/color is
  // a detail-page decision (see ProductDetailPage's variant picker), not something a
  // customer does from the grid. Collapse whatever expandProductsWithVariants (one row
  // per active variant) left after the filters above down to each product's cheapest
  // surviving row — the same "basic variant" every other Product.price/stock/discount
  // read in the app already treats as canonical (see syncProductFromVariants).
  const basicByProduct = new Map<string, T>();
  for (const row of filtered) {
    const current = basicByProduct.get(row.id);
    if (!current || row.price < current.price) basicByProduct.set(row.id, row);
  }
  const collapsed = [...basicByProduct.values()];

  const sorted = collapsed;
  if (opts.sort === "price-asc") sorted.sort((a, b) => a.price - b.price);
  else if (opts.sort === "price-desc") sorted.sort((a, b) => b.price - a.price);
  else if (opts.sort === "rating" || opts.sort === "popular") sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));

  const total = sorted.length;
  const start = (opts.page - 1) * opts.pageSize;
  return { items: sorted.slice(start, start + opts.pageSize), total };
}
