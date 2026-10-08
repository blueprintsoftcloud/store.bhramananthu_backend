import mongoose, { Document, Schema } from 'mongoose';

// ───────────────────────────── ENUMS ───────────────────────────────

export const RoleEnum = ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN', 'STAFF'] as const;
export type Role = typeof RoleEnum[number];

export const Role = { CUSTOMER: 'CUSTOMER', ADMIN: 'ADMIN', SUPER_ADMIN: 'SUPER_ADMIN', STAFF: 'STAFF' } as const;
export const OrderStatusEnum = ['PROCESSING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'] as const;
export type OrderStatus = typeof OrderStatusEnum[number];

export const PaymentStatusEnum = ['PENDING', 'PAID', 'FAILED', 'REFUNDED'] as const;
export const PaymentMethodEnum = ['ONLINE', 'POD', 'CASH', 'QR'] as const;

export const NotificationTypeEnum = ['NEW_ORDER', 'ORDER_UPDATE', 'PAYMENT_FAILED', 'PAYMENT_SUCCESS', 'LOW_STOCK', 'GENERAL'] as const;
export type NotificationType = typeof NotificationTypeEnum[number];
// Mirrors frontend/src/constants/attributeTypes.ts — keep both in sync. DATE covers
// business-agnostic specs (expiry, manufacture/release dates, ...) that don't fit
// clothing/vehicle-parts-style categorical attributes, same reasoning as that file.
// RATING and PRICE are informational-only entries an admin can add in CategoryAttributes.tsx
// to record "this category has that filter" — the storefront's actual Rating/Price
// filtering (see getProductFilters and getProductsByCategoryId below) is global and
// built into every product's own rating/price fields, never per-category-defined
// values like SELECT/MULTISELECT, so these never get CategoryAttributeValue rows,
// are never tagged onto products, and are excluded from getProductFilters's response.
export const AttributeTypeEnum = ['SELECT', 'MULTISELECT', 'TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'RATING', 'PRICE'];

// ───────────────────────────── USER ───────────────────────────────

export interface IUser extends Document {
  username: string;
  email?: string;
  phone: string;
  password?: string;
  role: string;
  isVerified: boolean;
  refreshToken?: string;
  avatar?: string;
  /** Refresh-token-reuse detection: the token family id currently valid for this user. */
  refreshTokenFamily?: string;
  previousRefreshToken?: string;
  previousRefreshTokens?: Array<{ token: string; rotatedAt: Date }>;
  lastRotatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    username: { type: String, required: true },
    email: { type: String, sparse: true },
    phone: { type: String, unique: true, required: true },
    password: String,
    role: { type: String, enum: RoleEnum, default: 'CUSTOMER' },
    isVerified: { type: Boolean, default: false },
    refreshToken: String,
    refreshTokenFamily: String,
    previousRefreshToken: String,
    previousRefreshTokens: [
      {
        token: { type: String },
        rotatedAt: { type: Date, default: Date.now },
      },
    ],
    lastRotatedAt: Date,
    avatar: String,
  },
  { timestamps: true }
);
UserSchema.index({ role: 1 });

export const User = mongoose.model<IUser>('User', UserSchema);

// ───────────────────────────── ADDRESS ───────────────────────────────

export interface IAddress extends Document {
  userId: mongoose.Types.ObjectId;
  fullAddress: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  landmark?: string;
  isDefault: boolean;
  latitude?: number;
  longitude?: number;
  createdAt: Date;
  updatedAt: Date;
}

const AddressSchema = new Schema<IAddress>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fullAddress: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zipCode: { type: String, required: true },
    country: { type: String, default: 'India' },
    landmark: String,
    isDefault: { type: Boolean, default: false },
    latitude: Number,
    longitude: Number,
  },
  { timestamps: true }
);
AddressSchema.index({ userId: 1 });

export const Address = mongoose.model<IAddress>('Address', AddressSchema);

// ───────────────────────────── CATEGORY ───────────────────────────────

