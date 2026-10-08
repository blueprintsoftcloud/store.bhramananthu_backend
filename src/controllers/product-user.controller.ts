import { Request, Response } from "express";
import { Types } from "mongoose";
import { Product, Category, Review } from "../models/mongoose";
import logger from "../utils/logger";
import { getCachedSubtreeCategoryIds } from "../utils/categoryTree";
import { getCached } from "../utils/cache";
import { buildAttributeValueWhereConditions } from "../utils/attributeFilter";
import { expandProductsWithVariants, paginateListingRows } from "../utils/productVariant";

// GET /api/user/categories  — lightweight category list for user display
export const getAllCategories = async (_req: Request, res: Response) => {
  try {
    // Nav categories are read on nearly every storefront page and rarely change —
    // see cache.ts's TTL-backstopped in-process cache (same pattern as home-banners).
    const categories = await getCached("user-categories:nav", () =>
      prisma.category.findMany({
        where: { isActive: true },
        select: { id: true, name: true, image: true, parentId: true, showInNav: true, navOrder: true, showFilters: true },
        // navOrder only matters (and is only set) for top-level categories — subcategories
        // all default to 0 and fall back to alphabetical among themselves either way.
        orderBy: { navOrder: "asc", name: "asc" },
      }),
    );
    res
      .status(200)
      .json({ message: "Category fetched in user display", categories });
  } catch (err: any) {
    logger.error("getAllCategories error", err);
    res.status(500).json({ message: "Error in category fetching" });
  }
};