export interface ICategory extends Document {
  code: string;
  name: string;
  description?: string;
  image?: string;
  isActive: boolean;
  /** Self-reference — null/absent means a top-level category. See utils/categoryTree.ts for subtree resolution. */
  parentId?: mongoose.Types.ObjectId | null;
  /** Only meaningful on top-level categories (parentId null) — whether this category
   * gets its own column in the site-wide mega menu. Subcategories always inherit
   * their parent's visibility there; there's no per-subcategory toggle. */
  showInNav: boolean;
  /** Left-to-right position among top-level categories in the mega menu. Ties broken
   * by name. Irrelevant for subcategories. */
  navOrder: number;
  /** Whether sidebar filters (price, ratings, attributes) are shown on this category's storefront page */
  showFilters: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CategorySchema = new Schema<ICategory>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    image: String,
    isActive: { type: Boolean, default: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    showInNav: { type: Boolean, default: true },
    navOrder: { type: Number, default: 0 },
    showFilters: { type: Boolean, default: true },
  },
  { timestamps: true }
);
CategorySchema.index({ code: 1 }, { unique: true });
CategorySchema.index({ parentId: 1 });

export const Category = mongoose.model<ICategory>('Category', CategorySchema);

export interface IDeliveryPartner extends Document {
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DeliveryPartnerSchema = new Schema<IDeliveryPartner>(
  {
    name: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
DeliveryPartnerSchema.index({ name: 1 }, { unique: true });

export const DeliveryPartner = mongoose.model<IDeliveryPartner>('DeliveryPartner', DeliveryPartnerSchema);

// ───────────────────────────── PRODUCT ───────────────────────────────

export interface IProduct extends Document {
  code: string;
  name: string;
  description?: string;
  brand?: string;
  metaTitle?: string;
  metaDescription?: string;
  purchasePrice?: number;
  price: number;
  stock: number;
  stockQuantity: number;
  sizes: string[];
  discount: number;
  image?: string;
  images: string[];
  rating: number;
  numReviews: number;
  isActive: boolean;
  isFeatured: boolean;
  featuredOrder?: number;
  categoryId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ProductSchema = new Schema<IProduct>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    brand: String,
    metaTitle: String,
    metaDescription: String,
    purchasePrice: Number,
    price: { type: Number, required: true },
    stock: { type: Number, default: 0 },
    stockQuantity: { type: Number, default: 0 },
    sizes: { type: [String], default: [] },
    discount: { type: Number, default: 0 },
    image: String,
    images: { type: [String], default: [] },
    rating: { type: Number, default: 0 },
    numReviews: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    isFeatured: { type: Boolean, default: false },
    featuredOrder: Number,
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
  },
  { timestamps: true }
);
ProductSchema.index({ code: 1 }, { unique: true });
// Compound indexes reflecting actual query patterns (see product.controller.ts and
// product-user.controller.ts).
ProductSchema.index({ categoryId: 1 });
// getProductsByCategoryId/searchProducts (product-user.controller.ts) filter
// categoryId IN [...] AND isActive together on every category/search page view —
// the single-field categoryId index above forces a per-doc isActive check afterward.
ProductSchema.index({ categoryId: 1, isActive: 1 });
ProductSchema.index({ isActive: 1, createdAt: -1 });
ProductSchema.index({ isFeatured: 1, featuredOrder: 1 });
ProductSchema.index({ name: 1 });
ProductSchema.index({ price: 1 });

export const Product = mongoose.model<IProduct>('Product', ProductSchema);

// ───────────────────────────── CATEGORY ATTRIBUTE ───────────────────────────────

export interface ICategoryAttribute extends Document {
  categoryId: mongoose.Types.ObjectId;
  name: string;
  type: string;
  isFilterable: boolean;
  isRequired: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const CategoryAttributeSchema = new Schema<ICategoryAttribute>(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    name: { type: String, required: true },
    type: { type: String, enum: AttributeTypeEnum, required: true },
    isFilterable: { type: Boolean, default: true },
    isRequired: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);
CategoryAttributeSchema.index({ categoryId: 1, name: 1 }, { unique: true });

export const CategoryAttribute = mongoose.model<ICategoryAttribute>('CategoryAttribute', CategoryAttributeSchema);

// ───────────────────────────── CATEGORY ATTRIBUTE VALUE ───────────────────────────────

export interface ICategoryAttributeValue extends Document {
  attributeId: mongoose.Types.ObjectId;
  value: string;
  sortOrder: number;
}

const CategoryAttributeValueSchema = new Schema<ICategoryAttributeValue>(
  {
    attributeId: { type: Schema.Types.ObjectId, ref: 'CategoryAttribute', required: true },
    value: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
  }
);
CategoryAttributeValueSchema.index({ attributeId: 1, value: 1 }, { unique: true });

export const CategoryAttributeValue = mongoose.model<ICategoryAttributeValue>(
  'CategoryAttributeValue',
  CategoryAttributeValueSchema
);

// ───────────────────────────── PRODUCT ATTRIBUTE VALUE ───────────────────────────────

export interface IProductAttributeValue extends Document {
  productId: mongoose.Types.ObjectId;
  attributeId: mongoose.Types.ObjectId;
  attributeValueId?: mongoose.Types.ObjectId;
  textValue?: string;
  /** Null = applies to the whole product (the original, still-default behavior).
   * Set = this tag only describes one specific ProductVariant (e.g. "Fabric: Cotton"
   * applies to the 128GB/Black combo but not 256GB/Silver) — lets Category Filters
   * be assigned per-variant instead of being one blanket tag for every combination.
   * See utils/attributeFilter.ts's buildAttributeValueWhereConditions, which only
   * counts a variant-scoped tag as a match while that variant is still active. */
  variantId?: mongoose.Types.ObjectId | null;
}

const ProductAttributeValueSchema = new Schema<IProductAttributeValue>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    attributeId: { type: Schema.Types.ObjectId, ref: 'CategoryAttribute', required: true },
    attributeValueId: { type: Schema.Types.ObjectId, ref: 'CategoryAttributeValue' },
    textValue: String,
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
  }
);
ProductAttributeValueSchema.index({ productId: 1 });
ProductAttributeValueSchema.index({ attributeId: 1 });
ProductAttributeValueSchema.index({ variantId: 1 });

export const ProductAttributeValue = mongoose.model<IProductAttributeValue>(
  'ProductAttributeValue',
  ProductAttributeValueSchema
);

// ───────────────────────────── PRODUCT VARIANT ───────────────────────────────
//
// A purchasable combination of a product's admin-defined option axes, each with its
// OWN stock (and optionally its own price) — this is what Product.stock/price alone
// can't express once a product comes in more than one option. Axes are whatever the
// admin names them per product — "Size"/"Color" for a shirt, "Storage"/"Color" for a
// phone, "Weight" for a grocery item, "Metal"/"Weight" for jewellery — not a fixed
// pair, since different businesses vary along completely different dimensions (see
// utils/productVariant.ts's computeOptionsKey). Deliberately separate from the
// CategoryAttribute/ProductAttributeValue system above: that system is a single fixed
// admin-set tag per product used for storefront filtering (e.g. "this product's Fabric
// is Cotton"), not a customer-facing choice with its own inventory.
//
// A product with NO ProductVariant rows behaves exactly as it always has — single
// price/stock on Product itself, no picker shown, fully backward compatible with every
// existing single-SKU product. Only once an admin adds variant rows does the product
// gain a required options picker on the storefront (see product-user.controller.ts's
// productCard and cart.controller.ts's cartAdd).
export interface IProductVariant extends Document {
  productId: mongoose.Types.ObjectId;
  /** e.g. { Storage: "128GB", Color: "Black" } or { Weight: "1kg" } — axis names and
   * values are both admin-defined free text, not tied to any fixed schema field. */
  options: Record<string, string>;
  /** Canonical serialization of `options` (see computeOptionsKey) — a real indexed
   * field because Mongo can't uniquely index a Mixed map by content on its own. */
  optionsKey: string;
  sku?: string;
  stock: number;
  /** Falls back to Product.price when null — most variants don't need a price
   * different from the base product, only a stock count of their own. */
  priceOverride: number | null;
  /** Falls back to Product.purchasePrice when null — cost basis differs by option
   * often enough (a 10ml bottle doesn't cost the same to source as a 50ml one) that
   * margin needs to be trackable per variant, not just once for the whole product. */
  purchasePriceOverride: number | null;
  /** Falls back to Product.discount when null — 0-100. Lets a promotion apply to one
   * option (e.g. the 50ml bottle) without discounting every size of the same product. */
  discountOverride: number | null;
  /** Primary featured photo for this specific variant (e.g. Red front view) */
  image?: string | null;
  /** Secondary angle/detail photo for this specific variant (e.g. Red back view) */
  secondaryImage?: string | null;
  /** Array of both variant images [image, secondaryImage] */
  images?: string[];
  isActive: boolean;
  /** This variant's own average rating — computed from Review documents tagged with
   * this variantId, independently of the parent Product's overall rating. 0 until the
   * first variant-tagged review lands. */
  rating: number;
  numReviews: number;
  createdAt: Date;
  updatedAt: Date;
}

const ProductVariantSchema = new Schema<IProductVariant>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    options: { type: Schema.Types.Mixed, default: {} },
    optionsKey: { type: String, required: true },
    sku: String,
    stock: { type: Number, default: 0 },
    priceOverride: { type: Number, default: null },
    purchasePriceOverride: { type: Number, default: null },
    discountOverride: { type: Number, default: null },
    image: { type: String, default: null },
    secondaryImage: { type: String, default: null },
    images: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    rating: { type: Number, default: 0 },
    numReviews: { type: Number, default: 0 },
  },
  { timestamps: true }
);
ProductVariantSchema.index({ productId: 1 });
// Guards against an admin accidentally creating "128GB / Black" twice for the same
// product — same options combination can only ever be one row, one stock count.
ProductVariantSchema.index({ productId: 1, optionsKey: 1 }, { unique: true });

export const ProductVariant = mongoose.model<IProductVariant>('ProductVariant', ProductVariantSchema);

// ───────────────────────────── CART ───────────────────────────────

export interface ICart extends Document {
  userId: mongoose.Types.ObjectId;
  items: ICartItem[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ICartItem extends Document {
  cartId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  /** Set only for products that have ProductVariant rows — see cart.controller.ts's
   * cartAdd. Null for plain single-SKU products, same as always. */
  variantId?: mongoose.Types.ObjectId | null;
  quantity: number;
  createdAt: Date;
  updatedAt: Date;
}

const CartItemSchema = new Schema<ICartItem>(
  {
    cartId: { type: Schema.Types.ObjectId, ref: 'Cart', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
    quantity: { type: Number, default: 1 },
  },
  { timestamps: true }
);

const CartSchema = new Schema<ICart>(
  {
    userId: { type: Schema.Types.ObjectId, unique: true, ref: 'User', required: true },
  },
  { timestamps: true }
);
// TTL: a cart untouched for 90 days is abandoned — auto-expire it (and its items via the
// CartItem.pre('deleteOne'... ) cleanup is unnecessary since nothing re-reads orphaned
// CartItems: cart.controller.ts always looks them up via cartId, and a deleted Cart means
// that cartId can never be queried again).
CartSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const Cart = mongoose.model<ICart>('Cart', CartSchema);
export const CartItem = mongoose.model<ICartItem>('CartItem', CartItemSchema);

// ───────────────────────────── ORDER ───────────────────────────────

export interface IOrderItem extends Document {
  orderId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  /** Carried over from CartItem.variantId at checkout — see order.controller.ts.
   * Null for plain single-SKU products. */
  variantId?: mongoose.Types.ObjectId | null;
  quantity: number;
  price: number;
}

export interface IOrder extends Document {
  userId: mongoose.Types.ObjectId;
  totalAmount: number;
  shippingCharge: number;
  discountAmount: number;
  taxAmount: number;
  finalAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  orderStatus: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  transactionId?: string;
  paymentScreenshot?: string;
  shippingAddress: any;
  couponId?: mongoose.Types.ObjectId;
  placedByAdminId?: mongoose.Types.ObjectId;
  /** Set once the cancellation stock-restore has actually run — the compare-and-swap idempotency guard preventing a retry from double-restoring stock. */
  stockRestored: boolean;
  deliveryPartnerId?: mongoose.Types.ObjectId;
  /** Denormalized snapshot of the partner's name at ship time — survives the partner being renamed/removed later. */
  deliveryPartnerName?: string;
  trackingId?: string;
  trackingLink?: string;
  /** Manual/self-delivery shipments have no courier or tracking ID — an optional free-text note instead. */
  shippingNote?: string;
  shippedAt?: Date;
  invoicePrinted?: boolean;
  invoicePrintedAt?: Date | null;
  items?: IOrderItem[]; // populated
  createdAt: Date;
  updatedAt: Date;
}

const OrderItemSchema = new Schema<IOrderItem>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
  }
);
OrderItemSchema.index({ orderId: 1 });
OrderItemSchema.index({ productId: 1 });

const OrderSchema = new Schema<IOrder>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    totalAmount: { type: Number, required: true },
    shippingCharge: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    finalAmount: { type: Number, required: true },
    paymentMethod: { type: String, enum: PaymentMethodEnum, required: true },
    paymentStatus: { type: String, enum: PaymentStatusEnum, default: 'PENDING' },
    orderStatus: { type: String, enum: OrderStatusEnum, default: 'PROCESSING' },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    transactionId: String,
    paymentScreenshot: String,
    shippingAddress: { type: Schema.Types.Mixed, required: true },
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon' },
    placedByAdminId: { type: Schema.Types.ObjectId, ref: 'User' },
    stockRestored: { type: Boolean, default: false },
    deliveryPartnerId: { type: Schema.Types.ObjectId, ref: 'DeliveryPartner' },
    deliveryPartnerName: String,
    trackingId: String,
    trackingLink: String,
    shippingNote: String,
    shippedAt: Date,
    invoicePrinted: { type: Boolean, default: false },
    invoicePrintedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// A customer's own order history, sorted newest-first — see order.controller.ts's getOrders.
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ orderStatus: 1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ paymentStatus: 1, createdAt: -1 });
OrderSchema.index({ placedByAdminId: 1 });
OrderSchema.index({ invoicePrinted: 1, createdAt: -1 });