// GET /api/user/products?page=1&limit=24  — all active products with category
export const getAllProducts = async (req: Request, res: Response) => {
  try {
    const { page = "1", limit = "24", featured } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "24") || 24, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;

    const where: Record<string, unknown> = { isActive: true };
    if (featured === "true") where.isFeatured = true;

    const orderBy = featured === "true"
      ? [{ featuredOrder: "asc" as const }, { name: "asc" as const }]
      : [{ createdAt: "desc" as const }];

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          image: true,
          description: true,
          brand: true,
          price: true,
          discount: true,
          category: { select: { id: true, name: true } },
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    res.status(200).json({
      message: "Products fetched successfully",
      products,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getAllProducts error", err);
    res.status(500).json({ message: "Error in products fetching" });
  }
};

// GET /api/user/shop/categories/:categoryId?page=1&limit=12&sort=featured&minPrice=&maxPrice=&minRating=&sizes=S,M&inStock=true&onSale=true&attrs={}
export const getProductsByCategoryId = async (req: Request, res: Response) => {
  try {
    const categoryId = req.params.categoryId as string;
    const {
      page = "1",
      limit = "12",
      sort,
      minPrice,
      maxPrice,
      minRating,
      sizes,
      inStock,
      onSale,
      attributeValueIds,
    } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "12") || 12, 1), 100);
    const pageNum = Math.max(parseInt(page ?? "1") || 1, 1);

    // Browsing a category shows products from its ENTIRE subtree (this category plus
    // every subcategory beneath it, to any depth) — not just products added directly
    // to this exact node.
    const subtreeCategoryIds = await getCachedSubtreeCategoryIds(categoryId);
    const where: Prisma.ProductWhereInput = { categoryId: { in: subtreeCategoryIds }, isActive: true };

    // minPrice/maxPrice/inStock/onSale are deliberately NOT applied here — see
    // expandProductsWithVariants + paginateListingRows below. Product.price/stock/
    // discount are the CHEAPEST active variant's summary (syncProductFromVariants),
    // so filtering on them directly could wrongly keep/drop a product whose OTHER
    // variants don't share that same price/stock/discount. Applied post-expansion
    // instead, against each row's own effective values.

    // Customer rating filter — "N★ & above" — deliberately NOT applied here. Each
    // expanded row now carries its OWN variant rating (see expandProductsWithVariants),
    // and a product-level Product.rating filter here would incorrectly keep/drop a
    // whole product based on its overall average even though one variant might clear
    // the bar while another doesn't. Applied post-expansion instead, via
    // paginateListingRows, against each row's own rating — same reasoning as the
    // minPrice/maxPrice/inStock/onSale comment below.

    // Size filter (legacy — still supported)
    if (sizes && sizes.trim().length > 0) {
      const sizeList = sizes.split(",").map((s) => s.trim()).filter(Boolean);
      if (sizeList.length > 0) {
        where.sizes = { hasSome: sizeList };
      }
    }

    // attributeValueIds: comma-separated CategoryAttributeValue ids. Re-grouped by
    // attribute name server-side (AND across distinct attributes, OR within one) —
    // see utils/attributeFilter.ts. Gates at the PRODUCT level (a product qualifies if
    // ANY of its variants/tags match), so every active variant still comes back from
    // Prisma here — variantNarrowing (applied after expansion below) is what actually
    // drops the non-matching variant rows (e.g. picking Size: L shouldn't also show
    // that product's S/M/XL cards).
    let variantNarrowing: Map<string, Set<string>> = new Map();
    if (attributeValueIds?.trim()) {
      const result = await buildAttributeValueWhereConditions(attributeValueIds);
      variantNarrowing = result.variantNarrowing;
      if (result.conditions.length > 0) {
        where.AND = [...((where.AND as Prisma.ProductWhereInput[]) ?? []), ...result.conditions];
      }
    }

    // Sort by createdAt/rating at the DB level for the non-price sorts — price-asc/
    // price-desc are re-sorted after expansion instead (a product-level sort can't
    // reflect per-variant prices; see the price-filter comment above).
    const orderByMap: Record<string, Prisma.ProductOrderByWithRelationInput> = {
      newest:   { createdAt: "desc" },
      popular:  { rating: "desc" },
      featured: { createdAt: "desc" },
    };
    const orderBy = orderByMap[sort ?? "featured"] ?? { createdAt: "desc" };

    // Fetch matching products and category details
    const [candidates, categoryDoc] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          attributeValues: {
            include: {
              attribute: { select: { id: true, name: true, type: true } },
              attributeValue: { select: { id: true, value: true } },
            },
          },
        },
        orderBy,
        take: 500,
      }),
      prisma.category.findFirst({
        where: {
          OR: [{ id: categoryId }, { code: categoryId }],
        },
        select: { id: true, name: true, showFilters: true, parentId: true },
      }),
    ]);

    const expandedAll = await expandProductsWithVariants(candidates);
    // Drop variant rows the attribute filter didn't actually match — see
    // variantNarrowing's own doc comment (utils/attributeFilter.ts) for why a product
    // qualifying overall doesn't mean every one of its variants should still show.
    const expanded =
      variantNarrowing.size === 0
        ? expandedAll
        : expandedAll.filter((row) => {
            if (!row.variantId) return true;
            const allowed = variantNarrowing.get(String(row.id));
            return !allowed || allowed.has(String(row.variantId));
          });
    const { items: getProducts, total } = paginateListingRows(expanded, {
      minPrice: minPrice && !isNaN(parseFloat(minPrice)) ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice && !isNaN(parseFloat(maxPrice)) ? parseFloat(maxPrice) : undefined,
      minRating: minRating && !isNaN(parseFloat(minRating)) ? Math.max(1, Math.min(5, parseFloat(minRating))) : undefined,
      onSaleOnly: onSale === "true",
      inStockOnly: inStock === "true",
      sort,
      page: pageNum,
      pageSize,
    });

    res.status(200).json({
      message: "Products fetched by the selected category ID",
      category: categoryDoc,
      getProducts,
      pagination: {
        total,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getProductsByCategoryId error", err);
    res.status(500).json({
      message: "Error in products fetching by the selected category ID",
    });
  }
};

// GET /api/user/products/:productId  — product detail + related
export const productCard = async (req: Request, res: Response) => {
  try {
    const productId = req.params.productId as string;

    if (!Types.ObjectId.isValid(productId)) {
      return res.status(404).json({ message: "Product not found" });
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        category: { select: { id: true, name: true } },
        // NOT including reviews here: the frontend's ReviewSection (ProductDetailPage.tsx)
        // fetches its own list from GET /reviews/:productId — this endpoint's `product.
        // reviews` was never read, just silently shipping every review ever written
        // (full comment text included) on every single product-detail page load.
        attributeValues: {
          include: {
            attribute: { select: { id: true, name: true, type: true, isFilterable: true } },
            attributeValue: { select: { id: true, value: true } },
          },
        },
      },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Neither of these depends on the other's result (both only need fields already
    // on `product`) — run them concurrently instead of two sequential round-trips.
    const [relatedProducts, variants] = await Promise.all([
      prisma.product.findMany({
        where: {
          categoryId: product.categoryId,
          id: { notIn: [product.id] },
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          brand: true,
          price: true,
          discount: true,
          image: true,
          stock: true,
          rating: true,
        },
        take: 4,
      }),
      // Only products an admin has actually defined variants for get a size/color
      // picker on the storefront (see ProductVariant in mongoose.ts) — everything else
      // keeps behaving exactly as a plain single-SKU product always has. Deliberately
      // NOT filtered to isActive here: the picker's option order is each axis value's
      // first appearance across this array, so excluding disabled variants would make
      // that order shift every time an admin toggles one off (the option it was
      // "first seen on" changes). The frontend filters isActive when deciding what's
      // actually selectable; this list only fixes the display order in place.
      prisma.productVariant.findMany({
        where: { productId: product.id },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    // Once a product has variants, ITS OWN stock is meaningless (each variant tracks
    // its own) — "in stock" means "at least one ACTIVE variant still has stock"
    // (a disabled variant's stock doesn't count, even if nonzero).
    const inStock = variants.length > 0 ? variants.some((v: any) => v.isActive && v.stock > 0) : product.stock > 0;

    res.status(200).json({
      message: "Product details fetched successfully",
      product: {
        ...product,
        variants,
        inStock,
        stockStatus: inStock ? "In Stock" : "Out of Stock",
      },
      relatedProducts,
    });
  } catch (err: any) {
    logger.error("productCard error", err);
    res.status(500).json({ message: "Server error fetching product details" });
  }
};

// GET /api/user/products/search?q=&category=&minPrice=&maxPrice=&minRating=&sort=&page=&limit=
export const searchProducts = async (req: Request, res: Response) => {
  try {
    const {
      q,
      category,
      minPrice,
      maxPrice,
      minRating,
      sort,
      page = "1",
      limit = "24",
    } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "24") || 24, 1), 100);
    const pageNum = Math.max(parseInt(page ?? "1") || 1, 1);

    // Build Prisma where clause
    const where: Prisma.ProductWhereInput = { isActive: true };

    if (q) {
      // NOTE: tried switching this to a MongoDB $text search (tokenized/stemmed, so it
      // can actually use an index) — reverted. $text only matches whole word-stems, so a
      // shopper typing "pho" while a live search box is still narrowing down to "phone"
      // got zero results, where the substring regex below correctly matches mid-word.
      // Search quality regressions aren't an acceptable trade for this. `description` is
      // dropped from the predicate below though — that field carries full product HTML
      // and was the most expensive part of the scan for the least relevant matches (a
      // shopper searching a product name almost never means to search body copy).
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
      ];
    }

    if (category) {
      const catDoc = await prisma.category.findFirst({
        where: {
          OR: [
            { name: { equals: category, mode: "insensitive" } },
            { code: category },
          ],
        },
        select: { id: true },
      });
      // Subtree-inclusive, matching getProductsByCategoryId's behavior — products only
      // ever live on leaf categories (see category.controller.ts's exclusivity rule), so
      // an exact-id match against a parent/top-level category (e.g. "Clothing") always
      // returned zero results even though it visibly has products several levels down.
      const subtreeIds = catDoc ? await getCachedSubtreeCategoryIds(catDoc.id) : [];
      where.categoryId = { in: subtreeIds.length > 0 ? subtreeIds : ["__no_match__"] };
    }

    // Customer rating filter — deliberately NOT applied here, same reasoning as
    // getProductsByCategoryId: a product-level Product.rating filter could wrongly
    // keep/drop a whole product when only one of its variants actually clears the bar.
    // Applied post-expansion instead, against each row's own rating.

    // minPrice/maxPrice are deliberately NOT applied here — see expandProductsWithVariants
    // + paginateListingRows below. A product's own `price` is only its CHEAPEST active
    // variant's price (syncProductFromVariants), so filtering on it directly could drop a
    // product with one variant inside the range and another outside it. They're applied
    // after expansion instead, against each row's own effective price.

    // Sort by createdAt at the DB level for the non-price/rating sorts — price-asc/
    // price-desc/rating are re-sorted after expansion instead (same reasoning as the
    // price filter above: a product-level sort can't reflect per-variant prices).
    const orderBy: Prisma.ProductOrderByWithRelationInput = { createdAt: "desc" };

    // Fetch every matching product (uncapped skip/take here — pagination happens after
    // variant expansion below) with a sane upper bound so an unfiltered search on a huge
    // catalog can't blow up a single request; same tradeoff attributeFilter.ts already
    // makes for cross-collection filtering.
    const candidates = await prisma.product.findMany({
      where,
      orderBy,
      take: 500,
      select: {
        id: true,
        name: true,
        brand: true,
        price: true,
        discount: true,
        rating: true,
        numReviews: true,
        image: true,
        category: { select: { id: true, name: true } },
      },
    });

    const expanded = await expandProductsWithVariants(candidates);
    const { items, total } = paginateListingRows(expanded, {
      minPrice: minPrice && !isNaN(parseFloat(minPrice)) ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice && !isNaN(parseFloat(maxPrice)) ? parseFloat(maxPrice) : undefined,
      minRating: minRating && !isNaN(parseFloat(minRating)) ? Math.max(1, Math.min(5, parseFloat(minRating))) : undefined,
      sort,
      page: pageNum,
      pageSize,
    });

    res.status(200).json({
      items,
      total,
      page: pageNum,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err: any) {
    logger.error("searchProducts error", err);
    res
      .status(500)
      .json({
        message: "An unexpected server error occurred during search",
        details: err.message,
      });
  }
};

// POST /api/user/products/:id/reviews  (authenticated)
export const createProductReview = async (req: Request, res: Response) => {
  try {
    const productId = req.params.id as string;
    const userId = req.user!.id;
    const { rating, comment } = req.body;

    if (
      !rating ||
      isNaN(Number(rating)) ||
      Number(rating) < 1 ||
      Number(rating) > 5
    ) {
      return res
        .status(400)
        .json({ message: "Rating must be a number between 1 and 5" });
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Check if user already reviewed
    const existing = await prisma.review.findFirst({
      where: { productId, userId },
    });
    if (existing) {
      return res.status(400).json({ message: "Product already reviewed" });
    }

    await prisma.review.create({
      data: {
        productId,
        userId,
        rating: Number(rating),
        comment: comment ?? null,
      },
    });

    // Recalculate product rating
    const aggResult = await prisma.review.aggregate({
      where: { productId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    await prisma.product.update({
      where: { id: productId },
      data: {
        rating: aggResult._avg.rating ?? 0,
        numReviews: aggResult._count.rating,
      },
    });

    res.status(201).json({ message: "Review added" });
  } catch (err: any) {
    logger.error("createProductReview error", err);
    res.status(500).json({ message: "Error creating review" });
  }
};

// GET /api/user/shop/global-search?q=text  (public)
export const globalSearch = async (req: Request, res: Response) => {
  try {
    const { q } = req.query as { q?: string };

    if (!q || q.trim().length < 1) {
      return res.status(200).json({ categories: [], products: [] });
    }

    const term = q.trim();

    const [categories, products] = await Promise.all([
      prisma.category.findMany({
        where: { isActive: true, name: { contains: term, mode: "insensitive" } },
        select: { id: true, name: true, image: true },
        take: 5,
      }),
      prisma.product.findMany({
        where: {
          isActive: true,
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { description: { contains: term, mode: "insensitive" } },
          ],
        },
        select: {
          id: true,
          name: true,
          brand: true,
          price: true,
          discount: true,
          image: true,
          category: { select: { id: true, name: true } },
        },
        take: 8,
      }),
    ]);

    res.status(200).json({ categories, products });
  } catch (err: any) {
    logger.error("globalSearch error", err);
    res.status(500).json({ message: "Search failed" });
  }
};

// GET /api/user/profile  (authenticated)
export const getProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, phone: true, role: true },
    });
    res
      .status(200)
      .json({ message: "User profile data fetched successfully", users: user });
  } catch (err: any) {
    logger.error("getProfile error", err);
    res.status(500).json({ message: "Error in User profile data fetching" });
  }
};

// GET /api/user/shop/categories/:categoryId/filters
// Returns filterable attribute definitions + price range for the category's active products.
// The storefront filter panel calls this once per category to know what filters to render.
export const getProductFilters = async (req: Request, res: Response) => {
  try {
    const { categoryId } = req.params;
    const subtreeCategoryIds = await getCachedSubtreeCategoryIds(categoryId as string);

    const [rawAttributes, priceAgg] = await Promise.all([
      // Subtree-inclusive, matching the same product set the category page actually
      // shows: CategoryAttributes are still defined per-exact-category (leaf categories
      // only, enforced in category/attribute controllers), so browsing a parent category
      // needs to aggregate attributes across every leaf descendant, not just the parent
      // itself. TEXT/NUMBER/DATE excluded — free-input specs, not wired up as filters
      // (see AttributeFilterPanel). RATING/PRICE excluded too — informational-only
      // entries (see mongoose.ts's AttributeTypeEnum comment); the storefront already
      // renders global Rating/Price filters unconditionally (CategoryProductPage.tsx),
      // so surfacing these here would just draw an empty, valueless attribute box.
      prisma.categoryAttribute.findMany({
        where: { categoryId: { in: subtreeCategoryIds }, isFilterable: true, type: { notIn: ["TEXT", "NUMBER", "DATE", "RATING", "PRICE"] } },
        include: { values: { orderBy: { sortOrder: "asc" } } },
        orderBy: { sortOrder: "asc" },
      }),
      // Subtree-inclusive: matches the same product set the category page actually shows.
      prisma.product.aggregate({
        where: { categoryId: { in: subtreeCategoryIds }, isActive: true },
        _min: { price: true },
        _max: { price: true },
      }),
    ]);

    // Merge same name+type attributes independently defined on different leaf
    // categories in the subtree into one filter group (e.g. two leaf categories each
    // with their own "Color" attribute become a single "Color" filter). Each displayed
    // value keeps the full list of underlying CategoryAttributeValue ids it maps to —
    // see utils/attributeFilter.ts for how those ids get re-grouped by name again when
    // a filter selection comes back in.
    const groups = new Map<
      string,
      { name: string; type: string; sortOrder: number; values: Map<string, { value: string; ids: string[] }> }
    >();
    for (const attr of rawAttributes as any[]) {
      const key = `${attr.type}::${String(attr.name).trim().toLowerCase()}`;
      const group =
        groups.get(key) ??
        groups.set(key, { name: String(attr.name).trim(), type: attr.type, sortOrder: attr.sortOrder, values: new Map() }).get(key)!;
      for (const v of attr.values ?? []) {
        const vKey = String(v.value).trim().toLowerCase();
        const vGroup = group.values.get(vKey) ?? group.values.set(vKey, { value: String(v.value).trim(), ids: [] }).get(vKey)!;
        vGroup.ids.push(v.id);
      }
    }
    const attributes = [...groups.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((g) => ({ name: g.name, type: g.type, values: [...g.values.values()] }));

    res.json({
      attributes,
      priceRange: {
        min: priceAgg._min?.price ?? 0,
        max: priceAgg._max?.price ?? 0,
      },
    });
  } catch (err: any) {
    logger.error("getProductFilters error", err);
    res.status(500).json({ message: "Error fetching product filters" });
  }
};