export const Order = mongoose.model<IOrder>('Order', OrderSchema);
export const OrderItem = mongoose.model<IOrderItem>('OrderItem', OrderItemSchema);

// ───────────────────────────── ORDER ARCHIVE ───────────────────────────────
// Cold-storage twin of Order+OrderItem. Populated by the yearly order-archival cron
// (see backend/src/jobs/orderArchive.job.ts) — delivered/cancelled orders older than
// 2 years are copied here (full snapshot, items embedded) then removed from the hot
// Order/OrderItem collections. Keeps the live order collection's indexes fast for
// day-to-day operations without ever discarding order history.

const OrderArchiveSchema = new Schema(
  {
    originalId: { type: Schema.Types.ObjectId, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    orderData: { type: Schema.Types.Mixed, required: true },
    items: { type: [Schema.Types.Mixed], default: [] },
    originalCreatedAt: Date,
    archivedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);
OrderArchiveSchema.index({ originalCreatedAt: -1 });

export const OrderArchive = mongoose.model('OrderArchive', OrderArchiveSchema);

// ───────────────────────────── WISHLIST ───────────────────────────────

export interface IWishlist extends Document {
  userId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  /** Null = wishlisting the plain product (or, for a variant product, no specific
   * option picked). Set = one specific variant — each variant of a product is its own
   * wishlist entry, same "own row per option" treatment CartItem already gets, so
   * saving one size/colour doesn't silently mark every other option as saved too. */
  variantId: mongoose.Types.ObjectId | null;
  createdAt: Date;
}

const WishlistSchema = new Schema<IWishlist>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
  },
  { timestamps: true }
);
// Includes variantId so a null-variant (plain product) entry and each of its variants'
// own entries can all coexist — Mongo's unique index still correctly allows only ONE
// null-variant row per (userId, productId), matching the pre-variant behavior.
WishlistSchema.index({ userId: 1, productId: 1, variantId: 1 }, { unique: true });

export const Wishlist = mongoose.model<IWishlist>('Wishlist', WishlistSchema);

// ───────────────────────────── REVIEW ───────────────────────────────

export interface IReview extends Document {
  userId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  /** Null = a review of the plain product (or a variant-less product). Set = a review
   * of one specific variant the customer bought — each variant gets its own rating,
   * same "own row per option" treatment Wishlist/CartItem already get, so one bad
   * review of the 250g bag doesn't drag down the 1kg bag's score. */
  variantId: mongoose.Types.ObjectId | null;
  rating: number;
  comment?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ReviewSchema = new Schema<IReview>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
    rating: { type: Number, required: true },
    comment: String,
  },
  { timestamps: true }
);
// Includes variantId so a null-variant review and each variant's own review from the
// same customer can all coexist — Mongo's unique index still allows only ONE
// null-variant review per (userId, productId), matching the pre-variant behavior.
ReviewSchema.index({ userId: 1, productId: 1, variantId: 1 }, { unique: true });
ReviewSchema.index({ productId: 1 });
ReviewSchema.index({ variantId: 1 });
ReviewSchema.index({ createdAt: -1 });

export const Review = mongoose.model<IReview>('Review', ReviewSchema);

// ───────────────────────────── NOTIFICATION ───────────────────────────────

export interface INotification extends Document {
  message: string;
  type: string;
  isRead: boolean;
  orderId?: mongoose.Types.ObjectId;
  triggeredById?: mongoose.Types.ObjectId;
  recipientId?: mongoose.Types.ObjectId;
  recipientRole: string;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    message: { type: String, required: true },
    type: { type: String, enum: NotificationTypeEnum, required: true },
    isRead: { type: Boolean, default: false },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    triggeredById: { type: Schema.Types.ObjectId, ref: 'User' },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User' },
    recipientRole: { type: String, default: 'admin' },
  },
  { timestamps: true }
);
// A user's own notification feed, sorted newest-first — see notification.controller.ts's getMyNotifications.
NotificationSchema.index({ recipientId: 1, createdAt: -1 });
NotificationSchema.index({ recipientRole: 1, isRead: 1 });

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);

// ───────────────────────────── OTP ───────────────────────────────

export interface IOtp extends Document {
  email: string;
  otp: string;
  purpose: string;
  expiresAt: Date;
  used: boolean;
  createdAt: Date;
}

const OtpSchema = new Schema<IOtp>(
  {
    email: { type: String, required: true },
    otp: { type: String, required: true },
    purpose: { type: String, default: 'login' },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
  },
  { timestamps: true }
);
OtpSchema.index({ email: 1, purpose: 1 });
// TTL: MongoDB automatically deletes the document once expiresAt is in the past —
// no cleanup job needed. expireAfterSeconds:0 means "delete exactly at expiresAt".
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Otp = mongoose.model<IOtp>('Otp', OtpSchema);

// ───────────────────────────── TEMP UPDATE ───────────────────────────────

export interface ITempUpdate extends Document {
  userId: mongoose.Types.ObjectId;
  pendingData: any;
  otp: string;
  expiresAt: Date;
  createdAt: Date;
}

const TempUpdateSchema = new Schema<ITempUpdate>(
  {
    userId: { type: Schema.Types.ObjectId, unique: true, ref: 'User', required: true },
    pendingData: { type: Schema.Types.Mixed, required: true },
    otp: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
TempUpdateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TempUpdate = mongoose.model<ITempUpdate>('TempUpdate', TempUpdateSchema);

// ───────────────────────────── COUPON ───────────────────────────────

export interface ICoupon extends Document {
  code: string;
  description?: string;
  discountType: string;
  discountValue: number;
  minOrderAmount: number;
  maxUses?: number;
  usedCount: number;
  isActive: boolean;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CouponSchema = new Schema<ICoupon>(
  {
    code: { type: String, required: true },
    description: String,
    discountType: { type: String, enum: ['PERCENTAGE', 'FLAT'], required: true },
    discountValue: { type: Number, required: true },
    minOrderAmount: { type: Number, default: 0 },
    maxUses: Number,
    usedCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    expiresAt: Date,
  },
  { timestamps: true }
);
CouponSchema.index({ code: 1 }, { unique: true });

export const Coupon = mongoose.model<ICoupon>('Coupon', CouponSchema);

// ───────────────────────────── STAFF PROFILE ───────────────────────────────

export interface IStaffProfile extends Document {
  userId: mongoose.Types.ObjectId;
  managedBy: mongoose.Types.ObjectId;
  permissions: string[];
  isActive: boolean;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const StaffProfileSchema = new Schema<IStaffProfile>(
  {
    userId: { type: Schema.Types.ObjectId, unique: true, ref: 'User', required: true },
    managedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    permissions: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true }
);
StaffProfileSchema.index({ managedBy: 1 });

export const StaffProfile = mongoose.model<IStaffProfile>('StaffProfile', StaffProfileSchema);

// ───────────────────────────── AUDIT LOG ───────────────────────────────

export interface IAuditLog extends Document {
  userId: mongoose.Types.ObjectId;
  action: string;
  entity: string;
  entityId?: string;
  details?: any;
  ipAddress?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: String,
    details: Schema.Types.Mixed,
    ipAddress: String,
  },
  { timestamps: true }
);
AuditLogSchema.index({ userId: 1 });
AuditLogSchema.index({ action: 1 });
AuditLogSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);

// ───────────────────────────── AUDIT LOG ARCHIVE ───────────────────────────────
// Cold-storage twin of AuditLog. Populated by the monthly archival cron
// (see backend/src/jobs/auditLogArchive.job.ts) — rows older than the retention
// window are copied here then removed from the hot collection, keeping AuditLog small
// and its indexes fast without ever discarding history.

const AuditLogArchiveSchema = new Schema(
  {
    originalId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: String,
    entity: String,
    entityId: String,
    details: Schema.Types.Mixed,
    ipAddress: String,
    originalCreatedAt: Date,
    archivedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);
AuditLogArchiveSchema.index({ originalCreatedAt: -1 });

export const AuditLogArchive = mongoose.model('AuditLogArchive', AuditLogArchiveSchema);

// ───────────────────────────── SYSTEM LOG ───────────────────────────────
// Centralized sink for warn/error-level application logs (see utils/logger.ts's Mongo
// transport). Capped so it self-bounds — oldest entries are automatically evicted —
// with no separate TTL/cleanup job required. Super-Admin-only, operational data, not
// tenant data — deliberately excluded from AuditLog (which is user-action history).

export interface ISystemLog extends Document {
  level: string;
  message: string;
  stack?: string;
  meta?: any;
  createdAt: Date;
}

const SystemLogSchema = new Schema<ISystemLog>(
  {
    level: { type: String, required: true },
    message: { type: String, required: true },
    stack: String,
    meta: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
  },
  { capped: { size: 20 * 1024 * 1024, max: 10000 } }
);
SystemLogSchema.index({ createdAt: -1 });
SystemLogSchema.index({ level: 1 });

export const SystemLog = mongoose.model<ISystemLog>('SystemLog', SystemLogSchema);

// ───────────────────────────── APP SETTING ───────────────────────────────

export interface IAppSetting extends Document {
  key: string;
  value: any;
  updatedAt: Date;
}

const AppSettingSchema = new Schema<IAppSetting>(
  {
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);
AppSettingSchema.index({ key: 1 }, { unique: true });

export const AppSetting = mongoose.model<IAppSetting>('AppSetting', AppSettingSchema);

// ───────────────────────────── PAYMENT LOG ───────────────────────────────

export interface IPaymentLog extends Document {
  userId: mongoose.Types.ObjectId;
  orderId: mongoose.Types.ObjectId;
  amount: number;
  event?: string;
  paymentStatus: string;
  paymentMethod: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  transactionId?: string;
  paymentScreenshot?: string;
  signatureValid?: boolean | null;
  gatewayResponse?: any;
  ipAddress?: string;
  notes?: string;
  createdAt: Date;
}

const PaymentLogSchema = new Schema<IPaymentLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    amount: { type: Number, required: true },
    event: String,
    paymentStatus: { type: String, enum: PaymentStatusEnum, required: true },
    paymentMethod: { type: String, enum: PaymentMethodEnum, required: true },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    transactionId: String,
    paymentScreenshot: String,
    signatureValid: Schema.Types.Mixed,
    gatewayResponse: Schema.Types.Mixed,
    ipAddress: String,
    notes: String,
  },
  { timestamps: true }
);

PaymentLogSchema.index({ createdAt: -1 });

export const PaymentLog = mongoose.model<IPaymentLog>('PaymentLog', PaymentLogSchema);

// ───────────────────────────── HOME BANNER ───────────────────────────────

export interface IHomeBanner extends Document {
  type?: string;
  title?: string;
  image: string;
  link?: string;
  discount?: string;
  description?: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const HomeBannerSchema = new Schema<IHomeBanner>(
  {
    type: String,
    title: String,
    image: { type: String, required: true },
    link: String,
    discount: String,
    description: String,
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

HomeBannerSchema.index({ isActive: 1, sortOrder: 1 });

export const HomeBanner = mongoose.model<IHomeBanner>('HomeBanner', HomeBannerSchema);

// ───────────────────────────── CUSTOMER TRACKER ───────────────────────────────

export interface ICustomerTracker extends Document {
  userId: mongoose.Types.ObjectId;
  pagePath: string;
  action: string;
  createdAt: Date;
}

const CustomerTrackerSchema = new Schema<ICustomerTracker>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pagePath: { type: String, required: true },
    action: { type: String, required: true },
  },
  { timestamps: true }
);

// TTL: raw page-view/action events are only useful for a rolling window — auto-expire
// after 90 days instead of growing this collection forever.
CustomerTrackerSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const CustomerTracker = mongoose.model<ICustomerTracker>('CustomerTracker', CustomerTrackerSchema);

// ───────────────────────────── PURCHASE SURVEY CONFIG ───────────────────────────────

export interface IPurchaseSurveyConfig extends Document {
  isEnabled: boolean;
  headerTitle: string;
  urgencyBanner: string;
  question: string;
  options: string[];
  allowCustomNote: boolean;
  customNotePlaceholder: string;
  skipButtonText: string;
  submitButtonText: string;
  createdAt: Date;
  updatedAt: Date;
}

const PurchaseSurveyConfigSchema = new Schema<IPurchaseSurveyConfig>(
  {
    isEnabled: { type: Boolean, default: true },
    headerTitle: { type: String, default: 'Sorry To See You Go..' },
    urgencyBanner: { type: String, default: ' Products In huge demand might run Out of Stock' },
    question: { type: String, default: 'What stopped you from completing your purchase?' },
    options: {
      type: [String],
      default: [
        'Found a better deal elsewhere',
        'Technical issues with the website',
        'I changed my mind',
        'Have issues with coupons',
        'Shipping charge too high',
        'Delivery takes too long',
      ],
    },
    allowCustomNote: { type: Boolean, default: true },
    customNotePlaceholder: { type: String, default: 'Others (please specify)' },
    skipButtonText: { type: String, default: 'Skip and exit' },
    submitButtonText: { type: String, default: 'Submit Feedback' },
  },
  { timestamps: true }
);

export const PurchaseSurveyConfig = mongoose.model<IPurchaseSurveyConfig>(
  'PurchaseSurveyConfig',
  PurchaseSurveyConfigSchema
);

// ───────────────────────────── CANCELLATION FEEDBACK ───────────────────────────────

export interface ICancellationFeedbackItem {
  productId?: string;
  name: string;
  price: number;
  quantity: number;
  image?: string;
  variant?: string;
}

export interface ICancellationFeedback extends Document {
  userId?: mongoose.Types.ObjectId;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  paymentMethod: string;
  triggerSource: string;
  orderId?: mongoose.Types.ObjectId;
  items: ICancellationFeedbackItem[];
  totalAmount: number;
  selectedReasons: string[];
  customNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CancellationFeedbackSchema = new Schema<ICancellationFeedback>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    customerName: { type: String, default: 'Guest Customer' },
    customerEmail: { type: String, default: '' },
    customerPhone: { type: String, default: '' },
    paymentMethod: { type: String, default: 'ONLINE' },
    triggerSource: { type: String, default: 'CHECKOUT_CANCELLED' },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: false },
    items: [
      {
        productId: { type: String },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, default: 1 },
        image: { type: String },
        variant: { type: String },
      },
    ],
    totalAmount: { type: Number, default: 0 },
    selectedReasons: { type: [String], default: [] },
    customNote: { type: String, default: '' },
  },
  { timestamps: true }
);

CancellationFeedbackSchema.index({ createdAt: -1 });
CancellationFeedbackSchema.index({ userId: 1 });
CancellationFeedbackSchema.index({ triggerSource: 1 });

export const CancellationFeedback = mongoose.model<ICancellationFeedback>(
  'CancellationFeedback',
  CancellationFeedbackSchema
);

// ── Aliases ───────────────────────────────────────────────────────────────────
export const Attribute = CategoryAttribute;
export const AttributeValue = CategoryAttributeValue;
export const CompanySettings = AppSetting;
export const PasswordReset = TempUpdate;
