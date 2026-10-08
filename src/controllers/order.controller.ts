import { Request, Response } from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import { User, Order, OrderItem, Cart, Product, PaymentLog, StaffProfile, Role, OrderStatus, NotificationType, Address } from "../models/mongoose";
import razorpay from "../config/razorpay";
import { calculateShippingWithConfig } from "../services/shipping.service";
import { env } from "../config/env";
import logger from "../utils/logger";
import { orderStatusEmailPayload, orderConfirmationEmailPayload } from "../config/mailer";
import { createAuditLog } from "../utils/auditLog";
import { getWarehouseCoords, getShippingConfigFromDB } from "../utils/warehouseSettings";
import { getAdminRecipients, getAdminAndStaffRecipients } from "../utils/notificationRecipients";
import { sendEmail } from "../services/email.service";
import { sendNotification } from "../services/notification.service";
import { restoreStock, checkLowStock } from "../services/inventory.service";
import { syncProductFromVariants } from "../utils/productVariant";
import { uploadToCloudinary } from "../config/cloudinary";

// ── Notification Helper ───────────────────────────────────────────────────────
/**
 * Fan-out: send one notification per recipient, in-process/fire-and-forget —
 * `_req` is kept only for call-site signature stability, it's no longer used here.
 */
const notifyUsers = async (
  _req: Request,
  orderId: string,
  message: string,
  type: NotificationType,
  actorId: string,
  recipientIds: string[],
): Promise<void> => {
  const uniqueRecipients = Array.from(new Set(recipientIds.filter(Boolean)));
  for (const recipientId of uniqueRecipients) {
    try {
      await sendNotification({ message, orderId, type, triggeredById: actorId, recipientId });
    } catch (err) {
      logger.warn(`notifyUser ${recipientId} error`, err);
    }
  }
};

// ── Stock Helper ───────────────────────────────────────────────────────────────
// Deduction stays synchronous/inline — it's the atomic "reject the order if stock
// is insufficient" check and must complete before the API responds. Only the
// non-blocking low-stock alert that follows a successful deduction is queued.
//
// `client` defaults to the global `prisma` bridge but should be the transaction-bound
// `tx` passed into a `prisma.$transaction(async (tx) => {...})` callback whenever this
// runs alongside other writes that must succeed or fail together (order creation,
// coupon usage, payment log) — see placeOrder/placeOrderPOD/placeAdminOrder below.
const deductStock = async (
  items: Array<{ productId: string; variantId?: string | null; quantity: number }>,
  client: typeof prisma = prisma,
) => {
  for (const item of items) {
    // Variant-carrying items deduct from the variant's OWN stock, not the product's —
    // Product.stock is meaningless once a product has ProductVariant rows (see
    // mongoose.ts's ProductVariant comment); only variant-less products still use it.
    const result = item.variantId
      ? await client.productVariant.updateMany({
          where: { id: item.variantId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        })
      : await client.product.updateMany({
          where: { id: item.productId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
    if (result.count === 0) {
      throw new Error(`Insufficient stock for product ${item.productId}`);
    }
    // A variant purchase just changed the variant's stock, not Product.stock directly —
    // resync so the low-stock check right below (and every other blind Product.stock
    // reader: category/admin filters, dashboard widget) sees this sale immediately
    // instead of going stale until an admin happens to touch Manage Variants again.
    if (item.variantId) {
      await syncProductFromVariants(item.productId, client);
    }
  }
  try {
    await checkLowStock({ productIds: items.map((i) => i.productId) });
  } catch (err) {
    logger.warn("checkLowStock error", err);
  }
};

// A cart item that carries a variant is only ever purchasable up to THAT variant's
// stock — Product.stock is irrelevant once the product has variant rows. Used
// everywhere a cart item's available quantity needs checking (preCheckout, placeOrder,
// placeOrderPOD).
const itemStock = (item: any): number => (item.variant ? item.variant.stock : item.product.stock);
const itemPrice = (item: any): number => {
  const base = item.variant?.priceOverride ?? item.product.price;
  // A variant's own discount (e.g. a promo on just the 50ml bottle) wins over the
  // product-level one — see mongoose.ts's ProductVariant discountOverride.
  const discount = item.variant ? (item.variant.discountOverride ?? 0) : item.product.discount;
  if (!discount || discount <= 0) return base;
  const raw = base * (1 - discount / 100);
  const round = Math.round(raw);
  const maxRoundingArtifact = Number.isInteger(base) ? Math.max(0.05, base * 0.00006) : 0.02;
  return Math.abs(raw - round) <= maxRoundingArtifact ? round : Math.round(raw * 100) / 100;
};

// GET /api/orders/pre-checkout  (authenticated)
export const preCheckout = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, variant: true } } },
    });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    const validItems = cart.items.filter((i: any) => itemStock(i) >= i.quantity);
    const outOfStock = cart.items.length - validItems.length;

    if (validItems.length === 0) {
      return res
        .status(400)
        .json({
          message: "All items in your cart are currently out of stock.",
        });
    }

    if (outOfStock > 0) {
      // Remove out-of-stock items from cart
      const staleIds = cart.items
        .filter((i: any) => itemStock(i) < i.quantity)
        .map((i: any) => i.id);
      await prisma.cartItem.deleteMany({ where: { id: { in: staleIds } } });
      return res
        .status(200)
        .json({
          message:
            "Some items were out of stock and removed. Proceeding with available items.",
          redirect: true,
        });
    }

    res
      .status(200)
      .json({ message: "Proceed to address selection", redirect: true });
  } catch (err: any) {
    logger.error("preCheckout error", err);
    res.status(500).json({ message: "Server error" });
  }
};

// POST /api/orders/place  (authenticated) — online payment
export const placeOrder = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { couponId, buyNowProductId, buyNowVariantId, shippingAddress: incomingAddress } = req.body as {
      couponId?: string;
      buyNowProductId?: string;
      buyNowVariantId?: string;
      shippingAddress?: any;
    };

    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, variant: true } } },
    });
    const address = await prisma.address.findFirst({
      where: { userId, isDefault: true },
    });

    if (!cart || cart.items.length === 0)
      return res.status(400).json({ message: "Cart is empty" });
    if (!address)
      return res.status(400).json({ message: "Delivery address missing" });

    // When Buy Now is used, only process the specified product and variant
    const eligibleItems = buyNowProductId
      ? cart.items.filter((i: any) =>
          i.product.id === buyNowProductId &&
          (!buyNowVariantId || i.variantId === buyNowVariantId),
        )
      : cart.items;

    if (eligibleItems.length === 0)
      return res.status(400).json({ message: "Product not found in cart" });

    // Build order items + subtotal
    let subtotal = 0;
    const orderItems = eligibleItems.map((item: any) => {
      const price = itemPrice(item);
      subtotal += price * item.quantity;
      return {
        productId: item.product.id,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        price: price,
      };
    });

    // Recalculate shipping server-side (security: never trust client)
    // If WAREHOUSE_SETTINGS feature is disabled by Super Admin → free shipping.
    // There's no standalone FeatureFlag model (see review.controller.ts's
    // isReviewsEnabled for the full explanation) — this used to call
    // prisma.featureFlag.findUnique(...), which threw on every checkout. Reads from
    // the generic AppSetting store instead, same as every other admin-togglable
    // setting in this app.
    const warehouseFlag = await prisma.appSetting.findUnique({ where: { key: "WAREHOUSE_SETTINGS_ENABLED" } });
    const warehouseFeatureEnabled = !warehouseFlag || (warehouseFlag.value !== false && warehouseFlag.value !== "false");
    let shippingCharge: number;
    if (warehouseFeatureEnabled) {
      const [warehouse, shippingConfig] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
      if (shippingConfig.calculateShippingForOnline === false) {
        shippingCharge = 0; // Shipping calculation disabled for Online Payments → Free
      } else {
        shippingCharge = (await calculateShippingWithConfig(
          address.latitude ?? 0,
          address.longitude ?? 0,
          address.country,
          address.state,
          address.city ?? "",
          address.zipCode ?? "",
          shippingConfig,
          warehouse.lat,
          warehouse.lng,
        )).shippingCharge;
      }
    } else {
      shippingCharge = 0; // Warehouse Settings disabled → free shipping
    }

    // ── Coupon validation (server-side re-check for security) ─────────────
    let discountAmount = 0;
    let resolvedCouponId: string | undefined;

    if (couponId) {
      const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
      if (coupon && coupon.isActive && (!coupon.expiresAt || new Date(coupon.expiresAt).getTime() > Date.now()) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses) && subtotal >= coupon.minOrderAmount) {
        discountAmount = coupon.discountType === "PERCENTAGE"
          ? Math.round((subtotal * coupon.discountValue) / 100)
          : Math.min(coupon.discountValue, subtotal);
        resolvedCouponId = coupon.id;
      }
    }

    const finalAmount = Math.max(subtotal + shippingCharge - discountAmount, 0);

    // Create Razorpay order
    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(finalAmount * 100), // paise
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    });

    // Order + coupon usage + stock deduction + payment log succeed or fail together —
    // a partial write here (e.g. order created but stock not deducted) would sell stock
    // that was never actually reserved. Razorpay order creation happens before the
    // transaction because it's an external, non-transactional side effect: if the DB
    // transaction below fails, the Razorpay order is simply never referenced by any
    // persisted Order (a harmless orphan on Razorpay's side, not a data-integrity issue).
    const order = await prisma.$transaction(async (tx: typeof prisma) => {
      const finalShippingAddress = incomingAddress?.fullAddress ? {
        fullAddress: incomingAddress.fullAddress,
        city: incomingAddress.city || address.city,
        state: incomingAddress.state || address.state,
        zipCode: incomingAddress.zipCode || address.zipCode,
        country: incomingAddress.country || address.country || "India",
        lat: typeof incomingAddress.lat === "number" ? incomingAddress.lat : (address.latitude ?? undefined),
        lng: typeof incomingAddress.lng === "number" ? incomingAddress.lng : (address.longitude ?? undefined),
      } : {
        fullAddress: address.fullAddress,
        city: address.city,
        state: address.state,
        zipCode: address.zipCode,
        country: address.country,
        lat: address.latitude ?? undefined,
        lng: address.longitude ?? undefined,
      };

      const created = await tx.order.create({
        data: {
          userId,
          totalAmount: subtotal,
          shippingCharge,
          discountAmount,
          taxAmount: 0,
          finalAmount,
          paymentMethod: "ONLINE",
          paymentStatus: "PENDING",
          orderStatus: "PROCESSING",
          razorpayOrderId: rzpOrder.id,
          couponId: resolvedCouponId,
          shippingAddress: finalShippingAddress,
          items: { create: orderItems },
        },
      });

      if (resolvedCouponId) {
        await tx.coupon.update({ where: { id: resolvedCouponId }, data: { usedCount: { increment: 1 } } });
      }

      await deductStock(orderItems, tx);

      await tx.paymentLog.create({
        data: {
          orderId: created.id,
          userId,
          event: "ORDER_CREATED",
          razorpayOrderId: rzpOrder.id,
          paymentMethod: "ONLINE",
          paymentStatus: "PENDING",
          amount: finalAmount,
          gatewayResponse: { razorpayOrderId: rzpOrder.id, currency: rzpOrder.currency, receipt: rzpOrder.receipt },
          signatureValid: null,
          ipAddress: req.ip ?? null,
        },
      });

      return created;
    });

    res.status(200).json({ order, rzpOrder, razorpay_key_id: env.RAZORPAY_KEY_ID });
  } catch (err: any) {
    logger.error("placeOrder error", err);
    res
      .status(500)
      .json({ message: "Error initiating order", error: err.message });
  }
};

// POST /api/orders/verify  (authenticated)
export const verifyPayment = async (req: Request, res: Response) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, buyNowProductId, buyNowVariantId } =
      req.body as { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string; buyNowProductId?: string; buyNowVariantId?: string };
    const userId = req.user!.id;

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    const order = await prisma.order.findFirst({
      where: { razorpayOrderId: razorpay_order_id },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const shortId = order.id.slice(-6);

    // Idempotency guard: Razorpay commonly delivers both a server-side webhook AND a
    // frontend redirect callback for the same payment (by design — belt and suspenders
    // against either one failing to arrive), and a user double-tapping "confirm" or a
    // frontend retry-on-timeout can trigger this endpoint twice too. Without this check,
    // a second call for an already-PAID order re-runs the entire success path: a second
    // PaymentLog row, a second cart-clear, duplicate customer/admin notifications, and a
    // duplicate confirmation email. Confirmed live via fault-injection testing — calling
    // this twice with an identical valid signature produced 2 PaymentLog rows before this fix.
    if (order.paymentStatus === "PAID") {
      return res.status(200).json({ message: "Success", order });
    }

    if (expectedSignature === razorpay_signature) {
      // Payment confirmation, its log entry, and clearing the cart must succeed or fail
      // together — a payment marked PAID with no PaymentLog record (or vice versa) is
      // exactly the kind of partial write a financial event can't tolerate.
      //
      // The `paymentStatus: { not: "PAID" }` guard makes this a compare-and-swap: if two
      // concurrent calls for the same order both pass the isPAID check above (a genuine
      // race, not just sequential duplicates), only ONE of them actually matches this
      // update and runs the side effects below — the other gets `updatedOrder === null`
      // and short-circuits to the idempotent-success response, never double-processing.
      const updated = await prisma.$transaction(async (tx: typeof prisma) => {
        const updatedOrder = await tx.order.update({
          where: { id: order.id, paymentStatus: { not: "PAID" } },
          data: {
            paymentStatus: "PAID",
            orderStatus: "CONFIRMED",
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
          },
        });
        if (!updatedOrder) return null; // lost the race — another call already processed this payment

        await tx.paymentLog.create({
          data: {
            orderId: order.id,
            userId,
            event: "PAYMENT_SUCCESS",
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
            paymentMethod: "ONLINE",
            paymentStatus: "PAID",
            amount: order.finalAmount,
            signatureValid: true,
            gatewayResponse: { razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id },
            ipAddress: req.ip ?? null,
          },
        });

        // Clear only the bought item (Buy Now) or the entire cart (regular checkout)
        if (buyNowProductId) {
          await tx.cartItem.deleteMany({
            where: {
              cart: { userId },
              productId: buyNowProductId,
              ...(buyNowVariantId ? { variantId: buyNowVariantId } : {}),
            },
          });
        } else {
          await tx.cart.deleteMany({ where: { userId } });
        }

        return updatedOrder;
      });

      if (!updated) {
        // Lost the race to a concurrent call for the same payment — it already ran the
        // notifications/email side effects, so this call is done: report success without
        // repeating them.
        const current = await prisma.order.findUnique({ where: { id: order.id } });
        return res.status(200).json({ message: "Success", order: current });
      }

      res.status(200).json({ message: "Success", order: updated });

      // Payment is already confirmed and committed at this point — notifications and
      // the confirmation email are best-effort (each already caught/logged on its own
      // below), so they run after the response instead of adding an SMTP round-trip
      // to the "Processing…" spinner the customer is staring at post-payment.
      void (async () => {
        try {
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { username: true, email: true },
          });
          const adminIds = await getAdminRecipients();
          const orderRecipients = await getAdminAndStaffRecipients("ORDER_VIEW");
          await notifyUsers(req, order.id, `New Order from ${user!.username}: ₹${order.finalAmount}`, "NEW_ORDER", userId, orderRecipients);
          await notifyUsers(req, order.id, `Payment Confirmed: Order #${shortId} by ${user!.username}`, "PAYMENT_SUCCESS", userId, adminIds);
          await notifyUsers(req, order.id, `Success! Payment confirmed for order #${shortId}`, "PAYMENT_SUCCESS", userId, [userId]);

          if (user?.email) {
            try {
              await sendEmail({
                to: user.email,
                toName: user.username,
                ...orderConfirmationEmailPayload(shortId, user.username, updated.finalAmount.toFixed(2), "ONLINE"),
              });
              logger.info(`Order confirmation email sent for ${user.email}`);
            } catch (emailErr) {
              logger.error("Order confirmation email failed", emailErr);
            }
          }
        } catch (bgErr) {
          logger.error("verifyPayment post-response notify/email error", bgErr);
        }
      })();
      return;
    } else {
      await prisma.$transaction(async (tx: typeof prisma) => {
        await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: "FAILED" },
        });

        await tx.paymentLog.create({
          data: {
            orderId: order.id,
            userId,
            event: "PAYMENT_FAILED",
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
            paymentMethod: "ONLINE",
            paymentStatus: "FAILED",
            amount: order.finalAmount,
            signatureValid: false,
            gatewayResponse: { razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id, reason: "signature_mismatch" },
            ipAddress: req.ip ?? null,
          },
        });
      });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });
      const adminIds = await getAdminRecipients();
      await notifyUsers(req, order.id, `ALERT: Payment Failed for ${user!.username} (#${shortId})`, "PAYMENT_FAILED", userId, adminIds);
      await notifyUsers(req, order.id, `Payment failed for order #${shortId}. Please contact support.`, "PAYMENT_FAILED", userId, [userId]);
      return res.status(400).json({ message: "Payment verification failed" });
    }
  } catch (err: any) {
    logger.error("verifyPayment error", err);
    res.status(500).json({ message: "Verification Error" });
  }
};

// POST /api/orders/place-pod  (authenticated) — Pay on Delivery
export const placeOrderPOD = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { couponId, buyNowProductId, buyNowVariantId, shippingAddress: incomingAddress } = req.body as {
      couponId?: string;
      buyNowProductId?: string;
      buyNowVariantId?: string;
      shippingAddress?: any;
    };

    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, variant: true } } },
    });
    const address = await prisma.address.findFirst({
      where: { userId, isDefault: true },
    });

    if (!cart || cart.items.length === 0)
      return res.status(400).json({ message: "Cart is empty" });
    if (!address)
      return res.status(400).json({ message: "Delivery address missing" });

    if (address.country !== "India") {
      return res
        .status(400)
        .json({
          message: "Pay on Delivery is not available for international orders.",
        });
    }

    // When Buy Now is used, only process the specified product and variant
    const eligibleItems = buyNowProductId
      ? cart.items.filter((i: any) =>
          i.product.id === buyNowProductId &&
          (!buyNowVariantId || i.variantId === buyNowVariantId),
        )
      : cart.items;

    if (eligibleItems.length === 0)
      return res.status(400).json({ message: "Product not found in cart" });

    let subtotal = 0;
    const orderItems = eligibleItems.map((item: any) => {
      const price = itemPrice(item);
      subtotal += price * item.quantity;
      return {
        productId: item.product.id,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        price: price,
      };
    });

    // If WAREHOUSE_SETTINGS feature is disabled by Super Admin → free shipping
    // (see the identical block above for why this reads AppSetting, not featureFlag)
    const warehouseFlagPOD = await prisma.appSetting.findUnique({ where: { key: "WAREHOUSE_SETTINGS_ENABLED" } });
    const warehouseFeatureEnabledPOD = !warehouseFlagPOD || (warehouseFlagPOD.value !== false && warehouseFlagPOD.value !== "false");
    let shippingCharge: number;
    if (warehouseFeatureEnabledPOD) {
      const [warehouse, shippingConfig] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
      if (shippingConfig.calculateShippingForCOD === false) {
        shippingCharge = 0; // Shipping calculation disabled for Cash on Delivery → Free
      } else {
        shippingCharge = (await calculateShippingWithConfig(
          address.latitude ?? 0,
          address.longitude ?? 0,
          address.country,
          address.state,
          address.city ?? "",
          address.zipCode ?? "",
          shippingConfig,
          warehouse.lat,
          warehouse.lng,
        )).shippingCharge;
      }
    } else {
      shippingCharge = 0; // Warehouse Settings disabled → free shipping
    }

    // ── Coupon validation (server-side re-check for security) ─────────────
    let discountAmount = 0;
    let resolvedCouponId: string | undefined;

    if (couponId) {
      const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
      if (coupon && coupon.isActive && (!coupon.expiresAt || new Date(coupon.expiresAt).getTime() > Date.now()) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses) && subtotal >= coupon.minOrderAmount) {
        discountAmount = coupon.discountType === "PERCENTAGE"
          ? Math.round((subtotal * coupon.discountValue) / 100)
          : Math.min(coupon.discountValue, subtotal);
        resolvedCouponId = coupon.id;
      }
    }

    const finalAmount = Math.max(subtotal + shippingCharge - discountAmount, 0);

    // Order + coupon usage + stock deduction + cart clear + payment log all succeed or
    // fail together (see placeOrder above for why).
    const order = await prisma.$transaction(async (tx: typeof prisma) => {
      const finalShippingAddress = incomingAddress?.fullAddress ? {
        fullAddress: incomingAddress.fullAddress,
        city: incomingAddress.city || address.city,
        state: incomingAddress.state || address.state,
        zipCode: incomingAddress.zipCode || address.zipCode,
        country: incomingAddress.country || address.country || "India",
        lat: typeof incomingAddress.lat === "number" ? incomingAddress.lat : (address.latitude ?? undefined),
        lng: typeof incomingAddress.lng === "number" ? incomingAddress.lng : (address.longitude ?? undefined),
      } : {
        fullAddress: address.fullAddress,
        city: address.city,
        state: address.state,
        zipCode: address.zipCode,
        country: address.country,
        lat: address.latitude ?? undefined,
        lng: address.longitude ?? undefined,
      };

      const created = await tx.order.create({
        data: {
          userId,
          totalAmount: subtotal,
          shippingCharge,
          discountAmount,
          taxAmount: 0,
          finalAmount,
          paymentMethod: "POD",
          paymentStatus: "PENDING",
          orderStatus: "CONFIRMED",
          couponId: resolvedCouponId,
          shippingAddress: finalShippingAddress,
          items: { create: orderItems },
        },
      });

      if (resolvedCouponId) {
        await tx.coupon.update({ where: { id: resolvedCouponId }, data: { usedCount: { increment: 1 } } });
      }

      await deductStock(orderItems, tx);

      // Clear only the bought item (Buy Now) or the entire cart (regular checkout)
      if (buyNowProductId) {
        await tx.cartItem.deleteMany({
          where: {
            cart: { userId },
            productId: buyNowProductId,
            ...(buyNowVariantId ? { variantId: buyNowVariantId } : {}),
          },
        });
      } else {
        await tx.cart.deleteMany({ where: { userId } });
      }

      await tx.paymentLog.create({
        data: {
          orderId: created.id,
          userId,
          event: "ORDER_POD",
          paymentMethod: "POD",
          paymentStatus: "PENDING",
          amount: finalAmount,
          signatureValid: null,
          gatewayResponse: { note: "Pay on Delivery — no gateway transaction" },
          ipAddress: req.ip ?? null,
        },
      });

      return created;
    });

    res.status(200).json({ message: "Order placed successfully via POD", order });

    // Order is already committed at this point — notifications and the confirmation
    // email are best-effort (each already caught/logged on its own below), so they
    // run after the response instead of adding their round-trip time to checkout.
    void (async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { username: true, email: true },
        });
        const shortId = order.id.slice(-6);
        const orderRecipients = await getAdminAndStaffRecipients("ORDER_VIEW");
        await notifyUsers(req, order.id, `New POD Order from ${user!.username}: ₹${finalAmount}`, "NEW_ORDER", userId, orderRecipients);
        await notifyUsers(req, order.id, `Your POD order #${shortId} has been confirmed! Pay on delivery.`, "NEW_ORDER", userId, [userId]);

        if (user?.email) {
          try {
            await sendEmail({
              to: user.email,
              toName: user.username,
              ...orderConfirmationEmailPayload(shortId, user.username, finalAmount.toFixed(2), "POD"),
            });
            logger.info(`POD order confirmation email sent for ${user.email}`);
          } catch (emailErr) {
            logger.error("POD order confirmation email failed", emailErr);
          }
        }
      } catch (bgErr) {
        logger.error("placeOrderPOD post-response notify/email error", bgErr);
      }
    })();
  } catch (err: any) {
    logger.error("placeOrderPOD error", err);
    res
      .status(500)
      .json({ message: "Error placing POD order", error: err.message });
  }
};

// POST /api/orders/placeOrderQR  (authenticated — customer pays via QR & submits UTR / screenshot)
export const placeOrderQR = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { couponId, buyNowProductId, buyNowVariantId, transactionId, shippingAddress: rawShippingAddress } = req.body as {
      couponId?: string;
      buyNowProductId?: string;
      buyNowVariantId?: string;
      transactionId?: string;
      shippingAddress?: any;
    };
    let incomingAddress = rawShippingAddress;
    if (typeof incomingAddress === "string") {
      try {
        incomingAddress = JSON.parse(incomingAddress);
      } catch {}
    }
    const rawTxId = transactionId?.trim() ? transactionId.trim().replace(/[\s-]/g, "") : undefined;
    let trimmedTxId: string | undefined;

    if (rawTxId) {
      const isUtr = /^\d{12}$/.test(rawTxId);
      const isAlphaRef = /^[a-zA-Z0-9_-]{10,35}$/.test(rawTxId);
      if (!isUtr && !isAlphaRef) {
        res.status(400).json({
          message:
            "Invalid Transaction ID / UTR. Must be a 12-digit numeric UTR or a valid 10-35 character UPI reference ID.",
        });
        return;
      }
      trimmedTxId = rawTxId;
    }

    let screenshotUrl: string | undefined;

    if (req.file) {
      screenshotUrl = await uploadToCloudinary(req.file.buffer, "payment_receipts");
    }

    if (!trimmedTxId && !screenshotUrl) {
      res.status(400).json({
        message: "Please enter your 12-digit UTR or upload a payment screenshot.",
      });
      return;
    }

    const [address, cart] = await Promise.all([
      prisma.address.findFirst({ where: { userId, isDefault: true } }),
      prisma.cart.findUnique({
        where: { userId },
        include: {
          items: {
            include: {
              product: true,
              variant: true,
            },
          },
        },
      }),
    ]);

    if (!address) {
      res.status(400).json({ message: "Default address not found" });
      return;
    }

    if (!cart || cart.items.length === 0) {
      res.status(400).json({ message: "Cart is empty" });
      return;
    }

    const eligibleItems = buyNowProductId
      ? cart.items.filter((i: any) =>
          i.product.id === buyNowProductId &&
          (!buyNowVariantId || i.variantId === buyNowVariantId),
        )
      : cart.items;

    if (eligibleItems.length === 0) {
      res.status(400).json({ message: "Product not found in cart" });
      return;
    }

    let subtotal = 0;
    const orderItems = eligibleItems.map((item: any) => {
      const price = itemPrice(item);
      subtotal += price * item.quantity;
      return {
        productId: item.product.id,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        price: price,
      };
    });

    const warehouseFlagQR = await prisma.appSetting.findUnique({ where: { key: "WAREHOUSE_SETTINGS_ENABLED" } });
    const warehouseFeatureEnabledQR = !warehouseFlagQR || (warehouseFlagQR.value !== false && warehouseFlagQR.value !== "false");
    let shippingCharge: number;
    if (warehouseFeatureEnabledQR) {
      const [warehouse, shippingConfig] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
      if (shippingConfig.calculateShippingForQR === false) {
        shippingCharge = 0; // Shipping calculation disabled for QR Payments → Free
      } else {
        shippingCharge = (await calculateShippingWithConfig(
          address.latitude ?? 0,
          address.longitude ?? 0,
          address.country,
          address.state,
          address.city ?? "",
          address.zipCode ?? "",
          shippingConfig,
          warehouse.lat,
          warehouse.lng,
        )).shippingCharge;
      }
    } else {
      shippingCharge = 0;
    }

    let discountAmount = 0;
    let resolvedCouponId: string | undefined;

    if (couponId) {
      const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
      if (coupon && coupon.isActive && (!coupon.expiresAt || new Date(coupon.expiresAt).getTime() > Date.now()) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses) && subtotal >= coupon.minOrderAmount) {
        discountAmount = coupon.discountType === "PERCENTAGE"
          ? Math.round((subtotal * coupon.discountValue) / 100)
          : Math.min(coupon.discountValue, subtotal);
        resolvedCouponId = coupon.id;
      }
    }

    const finalAmount = Math.max(subtotal + shippingCharge - discountAmount, 0);

    const order = await prisma.$transaction(async (tx: typeof prisma) => {
      const finalShippingAddress = incomingAddress?.fullAddress ? {
        fullAddress: incomingAddress.fullAddress,
        city: incomingAddress.city || address.city,
        state: incomingAddress.state || address.state,
        zipCode: incomingAddress.zipCode || address.zipCode,
        country: incomingAddress.country || address.country || "India",
        lat: typeof incomingAddress.lat === "number" ? incomingAddress.lat : (address.latitude ?? undefined),
        lng: typeof incomingAddress.lng === "number" ? incomingAddress.lng : (address.longitude ?? undefined),
      } : {
        fullAddress: address.fullAddress,
        city: address.city,
        state: address.state,
        zipCode: address.zipCode,
        country: address.country,
        lat: address.latitude ?? undefined,
        lng: address.longitude ?? undefined,
      };

      const created = await tx.order.create({
        data: {
          userId,
          totalAmount: subtotal,
          shippingCharge,
          discountAmount,
          taxAmount: 0,
          finalAmount,
          paymentMethod: "QR",
          paymentStatus: "PAID",
          orderStatus: "PROCESSING",
          transactionId: trimmedTxId,
          paymentScreenshot: screenshotUrl,
          couponId: resolvedCouponId,
          shippingAddress: finalShippingAddress,
          items: { create: orderItems },
        },
      });

      if (resolvedCouponId) {
        await tx.coupon.update({ where: { id: resolvedCouponId }, data: { usedCount: { increment: 1 } } });
      }

      await deductStock(orderItems, tx);

      if (buyNowProductId) {
        await tx.cartItem.deleteMany({
          where: {
            cart: { userId },
            productId: buyNowProductId,
            ...(buyNowVariantId ? { variantId: buyNowVariantId } : {}),
          },
        });
      } else {
        await tx.cart.deleteMany({ where: { userId } });
      }

      await tx.paymentLog.create({
        data: {
          orderId: created.id,
          userId,
          event: "ORDER_QR",
          paymentMethod: "QR",
          paymentStatus: "PAID",
          amount: finalAmount,
          transactionId: trimmedTxId,
          paymentScreenshot: screenshotUrl,
          signatureValid: null,
          notes: trimmedTxId ? `UTR: ${trimmedTxId}` : "Payment screenshot attached",
          gatewayResponse: {
            transactionId: trimmedTxId,
            paymentScreenshot: screenshotUrl,
            note: "Paid via QR code — pending admin verification",
          },
          ipAddress: req.ip ?? null,
        },
      });

      return created;
    });

    res.status(200).json({ message: "Order placed successfully via QR", order });

    void (async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { username: true, email: true },
        });
        const shortId = order.id.slice(-6);
        const orderRecipients = await getAdminAndStaffRecipients("ORDER_VIEW");
        await notifyUsers(req, order.id, `New QR Order from ${user!.username}: ₹${finalAmount}`, "NEW_ORDER", userId, orderRecipients);
        await notifyUsers(req, order.id, `Your QR payment order #${shortId} has been submitted! Awaiting verification.`, "NEW_ORDER", userId, [userId]);

        if (user?.email) {
          try {
            await sendEmail({
              to: user.email,
              toName: user.username,
              ...orderConfirmationEmailPayload(shortId, user.username, finalAmount.toFixed(2), "ONLINE"),
            });
            logger.info(`QR order confirmation email sent for ${user.email}`);
          } catch (emailErr) {
            logger.error("QR order confirmation email failed", emailErr);
          }
        }
      } catch (bgErr) {
        logger.error("placeOrderQR post-response notify/email error", bgErr);
      }
    })();
  } catch (err: any) {
    logger.error("placeOrderQR error", err);
    res.status(500).json({ message: "Error placing QR order", error: err.message });
  }
};

// POST /api/orders/cancel/:id  (authenticated)
export const cancelOrder = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.id;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    // Ownership: customers can only cancel their own orders
    if (order.userId !== userId) {
      return res.status(403).json({ message: "Forbidden." });
    }

    // Only allow cancellation of orders still in PROCESSING state.
    // PROCESSING = online payment not yet completed.
    // CONFIRMED / SHIPPED = order is active — contact admin to cancel.
    if (order.orderStatus !== "PROCESSING") {
      return res.status(400).json({
        message:
          order.orderStatus === "CANCELLED"
            ? "This order is already cancelled."
            : "Only orders awaiting payment can be self-cancelled. Please contact support to cancel a confirmed or shipped order.",
      });
    }

    // Compare-and-swap the status transition itself: only proceed (and only enqueue the
    // stock restore) if this call is the one that actually moves PROCESSING → CANCELLED.
    // Without this, two concurrent cancel calls for the same order (double-click, two
    // open tabs) would both pass the read-check above and both enqueue a restore job —
    // the worker-level guard in inventory.worker.ts's restoreStock() would still stop
    // the double-restore, but this stops the redundant job from ever being queued.
    const cancelled = await prisma.order.update({
      where: { id, orderStatus: "PROCESSING" },
      data: { orderStatus: "CANCELLED" },
    });
    if (!cancelled) {
      return res.status(400).json({ message: "This order was already updated by another request." });
    }

    // Restore stock (fire-and-forget — not correctness-blocking for this response)
    await restoreStock({
      orderId: id,
      items: order.items.map((item: any) => ({ productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity })),
    });

    await prisma.paymentLog.create({
      data: {
        orderId: id,
        userId: order.userId,
        event: "ORDER_CANCELLED",
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        amount: order.finalAmount,
        gatewayResponse: { cancelledBy: userId, self: true },
        signatureValid: null,
        ipAddress: req.ip ?? null,
      },
    });

    res.status(200).json({ message: "Order cancelled and stock restored" });
  } catch (err: any) {
    logger.error("cancelOrder error", err);
    res.status(500).json({ message: "Cancel error" });
  }
};

// PATCH /api/orders/:id/refund  (admin/staff — ORDER_UPDATE)
// Storra has no live payment-gateway refund integration — this doesn't move any money
// itself. It's a paper-trail action for an admin who already refunded the customer
// outside the system (Razorpay dashboard, bank transfer) to record that it happened,
// since paymentStatus otherwise stays stuck on "PAID" forever even after the order
// itself is CANCELLED — leaving Customer Payment History showing a cancelled order as
// still-paid with no way to know a refund is owed or was already handled.
export const refundOrder = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const adminId = req.user!.id;
    const { note } = (req.body ?? {}) as { note?: string };

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.paymentStatus !== "PAID") {
      return res.status(400).json({ message: "Only a PAID order's payment can be marked as refunded" });
    }
    if (order.orderStatus !== "CANCELLED" && order.orderStatus !== "RETURNED") {
      return res.status(400).json({ message: "Cancel or return the order before recording a refund" });
    }

    // Compare-and-swap, same reasoning as cancelOrder/updateStatus above — a
    // double-click shouldn't create two PaymentLog rows for the same refund.
    // Both writes share one transaction so a failure creating the PaymentLog
    // (e.g. a validation error) rolls the status flip back too, instead of
    // leaving the order stuck on REFUNDED with no log to show for it.
    const updated = await prisma.$transaction(async (tx: typeof prisma) => {
      const result = await tx.order.update({
        where: { id, paymentStatus: "PAID" },
        data: { paymentStatus: "REFUNDED" },
      });
      if (!result) return null;

      await tx.paymentLog.create({
        data: {
          orderId: id,
          userId: order.userId,
          event: "REFUND_RECORDED",
          paymentMethod: order.paymentMethod,
          paymentStatus: "REFUNDED",
          amount: order.finalAmount,
          notes: note?.trim() || undefined,
          gatewayResponse: { recordedBy: adminId },
          signatureValid: null,
          ipAddress: req.ip ?? null,
        },
      });

      return result;
    });
    if (!updated) {
      return res.status(400).json({ message: "This order's payment was already updated by another request." });
    }

    await createAuditLog({
      req,
      action: "RECORD_REFUND",
      entity: "Order",
      entityId: id,
      details: { amount: order.finalAmount, note: note?.trim() || undefined },
    });

    res.status(200).json({ message: "Refund recorded", order: updated });
  } catch (err: any) {
    logger.error("refundOrder error", err);
    res.status(500).json({ message: "Error recording refund" });
  }
};

// GET /api/orders/my-orders?page=1&limit=10  (authenticated)
export const getOrders = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { page = "1", limit = "10" } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "10") || 10, 1), 50);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: { userId },
        include: {
          items: {
            include: {
              product: {
                select: { id: true, name: true, image: true, price: true },
              },
              // Which size/color/storage/etc. was actually purchased — see
              // mongoose.ts's ProductVariant. Absent (null) for a plain-SKU item.
              variant: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.order.count({ where: { userId } }),
    ]);

    res.status(200).json({
      message: "Orders Fetched successfully",
      order: orders,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getOrders error", err);
    res.status(500).json({ message: "Error in fetching orders" });
  }
};

// GET /api/orders/admin?page=1&limit=20&status=&source=&placedBy=&search=  (admin/staff)
export const getOrdersForAdmin = async (req: Request, res: Response) => {
  try {
    const { page = "1", limit = "20", status, source, placedBy, search, invoicePrinted, startDate, endDate } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "20") || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;
    const where: any = {};

    if (status) {
      where.orderStatus = status.toUpperCase() as OrderStatus;
    }

    if (placedBy && placedBy.trim()) {
      where.placedByAdminId = placedBy.trim();
    } else if (source === "ADMIN" || source === "STAFF") {
      where.placedByAdminId = { not: null };
    } else if (source === "CUSTOMER") {
      where.placedByAdminId = null;
    }

    if (invoicePrinted === "true") {
      where.invoicePrinted = true;
    } else if (invoicePrinted === "false") {
      where.invoicePrinted = { not: true };
      if (!status) {
        where.orderStatus = { not: "CANCELLED" };
      }
    }

    if (startDate && startDate.trim()) {
      const start = new Date(startDate.trim());
      if (!isNaN(start.getTime())) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(startDate.trim())) {
          start.setUTCHours(0, 0, 0, 0);
        }
        where.createdAt = {
          ...(where.createdAt || {}),
          gte: start,
        };
      }
    }

    if (endDate && endDate.trim()) {
      const end = new Date(endDate.trim());
      if (!isNaN(end.getTime())) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())) {
          end.setUTCHours(23, 59, 59, 999);
        }
        where.createdAt = {
          ...(where.createdAt || {}),
          lte: end,
        };
      }
    }

    if (search && search.trim()) {
      const q = search.trim();
      const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escapedQ, "i");

      // Find matching users (customer username, email, phone)
      const matchingUsers = await User.find({
        $or: [
          { username: { $regex: regex } },
          { email: { $regex: regex } },
          { phone: { $regex: regex } },
        ],
      }).select("_id").lean();
      const matchedUserIds = matchingUsers.map((u: any) => u._id);

      const orConditions: any[] = [
        // Order ID partial match (supports short 6-8 char IDs or full 24-char ObjectId)
        {
          $expr: {
            $regexMatch: {
              input: { $toString: "$_id" },
              regex: escapedQ,
              options: "i",
            },
          },
        },
        // Shipping address search
        { "shippingAddress.fullName": { contains: q, mode: "insensitive" } },
        { "shippingAddress.name": { contains: q, mode: "insensitive" } },
        { "shippingAddress.phone": { contains: q } },
        { "shippingAddress.city": { contains: q, mode: "insensitive" } },
        // Tracking & payment references
        { trackingId: { contains: q, mode: "insensitive" } },
        { deliveryPartnerName: { contains: q, mode: "insensitive" } },
        { razorpayPaymentId: { contains: q, mode: "insensitive" } },
        { transactionId: { contains: q, mode: "insensitive" } },
      ];

      // If matching users found, include orders for those users or placed by them
      if (matchedUserIds.length > 0) {
        orConditions.push({ userId: { in: matchedUserIds } });
        orConditions.push({ placedByAdminId: { in: matchedUserIds } });
      }

      // If exact 24-hex string, also allow direct ObjectId match
      if (mongoose.Types.ObjectId.isValid(q) && q.length === 24) {
        orConditions.push({ id: q });
      }

      where.OR = orConditions;
    }

    const [orders, total, adminStaffList] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, email: true, phone: true } },
          placedByAdmin: { select: { id: true, username: true, email: true, role: true } },
          items: {
            include: {
              product: {
                select: { id: true, name: true, price: true, image: true },
              },
              // See getOrders's identical include — which option was purchased.
              variant: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.order.count({ where }),
      prisma.user.findMany({
        where: { role: { in: ["ADMIN", "SUPER_ADMIN", "STAFF"] } },
        select: { id: true, username: true, email: true, role: true },
        orderBy: { username: "asc" },
      }),
    ]);

    // Fallback lookup in case relation bridge missed any placedByAdminId
    const missingAdminIds = orders
      .filter((o: any) => o.placedByAdminId && !o.placedByAdmin)
      .map((o: any) => o.placedByAdminId);

    if (missingAdminIds.length > 0) {
      const fallbackAdmins = await User.find({ _id: { $in: missingAdminIds } })
        .select("_id username email role")
        .lean();
      const adminMap = Object.fromEntries(
        (fallbackAdmins as any[]).map((u: any) => [
          u._id.toString(),
          { id: u._id.toString(), username: u.username, email: u.email ?? null, role: u.role ?? "ADMIN" },
        ])
      );
      for (const o of orders as any[]) {
        if (o.placedByAdminId && !o.placedByAdmin) {
          o.placedByAdmin = adminMap[o.placedByAdminId.toString()] ?? null;
        }
      }
    }

    res.status(200).json({
      message: "Orders fetched for Admin",
      order: orders,
      adminStaffList,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getOrdersForAdmin error", err);
    res.status(500).json({ message: "Error in fetching Orders for admin" });
  }
};

// GET /api/order/stats  (admin) — summary metrics for the Order Management header cards.
// Computed via aggregation over every order, not derived from getOrdersForAdmin's paginated
// (and hard-capped at 100) list — the metrics cards previously reduced over whatever page
// of orders happened to be loaded, which silently undercounts the moment there are more
// orders than the page size. Same ORDER_VIEW gate as /order/all, so anyone who can see the
// order table can see accurate totals for it.
export const getOrderStats = async (req: Request, res: Response) => {
  try {
    const { status, source, placedBy, invoicePrinted, startDate, endDate } = req.query as Record<string, string | undefined>;
    const match: Record<string, any> = {};

    if (status) {
      match.orderStatus = status.toUpperCase();
    }

    if (placedBy && placedBy.trim()) {
      if (mongoose.Types.ObjectId.isValid(placedBy.trim())) {
        match.placedByAdminId = new mongoose.Types.ObjectId(placedBy.trim());
      }
    } else if (source === "ADMIN" || source === "STAFF") {
      match.placedByAdminId = { $ne: null };
    } else if (source === "CUSTOMER") {
      match.placedByAdminId = null;
    }

    if (invoicePrinted === "true") {
      match.invoicePrinted = true;
    } else if (invoicePrinted === "false") {
      match.invoicePrinted = { $ne: true };
      if (!status) {
        match.orderStatus = { $ne: "CANCELLED" };
      }
    }

    const dateMatch: Record<string, any> = {};
    if (startDate && startDate.trim()) {
      const start = new Date(startDate.trim());
      if (!isNaN(start.getTime())) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(startDate.trim())) {
          start.setUTCHours(0, 0, 0, 0);
        }
        dateMatch.$gte = start;
      }
    }
    if (endDate && endDate.trim()) {
      const end = new Date(endDate.trim());
      if (!isNaN(end.getTime())) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())) {
          end.setUTCHours(23, 59, 59, 999);
        }
        dateMatch.$lte = end;
      }
    }

    if (Object.keys(dateMatch).length > 0) {
      match.createdAt = dateMatch;
    }

    const pipeline: any[] = [];
    if (Object.keys(match).length > 0) {
      pipeline.push({ $match: match });
    }

    pipeline.push({
      $facet: {
        totalCount: [{ $count: "n" }],
        byStatus: [{ $group: { _id: "$orderStatus", count: { $sum: 1 } } }],
        // "Gross income" is realized revenue — only orders actually paid for and active (not cancelled/returned)
        paidRevenue: [
          { $match: { paymentStatus: "PAID", orderStatus: { $nin: ["CANCELLED", "RETURNED"] } } },
          { $group: { _id: null, sum: { $sum: "$finalAmount" } } },
        ],
        totalOrderValue: [
          { $match: { orderStatus: { $nin: ["CANCELLED", "RETURNED"] } } },
          { $group: { _id: null, sum: { $sum: "$finalAmount" } } },
        ],
      },
    });

    const unprintedMatch: Record<string, any> = {
      invoicePrinted: { $ne: true },
      orderStatus: { $ne: "CANCELLED" },
    };
    if (placedBy && placedBy.trim()) {
      if (mongoose.Types.ObjectId.isValid(placedBy.trim())) {
        unprintedMatch.placedByAdminId = new mongoose.Types.ObjectId(placedBy.trim());
      }
    } else if (source === "ADMIN" || source === "STAFF") {
      unprintedMatch.placedByAdminId = { $ne: null };
    } else if (source === "CUSTOMER") {
      unprintedMatch.placedByAdminId = null;
    }

    if (Object.keys(dateMatch).length > 0) {
      unprintedMatch.createdAt = dateMatch;
    }

    const [facetResult, unprintedCount] = await Promise.all([
      Order.aggregate(pipeline),
      Order.countDocuments(unprintedMatch),
    ]);

    const facet = facetResult[0];
    const byStatus = new Map((facet?.byStatus ?? []).map((r: any) => [r._id as string, r.count as number]));

    res.status(200).json({
      totalOrders: facet?.totalCount?.[0]?.n ?? 0,
      paidRevenue: facet?.paidRevenue?.[0]?.sum ?? 0,
      totalOrderValue: facet?.totalOrderValue?.[0]?.sum ?? 0,
      processing: byStatus.get("PROCESSING") ?? 0,
      confirmed: byStatus.get("CONFIRMED") ?? 0,
      shipped: byStatus.get("SHIPPED") ?? 0,
      delivered: byStatus.get("DELIVERED") ?? 0,
      cancelled: byStatus.get("CANCELLED") ?? 0,
      returned: byStatus.get("RETURNED") ?? 0,
      unprintedInvoices: unprintedCount,
    });
  } catch (err: any) {
    logger.error("getOrderStats error", err);
    res.status(500).json({ message: "Error fetching order stats" });
  }
};

// PUT /api/orders/update-status/:id  (admin)
export const updateStatus = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const {
      orderStatus,
      deliveryPartnerId,
      newDeliveryPartnerName,
      noDeliveryPartner,
      trackingId,
      trackingLink,
      shippingNote,
      refundPayment,
      refundNote,
    } = req.body as {
      orderStatus: OrderStatus;
      deliveryPartnerId?: string;
      newDeliveryPartnerName?: string;
      noDeliveryPartner?: boolean;
      trackingId?: string;
      trackingLink?: string;
      shippingNote?: string;
      refundPayment?: boolean;
      refundNote?: string;
    };
    const adminId = req.user!.id;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    // DELIVERED, CANCELLED, and RETURNED are terminal states —
    // mirrors the frontend's chip-disabling in AdminOrderManagement.tsx, enforced here
    // too since this endpoint is reachable directly, not just through that UI.
    if (order.orderStatus === "DELIVERED" || order.orderStatus === "CANCELLED" || order.orderStatus === "RETURNED") {
      return res.status(400).json({ message: `Order #${id.slice(-6)} is already ${order.orderStatus.toLowerCase()} — no further status change is allowed.` });
    }
    if (orderStatus === "DELIVERED" && order.orderStatus !== "SHIPPED") {
      return res.status(400).json({ message: "An order must be marked SHIPPED before it can be marked DELIVERED." });
    }

    // Resolving the courier before the order update means a bad delivery-partner
    // reference never gets past this point — validate.middleware already guarantees
    // one of {deliveryPartnerId, newDeliveryPartnerName} or noDeliveryPartner is present
    // when orderStatus is SHIPPED.
    let shippingData: Record<string, unknown> = {};
    let shippingInfo: { partnerName?: string; trackingId?: string; trackingLink?: string; note?: string } | undefined;
    if (orderStatus === "SHIPPED" && noDeliveryPartner) {
      // Manual/self-delivery — no courier, no tracking ID; just an optional free-text note.
      shippingData = {
        shippingNote: shippingNote || undefined,
        shippedAt: new Date(),
      };
      if (shippingNote) shippingInfo = { note: shippingNote };
    } else if (orderStatus === "SHIPPED") {
      let partner;
      if (newDeliveryPartnerName) {
        partner = await prisma.deliveryPartner.findFirst({ where: { name: newDeliveryPartnerName.trim() } });
        if (!partner) {
          try {
            partner = await prisma.deliveryPartner.create({
              data: { name: newDeliveryPartnerName.trim() },
            });
          } catch (err: any) {
            if (err?.code !== 11000) throw err;
            partner = await prisma.deliveryPartner.findFirst({ where: { name: newDeliveryPartnerName.trim() } });
          }
        }
      } else if (deliveryPartnerId) {
        partner = await prisma.deliveryPartner.findUnique({ where: { id: deliveryPartnerId } });
      }
      if (!partner) {
        return res.status(400).json({ message: "Delivery partner not found" });
      }

      shippingData = {
        deliveryPartnerId: partner.id,
        deliveryPartnerName: partner.name,
        trackingId,
        trackingLink: trackingLink || undefined,
        shippedAt: new Date(),
      };
      shippingInfo = { partnerName: partner.name, trackingId: trackingId!, trackingLink: trackingLink || undefined };
    }

    // Compare-and-swap: only the call that actually transitions the order into
    // CANCELLED or RETURNED enqueues the stock restore — closes the same double-submit race as
    // cancelOrder() above (an admin double-clicking "cancel"/"return", or two open tabs).
    let updated;
    if (orderStatus === "CANCELLED" || orderStatus === "RETURNED") {
      const cancelExtra: Record<string, unknown> = {};
      const shouldRefund = orderStatus === "CANCELLED" && refundPayment === true && order.paymentStatus === "PAID";
      if (shouldRefund) {
        cancelExtra.paymentStatus = "REFUNDED";
      }

      updated = await prisma.order.update({
        where: { id, orderStatus: { notIn: ["CANCELLED", "RETURNED"] } },
        data: { orderStatus, ...cancelExtra },
      });
      if (!updated) {
        return res.status(400).json({ message: `This order was already ${orderStatus.toLowerCase()}.` });
      }
      await restoreStock({
        orderId: id,
        items: order.items.map((item: any) => ({ productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity })),
      });

      await prisma.paymentLog.create({
        data: {
          orderId: id,
          userId: order.userId,
          event: orderStatus === "RETURNED" ? "ORDER_RETURNED" : "ORDER_CANCELLED",
          paymentMethod: order.paymentMethod,
          paymentStatus: shouldRefund ? "REFUNDED" : order.paymentStatus,
          amount: order.finalAmount,
          gatewayResponse: {
            [orderStatus === "RETURNED" ? "returnedBy" : "cancelledBy"]: adminId,
            self: false,
            refundedOnCancellation: shouldRefund,
            reason: orderStatus === "RETURNED" ? "Courier returned to origin before delivery" : undefined,
          },
          signatureValid: null,
          ipAddress: req.ip ?? null,
        },
      });

      if (shouldRefund) {
        await prisma.paymentLog.create({
          data: {
            orderId: id,
            userId: order.userId,
            event: "REFUND_RECORDED",
            paymentMethod: order.paymentMethod,
            paymentStatus: "REFUNDED",
            amount: order.finalAmount,
            notes: refundNote?.trim() || "Refund recorded during order cancellation",
            gatewayResponse: { recordedBy: adminId, onCancellation: true },
            signatureValid: null,
            ipAddress: req.ip ?? null,
          },
        });
        await createAuditLog({
          req,
          action: "RECORD_REFUND",
          entity: "Order",
          entityId: id,
          details: { amount: order.finalAmount, note: refundNote?.trim() || "Recorded during cancellation" },
        });
      }
    } else {
      const isDeliveredPending = orderStatus === "DELIVERED" && order.paymentStatus === "PENDING";
      const extraData: Record<string, unknown> = {};
      if (isDeliveredPending) {
        extraData.paymentStatus = "PAID";
      }

      updated = await prisma.order.update({
        where: { id },
        data: { orderStatus, ...shippingData, ...extraData },
      });

      if (isDeliveredPending) {
        await prisma.paymentLog.create({
          data: {
            orderId: id,
            userId: order.userId,
            event: "PAYMENT_COLLECTED_ON_DELIVERY",
            paymentMethod: order.paymentMethod,
            paymentStatus: "PAID",
            amount: order.finalAmount,
            gatewayResponse: {
              collectedBy: adminId,
              note: "Cash on delivery payment collected upon order delivery",
            },
            signatureValid: null,
            ipAddress: req.ip ?? null,
          },
        });
      }
    }

    const admin = await prisma.user.findUnique({
      where: { id: adminId },
      select: { username: true },
    });
    const shortId = id.slice(-6);

    const adminIds = await getAdminRecipients();
    await notifyUsers(req, id, `Admin ${admin!.username} updated Order #${shortId} to ${orderStatus}`, "ORDER_UPDATE", adminId, adminIds);
    await notifyUsers(req, id, `Your order #${shortId} status has been updated to: ${orderStatus}`, "ORDER_UPDATE", adminId, [order.userId]);

    // Send order-status email to customer
    try {
      const customer = await prisma.user.findUnique({
        where: { id: order.userId },
        select: { email: true, username: true },
      });
      if (customer?.email) {
        await sendEmail({
          to: customer.email,
          toName: customer.username,
          ...orderStatusEmailPayload(shortId, orderStatus, customer.username, shippingInfo),
        });
        logger.info(`Order status email sent for ${customer.email} for order ${shortId}`);
      }
    } catch (emailErr) {
      logger.error("Order status email failed", emailErr);
    }

    await createAuditLog({
      req,
      action: "UPDATE_ORDER_STATUS",
      entity: "Order",
      entityId: id,
      details: { from: order.orderStatus, to: orderStatus, shortId },
    });

    res
      .status(200)
      .json({
        message: `Order status updated to ${orderStatus} Successfully`,
        order: updated,
      });
  } catch (err: any) {
    logger.error("updateStatus error", err);
    res.status(500).json({ message: "Error in Updating order status" });
  }
};

// PUT /api/orders/bulk-update-status (admin or staff with ORDER_UPDATE permission)
export const bulkUpdateStatus = async (req: Request, res: Response) => {
  try {
    const { orderIds, orderStatus } = req.body as {
      orderIds: string[];
      orderStatus: OrderStatus;
    };
    const adminId = req.user!.id;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ message: "No orders selected for update" });
    }

    const validStatuses: OrderStatus[] = ["PROCESSING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"];
    if (!orderStatus || !validStatuses.includes(orderStatus)) {
      return res.status(400).json({ message: "Invalid order status provided" });
    }

    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      include: { items: true },
    });

    if (!orders || orders.length === 0) {
      return res.status(404).json({ message: "No matching orders found" });
    }

    let successCount = 0;
    let alreadyInStatusCount = 0;
    let skippedCancelledCount = 0;
    let skippedDeliveredCount = 0;
    const errors: string[] = [];

    const admin = await prisma.user.findUnique({
      where: { id: adminId },
      select: { username: true },
    });
    const adminName = admin?.username || "Admin";

    for (const order of orders) {
      try {
        if (order.orderStatus === orderStatus) {
          alreadyInStatusCount++;
          continue;
        }

        // Strictly disallow changing CANCELLED or RETURNED orders
        if (order.orderStatus === "CANCELLED" || order.orderStatus === "RETURNED") {
          skippedCancelledCount++;
          errors.push(`Order #${order.id.slice(-6)} is cancelled and cannot be changed`);
          continue;
        }

        // Strictly disallow changing already DELIVERED orders
        if (order.orderStatus === "DELIVERED") {
          skippedDeliveredCount++;
          errors.push(`Order #${order.id.slice(-6)} is already delivered and cannot be changed`);
          continue;
        }

        if (orderStatus === "CANCELLED") {
          await prisma.order.update({
            where: { id: order.id },
            data: { orderStatus: "CANCELLED" },
          });

          await restoreStock({
            orderId: order.id,
            items: order.items.map((item: any) => ({
              productId: item.productId,
              variantId: item.variantId ?? null,
              quantity: item.quantity,
            })),
          });

          await prisma.paymentLog.create({
            data: {
              orderId: order.id,
              userId: order.userId,
              event: "ORDER_CANCELLED",
              paymentMethod: order.paymentMethod,
              paymentStatus: order.paymentStatus,
              amount: order.finalAmount,
              gatewayResponse: { cancelledBy: adminId, bulkUpdate: true },
              signatureValid: null,
              ipAddress: req.ip ?? null,
            },
          });
        } else if (orderStatus === "SHIPPED") {
          // Fast bulk shipping: no courier URL/tracking link required
          await prisma.order.update({
            where: { id: order.id },
            data: {
              orderStatus: "SHIPPED",
              shippedAt: new Date(),
              noDeliveryPartner: true,
            },
          });
        } else if (orderStatus === "DELIVERED") {
          const isPending = order.paymentStatus === "PENDING";
          await prisma.order.update({
            where: { id: order.id },
            data: {
              orderStatus: "DELIVERED",
              deliveredAt: new Date(),
              paymentStatus: isPending ? "PAID" : order.paymentStatus,
            },
          });

          if (isPending) {
            await prisma.paymentLog.create({
              data: {
                orderId: order.id,
                userId: order.userId,
                event: "PAYMENT_COLLECTED_ON_DELIVERY",
                paymentMethod: order.paymentMethod,
                paymentStatus: "PAID",
                amount: order.finalAmount,
                gatewayResponse: { collectedBy: adminId, bulkUpdate: true },
                signatureValid: null,
                ipAddress: req.ip ?? null,
              },
            });
          }
        } else {
          // PROCESSING / CONFIRMED
          await prisma.order.update({
            where: { id: order.id },
            data: { orderStatus },
          });
        }

        const shortId = order.id.slice(-6);
        void (async () => {
          try {
            await notifyUsers(req, order.id, `Your order #${shortId} status has been updated to: ${orderStatus}`, "ORDER_UPDATE", adminId, [order.userId]);
            
            const user = await prisma.user.findUnique({
              where: { id: order.userId },
              select: { email: true, username: true },
            });
            if (user?.email) {
              await sendEmail({
                to: user.email,
                toName: user.username,
                ...orderStatusEmailPayload(shortId, orderStatus, user.username),
              });
            }
          } catch (bgErr) {
            logger.warn(`Bulk status update notification error for order ${order.id}:`, bgErr);
          }
        })();

        successCount++;
      } catch (orderErr: any) {
        logger.error(`Error updating order ${order.id} in bulk:`, orderErr);
        errors.push(`Order #${order.id.slice(-6)} failed to update`);
      }
    }

    if (successCount > 0) {
      await createAuditLog({
        req,
        action: "UPDATE_ORDER_STATUS_BULK",
        entity: "Order",
        details: { targetStatus: orderStatus, requestedCount: orderIds.length, successCount },
      });

      const adminIds = await getAdminRecipients();
      await notifyUsers(req, "", `Admin ${adminName} bulk-updated ${successCount} order(s) to ${orderStatus}`, "ORDER_UPDATE", adminId, adminIds);
    }

    if (successCount === 0) {
      if (alreadyInStatusCount === orders.length) {
        return res.status(200).json({
          message: `Selected order(s) are already ${orderStatus}`,
          successCount: 0,
        });
      }
      if (skippedCancelledCount > 0) {
        return res.status(400).json({
          message: "Cancelled orders cannot have their status changed.",
          successCount: 0,
          errors,
        });
      }
      if (skippedDeliveredCount > 0) {
        return res.status(400).json({
          message: "Delivered orders cannot have their status changed.",
          successCount: 0,
          errors,
        });
      }
      return res.status(400).json({
        message: errors[0] || "No orders could be updated.",
        successCount: 0,
        errors,
      });
    }

    const skippedNote = skippedCancelledCount > 0
      ? ` (${skippedCancelledCount} cancelled order(s) skipped)`
      : "";

    res.status(200).json({
      message: `Successfully updated ${successCount} order(s) to ${orderStatus}${skippedNote}`,
      successCount,
      alreadyInStatusCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    logger.error("bulkUpdateStatus error", err);
    res.status(500).json({ message: "Failed to update order statuses in bulk", error: err.message });
  }
};

// GET /api/orders/my-transactions?page=1&limit=10  (authenticated customer)
export const getMyTransactions = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { page = "1", limit = "10" } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "10") || 10, 1), 50);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;

    const [transactions, total] = await Promise.all([
      prisma.order.findMany({
        where: { userId },
        select: {
          id: true,
          createdAt: true,
          paymentMethod: true,
          paymentStatus: true,
          orderStatus: true,
          totalAmount: true,
          shippingCharge: true,
          discountAmount: true,
          finalAmount: true,
          razorpayPaymentId: true,
          razorpayOrderId: true,
          coupon: { select: { code: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, image: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.order.count({ where: { userId } }),
    ]);

    res.status(200).json({
      transactions,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getMyTransactions error", err);
    res.status(500).json({ message: "Error fetching transaction history" });
  }
};

// GET /api/orders/customer-transactions?page=1&limit=20&search=&paymentStatus=&paymentMethod=  (admin/staff)
export const getCustomerTransactions = async (req: Request, res: Response) => {
  try {
    const {
      page = "1",
      limit = "20",
      search,
      paymentStatus,
      paymentMethod,
    } = req.query as Record<string, string | undefined>;

    const pageSize = Math.min(Math.max(parseInt(limit ?? "20") || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;

    const where: any = {};
    if (paymentStatus) where.paymentStatus = paymentStatus.toUpperCase();
    if (paymentMethod) where.paymentMethod = paymentMethod.toUpperCase();
    if (search) {
      where.user = {
        OR: [
          { username: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
        ],
      };
    }

    const [rawTransactions, total] = await Promise.all([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          userId: true,
          createdAt: true,
          paymentMethod: true,
          paymentStatus: true,
          orderStatus: true,
          totalAmount: true,
          shippingCharge: true,
          discountAmount: true,
          finalAmount: true,
          razorpayPaymentId: true,
          razorpayOrderId: true,
          coupon: { select: { code: true } },
          user: { select: { id: true, username: true, email: true, phone: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, image: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ]);

    // Prisma MongoDB relations can return null when the referenced user document
    // has a schema mismatch or a data validation issue. Fall back to a direct
    // Mongoose lookup for any order whose Prisma user relation resolved to null.
    const missingUserIds = rawTransactions
      .filter((tx: typeof rawTransactions[0]) => !tx.user)
      .map((tx: typeof rawTransactions[0]) => tx.userId);

    const fallbackMap: Record<string, { id: string; username: string; email: string | null; phone: string | null }> = {};
    if (missingUserIds.length > 0) {
      const mongooseUsers = await User.find({ _id: { $in: missingUserIds } })
        .select("_id username email phone")
        .lean();
      for (const mu of mongooseUsers as any[]) {
        fallbackMap[mu._id.toString()] = {
          id: mu._id.toString(),
          username: mu.username,
          email: mu.email ?? null,
          phone: mu.phone ?? null,
        };
      }
    }

    const transactions = rawTransactions.map((tx: typeof rawTransactions[0]) => ({
      ...tx,
      user: tx.user ?? fallbackMap[tx.userId] ?? null,
    }));

    res.status(200).json({
      transactions,
      pagination: {
        total,
        page: Math.max(parseInt(page ?? "1") || 1, 1),
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err: any) {
    logger.error("getCustomerTransactions error", err);
    res.status(500).json({ message: "Error fetching customer transactions" });
  }
};

// GET /api/orders/:id  — customer (own order) or admin/staff (any order)
export const getOrderById = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const requestingUser = req.user!;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, username: true, email: true, phone: true } },
        placedByAdmin: { select: { id: true, username: true, email: true, role: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, image: true, price: true, discount: true, code: true } },
            // See getOrders's identical include — which option was purchased.
            variant: true,
          },
        },
        coupon: { select: { code: true, discountType: true, discountValue: true } },
      },
    });

    if (order && (order as any).placedByAdminId && !(order as any).placedByAdmin) {
      const adminDoc = await User.findById((order as any).placedByAdminId).select("_id username email role").lean();
      if (adminDoc) {
        (order as any).placedByAdmin = {
          id: adminDoc._id.toString(),
          username: adminDoc.username,
          email: adminDoc.email ?? null,
          role: adminDoc.role ?? "ADMIN",
        };
      }
    }

    if (!order) return res.status(404).json({ message: "Order not found" });

    // Customers may only fetch their own orders
    if (
      requestingUser.role !== Role.ADMIN &&
      requestingUser.role !== Role.SUPER_ADMIN &&
      requestingUser.role !== Role.STAFF &&
      order.userId !== requestingUser.id
    ) {
      return res.status(403).json({ message: "Not authorised" });
    }

    res.status(200).json({ order });
  } catch (err: any) {
    logger.error("getOrderById error", err);
    res.status(500).json({ message: "Error fetching order" });
  }
};

// GET /api/orders/bulk-invoices  (admin/staff)
export const getBulkInvoices = async (req: Request, res: Response) => {
  try {
    const { orderIds, unprintedOnly, limit = "100" } = req.query as Record<string, string | undefined>;
    const where: any = {};

    if (orderIds && orderIds.trim()) {
      const ids = orderIds.split(",").map((s) => s.trim()).filter(Boolean);
      where.id = { in: ids };
    } else if (unprintedOnly === "true") {
      where.invoicePrinted = { not: true };
      where.orderStatus = { not: "CANCELLED" };
    }

    const maxLimit = Math.min(Math.max(parseInt(limit ?? "100") || 100, 1), 200);

    const orders = await prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, username: true, email: true, phone: true } },
        placedByAdmin: { select: { id: true, username: true, email: true, role: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, image: true, price: true, discount: true, code: true } },
            variant: true,
          },
        },
        coupon: { select: { code: true, discountType: true, discountValue: true } },
      },
      orderBy: { createdAt: "asc" }, // chronological order for batch packing/fulfillment
      take: maxLimit,
    });

    res.status(200).json({ orders });
  } catch (err: any) {
    logger.error("getBulkInvoices error", err);
    res.status(500).json({ message: "Error fetching bulk invoices" });
  }
};

// POST /api/orders/mark-invoices-printed  (admin/staff)
export const markInvoicesPrinted = async (req: Request, res: Response) => {
  try {
    const { orderIds, printed = true } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ message: "orderIds array is required" });
    }

    const updateData = printed
      ? { invoicePrinted: true, invoicePrintedAt: new Date() }
      : { invoicePrinted: false, invoicePrintedAt: null };

    const result = await Order.updateMany(
      { _id: { $in: orderIds } },
      { $set: updateData }
    );

    res.status(200).json({
      message: `Successfully marked ${result.modifiedCount} order(s) as ${printed ? "printed" : "unprinted"}`,
      modifiedCount: result.modifiedCount,
    });
  } catch (err: any) {
    logger.error("markInvoicesPrinted error", err);
    res.status(500).json({ message: "Error updating invoice print status" });
  }
};

// ─── Admin Place Order on Behalf of Customer ──────────────────────────────────

// Helper: Get recent order delivery address or saved address for a customer
const getCustomerRecentAddress = async (userId: string | mongoose.Types.ObjectId) => {
  try {
    const lastOrder = await Order.findOne({ userId })
      .sort({ createdAt: -1 })
      .select("shippingAddress")
      .lean();

    if (lastOrder?.shippingAddress && (lastOrder.shippingAddress.fullAddress || lastOrder.shippingAddress.address)) {
      const sa = lastOrder.shippingAddress;
      return {
        fullAddress: sa.fullAddress || sa.address || sa.street || "",
        city: sa.city || "",
        state: sa.state || "",
        zipCode: sa.zipCode || sa.pincode || sa.pinCode || "",
        country: sa.country || "India",
      };
    }

    const savedAddr = await Address.findOne({ userId })
      .sort({ isDefault: -1, createdAt: -1 })
      .lean();

    if (savedAddr && savedAddr.fullAddress) {
      return {
        fullAddress: savedAddr.fullAddress || "",
        city: savedAddr.city || "",
        state: savedAddr.state || "",
        zipCode: savedAddr.zipCode || "",
        country: savedAddr.country || "India",
      };
    }
  } catch (err) {
    logger.warn("getCustomerRecentAddress error", err);
  }
  return null;
};

// GET /api/orders/admin-order/search-customers?q=   (admin / super-admin)
// Search existing customers by name, phone, or email.
export const searchCustomersForOrder = async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    if (!q) return res.json({ customers: [] });

    const customers = await User.find({
      role: "CUSTOMER",
      $or: [
        { username: { $regex: q, $options: "i" } },
        { email:    { $regex: q, $options: "i" } },
        { phone:    { $regex: q, $options: "i" } },
      ],
    })
      .select("id username email phone")
      .limit(10)
      .lean();

    const customersWithAddress = await Promise.all(
      customers.map(async (c: any) => {
        const customerId = c._id ? String(c._id) : String(c.id);
        const recentAddress = await getCustomerRecentAddress(customerId);
        return {
          id: customerId,
          username: c.username,
          email: c.email ?? null,
          phone: c.phone ?? null,
          recentAddress,
        };
      })
    );

    res.json({ customers: customersWithAddress });
  } catch (err: any) {
    logger.error("searchCustomersForOrder error", err);
    res.status(500).json({ message: "Search failed" });
  }
};

// GET /api/orders/admin-order/check-customer?phone=&email=  (admin / super-admin)
// Check if a customer already exists with the given phone number or email.
export const checkCustomerExists = async (req: Request, res: Response) => {
  try {
    const phone = (req.query.phone as string | undefined)?.trim();
    const email = (req.query.email as string | undefined)?.trim().toLowerCase();

    if (!phone && !email) {
      return res.json({ exists: false, customer: null });
    }

    const conditions: any[] = [];
    if (phone) conditions.push({ phone });
    if (email) conditions.push({ email });

    const customer = await User.findOne({
      role: "CUSTOMER",
      $or: conditions,
    })
      .select("id username email phone")
      .lean();

    if (customer) {
      const customerId = customer._id ? String(customer._id) : String(customer.id);
      const recentAddress = await getCustomerRecentAddress(customerId);
      const matchType = phone && customer.phone === phone ? "phone" : "email";
      return res.json({
        exists: true,
        matchType,
        customer: {
          id: customerId,
          username: customer.username,
          email: customer.email ?? null,
          phone: customer.phone ?? null,
          recentAddress,
        },
      });
    }

    return res.json({ exists: false, customer: null });
  } catch (err: any) {
    logger.error("checkCustomerExists error", err);
    res.status(500).json({ message: "Customer check failed" });
  }
};

// GET /api/orders/admin-order/check-recent-order?customerId=&phone=&email=  (admin / super-admin)
// Checks if a customer has placed an order in the last 24 hours.
export const checkRecentOrderForCustomer = async (req: Request, res: Response) => {
  try {
    const customerId = (req.query.customerId as string | undefined)?.trim();
    const phone = (req.query.phone as string | undefined)?.trim();
    const email = (req.query.email as string | undefined)?.trim().toLowerCase();

    let targetUserId: string | null = null;
    let customerName: string = "";

    if (customerId) {
      const user = await User.findById(customerId).select("id username").lean();
      if (user) {
        targetUserId = String((user as any)._id || (user as any).id);
        customerName = (user as any).username;
      }
    } else if (phone || email) {
      const conditions: any[] = [];
      if (phone) conditions.push({ phone });
      if (email) conditions.push({ email });

      const user = await User.findOne({
        role: "CUSTOMER",
        $or: conditions,
      }).select("id username").lean();

      if (user) {
        targetUserId = String((user as any)._id || (user as any).id);
        customerName = (user as any).username;
      }
    }

    if (!targetUserId) {
      return res.json({ hasRecentOrder: false, order: null });
    }

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const userObjectId = mongoose.Types.ObjectId.isValid(targetUserId)
      ? new mongoose.Types.ObjectId(targetUserId)
      : targetUserId;

    const recentOrder = await Order.findOne({
      userId: { $in: [userObjectId, String(targetUserId)] },
      createdAt: { $gte: twentyFourHoursAgo },
      orderStatus: { $ne: "CANCELLED" },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!recentOrder) {
      return res.json({ hasRecentOrder: false, order: null });
    }

    const recentOrderId = String((recentOrder as any)._id || (recentOrder as any).id);

    const recentItems = await OrderItem.find({ orderId: (recentOrder as any)._id })
      .populate<{ productId: { name: string } }>("productId", "name")
      .lean();

    const itemsSummary = recentItems
      .map((i: any) => `${i.productId?.name || "Item"} (x${i.quantity})`)
      .join(", ") || `${recentItems.length || 1} item(s)`;

    const orderDate = new Date(recentOrder.createdAt);
    const formattedTime = orderDate.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const diffMs = Math.max(0, Date.now() - orderDate.getTime());
    const diffMins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    let relativeTime = "Just now";
    if (hours > 0) {
      relativeTime = `${hours} hr${hours > 1 ? "s" : ""}${mins > 0 ? ` ${mins} min${mins > 1 ? "s" : ""}` : ""} ago`;
    } else if (diffMins > 0) {
      relativeTime = `${diffMins} min${diffMins > 1 ? "s" : ""} ago`;
    }

    return res.json({
      hasRecentOrder: true,
      order: {
        id: recentOrderId,
        shortId: recentOrderId.slice(-6).toUpperCase(),
        createdAt: recentOrder.createdAt,
        formattedTime,
        relativeTime,
        finalAmount: recentOrder.finalAmount,
        totalAmount: recentOrder.totalAmount,
        orderStatus: recentOrder.orderStatus,
        paymentMethod: recentOrder.paymentMethod,
        placedByAdmin: !!(recentOrder as any).placedByAdminId,
        itemsCount: recentItems.length,
        itemsSummary,
        customerName: customerName || ((recentOrder as any).shippingAddress?.fullName || "Customer"),
      },
    });
  } catch (err: any) {
    logger.error("checkRecentOrderForCustomer error", err);
    res.status(500).json({ message: "Failed to check recent order" });
  }
};

// GET /api/orders/admin-order/products?search=&page=1  (admin / super-admin)
// Returns active products with stock info for product picker.
export const getProductsForAdminOrder = async (req: Request, res: Response) => {
  try {
    const { search = "", page = "1", limit = "20" } = req.query as Record<string, string | undefined>;
    const pageSize = Math.min(Math.max(parseInt(limit ?? "20") || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? "1") || 1, 1) - 1) * pageSize;
    const where = {
      isActive: true,
      stock: { gt: 0 },
      ...(search ? { name: { contains: search as string, mode: "insensitive" as const } } : {}),
    };
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        select: {
          id: true, name: true, code: true, image: true, description: true, price: true, stock: true,
          category: { select: { id: true, name: true } },
        },
        orderBy: { name: "asc" },
        skip,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    // A product with active variants can't actually be sold as its bare self — an
    // admin picking it at the counter needs the same Storage/Color choice a customer
    // would make on the storefront (see cart.controller.ts's cartAdd, which already
    // rejects a variant-less add for these). Attach each product's active variants so
    // the picker can require one, same contract as the rest of the app.
    const productIds = products.map((p: any) => p.id);
    const variants = productIds.length
      ? await prisma.productVariant.findMany({
          where: { productId: { in: productIds }, isActive: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const variantsByProduct = new Map<string, any[]>();
    for (const v of variants) {
      const key = String(v.productId);
      const bucket = variantsByProduct.get(key);
      if (bucket) bucket.push(v);
      else variantsByProduct.set(key, [v]);
    }
    const productsWithVariants = products.map((p: any) => ({
      ...p,
      variants: variantsByProduct.get(p.id) ?? [],
    }));

    res.json({ products: productsWithVariants, pagination: { total, page: Math.max(parseInt(page ?? "1") || 1, 1), limit: pageSize, totalPages: Math.ceil(total / pageSize) } });
  } catch (err: any) {
    logger.error("getProductsForAdminOrder error", err);
    res.status(500).json({ message: "Failed to fetch products" });
  }
};

// POST /api/orders/admin-order/place   (admin / super-admin)
// Body: {
//   customerId?:   string,          // existing CUSTOMER id
//   newCustomer?:  { username, phone, email? }, // create new if no customerId
//   items:         [{ productId, quantity }],
//   address:       { fullAddress, city, state, zipCode, country },
//   paymentMethod: "CASH" | "POD",
//   paymentNote?:  string,           // e.g. UPI ref, receipt no, etc.
// }
export const placeAdminOrder = async (req: Request, res: Response) => {
  try {
    const adminId = req.user!.id;
    const {
      customerId,
      newCustomer,
      items,
      address,
      paymentMethod = "CASH",
      paymentNote,
      couponId,
      bypassRecentOrderWarning,
    } = req.body as {
      customerId?: string;
      newCustomer?: { username: string; phone: string; email?: string };
      items: Array<{ productId: string; variantId?: string | null; quantity: number }>;
      address?: { fullAddress?: string; city?: string; state?: string; zipCode?: string; country?: string };
      paymentMethod: "CASH" | "POD";
      paymentNote?: string;
      couponId?: string;
      bypassRecentOrderWarning?: boolean;
    };

    // ── 1. Resolve customer ──────────────────────────────────────────────────
    let customer: { id: string; username: string; email: string | null };

    if (customerId) {
      const existing = await prisma.user.findUnique({
        where: { id: customerId },
        select: { id: true, username: true, email: true, phone: true, role: true },
      });
      if (!existing || existing.role !== "CUSTOMER") {
        return res.status(404).json({ message: "Customer not found" });
      }
      customer = existing;
    } else if (newCustomer) {
      if (!newCustomer.username?.trim() || !newCustomer.phone?.trim()) {
        return res.status(400).json({ message: "Name and phone are required for a new customer" });
      }
      const cleanPhone = newCustomer.phone.trim();
      const cleanEmail = newCustomer.email?.trim().toLowerCase() || null;

      // Check if phone or email already exists
      let existingUser = await prisma.user.findFirst({
        where: { phone: cleanPhone },
        select: { id: true, username: true, email: true, phone: true, role: true },
      });

      if (!existingUser && cleanEmail) {
        existingUser = await prisma.user.findFirst({
          where: { email: cleanEmail },
          select: { id: true, username: true, email: true, phone: true, role: true },
        });
      }

      if (existingUser) {
        const isPhoneMatch = existingUser.phone === cleanPhone;
        return res.status(409).json({
          code: "CUSTOMER_ALREADY_EXISTS",
          message: isPhoneMatch
            ? "A customer with this phone number already exists."
            : "A customer with this email address already exists.",
          conflictField: isPhoneMatch ? "phone" : "email",
          existingCustomer: {
            id: existingUser.id,
            username: existingUser.username,
            phone: existingUser.phone,
            email: existingUser.email,
          },
        });
      }

      let created;
      try {
        created = await prisma.user.create({
          data: {
            username: newCustomer.username.trim(),
            phone: cleanPhone,
            email: cleanEmail,
            role: "CUSTOMER",
            isVerified: true,
          },
          select: { id: true, username: true, email: true, phone: true },
        });
      } catch (createErr: any) {
        if (createErr.code === 11000 || createErr.message?.includes("duplicate")) {
          const fallbackUser = await prisma.user.findFirst({
            where: {
              OR: [
                { phone: cleanPhone },
                ...(cleanEmail ? [{ email: cleanEmail }] : []),
              ],
            },
            select: { id: true, username: true, email: true, phone: true },
          });
          if (fallbackUser) {
            return res.status(409).json({
              code: "CUSTOMER_ALREADY_EXISTS",
              message: "A customer with these details already exists.",
              conflictField: "phone",
              existingCustomer: {
                id: fallbackUser.id,
                username: fallbackUser.username,
                phone: fallbackUser.phone,
                email: fallbackUser.email,
              },
            });
          }
        }
        throw createErr;
      }
      customer = created;
    } else {
      return res.status(400).json({ message: "Provide either customerId or newCustomer details" });
    }

    // ── 1b. Check if customer already placed an order in the last 24 hours ────
    if (!bypassRecentOrderWarning) {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const userObjectId = mongoose.Types.ObjectId.isValid(customer.id)
        ? new mongoose.Types.ObjectId(customer.id)
        : customer.id;

      const recentOrder = await Order.findOne({
        userId: { $in: [userObjectId, String(customer.id)] },
        createdAt: { $gte: twentyFourHoursAgo },
        orderStatus: { $ne: "CANCELLED" },
      })
        .sort({ createdAt: -1 })
        .lean();

      if (recentOrder) {
        const recentOrderId = String((recentOrder as any)._id || (recentOrder as any).id);
        const recentItems = await OrderItem.find({ orderId: (recentOrder as any)._id })
          .populate<{ productId: { name: string } }>("productId", "name")
          .lean();

        const itemsSummary = recentItems
          .map((i: any) => `${i.productId?.name || "Item"} (x${i.quantity})`)
          .join(", ") || `${recentItems.length || 1} item(s)`;

        const orderDate = new Date(recentOrder.createdAt);
        const formattedTime = orderDate.toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });

        const diffMs = Math.max(0, Date.now() - orderDate.getTime());
        const diffMins = Math.floor(diffMs / 60000);
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        let relativeTime = "Just now";
        if (hours > 0) {
          relativeTime = `${hours} hr${hours > 1 ? "s" : ""}${mins > 0 ? ` ${mins} min${mins > 1 ? "s" : ""}` : ""} ago`;
        } else if (diffMins > 0) {
          relativeTime = `${diffMins} min${diffMins > 1 ? "s" : ""} ago`;
        }

        return res.status(409).json({
          code: "RECENT_ORDER_EXISTS_24H",
          message: "This customer has already placed an order in the last 24 hours.",
          recentOrder: {
            id: recentOrderId,
            shortId: recentOrderId.slice(-6).toUpperCase(),
            createdAt: recentOrder.createdAt,
            formattedTime,
            relativeTime,
            finalAmount: recentOrder.finalAmount,
            totalAmount: recentOrder.totalAmount,
            orderStatus: recentOrder.orderStatus,
            paymentMethod: recentOrder.paymentMethod,
            placedByAdmin: !!(recentOrder as any).placedByAdminId,
            itemsCount: recentItems.length,
            itemsSummary,
            customerName: customer.username,
          },
        });
      }
    }

    // ── 2. Validate + price items ────────────────────────────────────────────
    if (!items?.length) return res.status(400).json({ message: "At least one item is required" });

    const productIds = items.map((i: any) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, isActive: true },
      select: { id: true, name: true, price: true, stock: true },
    });

    const productMap = Object.fromEntries(products.map((p: any) => [p.id, p]));

    // Items that name a variantId (admin picking a specific size/color at the counter,
    // same as a customer would on the storefront) get their stock/price resolved from
    // that variant instead of the bare product — see ProductVariant in mongoose.ts.
    const variantIds = items.map((i: any) => i.variantId).filter(Boolean);
    const variants = variantIds.length
      ? await prisma.productVariant.findMany({ where: { id: { in: variantIds } } })
      : [];
    const variantMap = Object.fromEntries(variants.map((v: any) => [v.id, v]));

    let subtotal = 0;
    const orderItems: Array<{ productId: string; variantId?: string | null; quantity: number; price: number }> = [];

    for (const item of items) {
      const product = productMap[item.productId];
      if (!product) return res.status(400).json({ message: `Product ${item.productId} not found or inactive` });

      const variant = item.variantId ? variantMap[item.variantId] : null;
      if (item.variantId && !variant) {
        return res.status(400).json({ message: `Selected variant not found for "${product.name}"` });
      }
      const availableStock = variant ? variant.stock : product.stock;
      if (availableStock < item.quantity) {
        return res.status(400).json({ message: `Insufficient stock for "${product.name}" (available: ${availableStock})` });
      }
      // Same effective-price rule as the cart-based flows (placeOrder/placeOrderPOD) —
      // variant priceOverride/discountOverride win over the product's own, see itemPrice.
      const price = itemPrice({ product, variant });
      subtotal += price * item.quantity;
      orderItems.push({ productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity, price });
    }

    // ── Coupon validation (server-side re-check, same as placeOrder/placeOrderPOD) ──
    let discountAmount = 0;
    let resolvedCouponId: string | undefined;

    if (couponId) {
      const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
      if (coupon && coupon.isActive && (!coupon.expiresAt || new Date(coupon.expiresAt).getTime() > Date.now()) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses) && subtotal >= coupon.minOrderAmount) {
        discountAmount = coupon.discountType === "PERCENTAGE"
          ? Math.round((subtotal * coupon.discountValue) / 100)
          : Math.min(coupon.discountValue, subtotal);
        resolvedCouponId = coupon.id;
      }
    }

    const finalAmount = Math.max(subtotal - discountAmount, 0); // No shipping for admin orders (cash counter sales)

    // ── 3-5. Create order + deduct stock + payment log — succeed or fail together ──
    const order = await prisma.$transaction(async (tx: typeof prisma) => {
      const created = await tx.order.create({
        data: {
          userId: customer.id,
          placedByAdminId: adminId,
          totalAmount: subtotal,
          shippingCharge: 0,
          discountAmount,
          taxAmount: 0,
          finalAmount,
          paymentMethod: paymentMethod as "CASH" | "POD",
          paymentStatus: paymentMethod === "CASH" ? "PAID" : "PENDING",
          orderStatus: "CONFIRMED",
          couponId: resolvedCouponId,
          shippingAddress: {
            fullAddress: address?.fullAddress?.trim() || "",
            city: address?.city?.trim() || "",
            state: address?.state?.trim() || "",
            zipCode: address?.zipCode?.trim() || "",
            country: address?.country?.trim() || "India",
          },
          items: { create: orderItems },
        },
      });

      if (resolvedCouponId) {
        await tx.coupon.update({ where: { id: resolvedCouponId }, data: { usedCount: { increment: 1 } } });
      }

      await deductStock(orderItems, tx);

      await tx.paymentLog.create({
        data: {
          orderId: created.id,
          userId: customer.id,
          event: "ADMIN_ORDER_PLACED",
          paymentMethod: paymentMethod as "CASH" | "POD",
          paymentStatus: paymentMethod === "CASH" ? "PAID" : "PENDING",
          amount: finalAmount,
          gatewayResponse: {
            placedByAdmin: adminId,
            note: paymentNote ?? (paymentMethod === "CASH" ? "Cash collected at counter" : "Pay on delivery"),
          },
          signatureValid: null,
          ipAddress: req.ip ?? null,
        },
      });

      return created;
    });

    // ── 6. Notifications ─────────────────────────────────────────────────────
    const shortId = order.id.slice(-6);
    const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { username: true } });
    const adminRecipients = await getAdminRecipients();
    await notifyUsers(req, order.id, `Admin Order #${shortId} placed by ${admin!.username} for ${customer.username}`, "NEW_ORDER", adminId, adminRecipients);

    // ── 7. Confirmation email ────────────────────────────────────────────────
    if (customer.email) {
      try {
        await sendEmail({
          to: customer.email,
          toName: customer.username,
          ...orderConfirmationEmailPayload(shortId, customer.username, finalAmount.toFixed(2), paymentMethod === "CASH" ? "ONLINE" : "POD"),
        });
        logger.info(`Admin-order confirmation email sent for ${customer.email}`);
      } catch (emailErr) {
        logger.warn("Admin-order confirmation email failed", emailErr);
      }
    }

    // ── 8. Audit log ─────────────────────────────────────────────────────────
    await createAuditLog({
      req,
      action: "ADMIN_PLACE_ORDER",
      entity: "Order",
      entityId: order.id,
      details: { customerId: customer.id, customerName: customer.username, paymentMethod, paymentNote, finalAmount },
    });

    res.status(201).json({
      message: "Order placed successfully",
      order: { id: order.id, shortId, finalAmount, paymentMethod, orderStatus: order.orderStatus },
      customer: { id: customer.id, username: customer.username, email: customer.email },
    });
  } catch (err: any) {
    logger.error("placeAdminOrder error", err);
    res.status(500).json({ message: "Failed to place order", error: err.message });
  }
};

// GET /api/orders/admin-order/lookup-pincode/:pincode  (admin / super-admin / staff)
// Resolves 6-digit Indian PIN code to City / District and State
export const lookupPincode = async (req: Request, res: Response) => {
  const pincode = String(req.params.pincode || req.query.pincode || "").trim();
  const cleanPin = pincode.replace(/\D/g, "").slice(0, 6);
  if (cleanPin.length !== 6) {
    return res.status(400).json({ success: false, message: "Invalid 6-digit PIN code" });
  }

  // 1. Try Nominatim (OpenStreetMap) with User-Agent header and 4s timeout
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const osmRes = await fetch(
      `https://nominatim.openstreetmap.org/search?postalcode=${cleanPin}&country=India&format=json&addressdetails=1`,
      {
        headers: { "User-Agent": "StorraApp/1.0 (contact@storra.com)" },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);
    if (osmRes.ok) {
      const data: any = await osmRes.json();
      if (Array.isArray(data) && data.length > 0) {
        const addr = data[0].address || {};
        const district = addr.state_district || addr.county || "";
        let city = addr.city || addr.town || addr.village || district || "";
        if (city.toLowerCase().includes("corporation") && district) {
          city = district;
        }
        city = city.replace(/\s+District$/i, "").trim();
        const state = (addr.state || "").trim();
        if (city || state) {
          return res.json({ success: true, city: city || district, district, state });
        }
      }
    }
  } catch {
    // Continue to fallback
  }

  // 2. Try postalpincode.in with 3s timeout
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const postRes = await fetch(`https://api.postalpincode.in/pincode/${cleanPin}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (postRes.ok) {
      const postData: any = await postRes.json();
      if (postData && postData[0] && postData[0].Status === "Success") {
        const postOffices = postData[0].PostOffice || [];
        if (postOffices.length > 0) {
          const po = postOffices[0];
          const fetchedDistrict = (po.District && po.District !== "NA") ? po.District : "";
          const fetchedCity = fetchedDistrict || po.Block || po.Name || "";
          const fetchedState = po.State || "";
          return res.json({ success: true, city: fetchedCity, district: fetchedDistrict, state: fetchedState });
        }
      }
    }
  } catch {
    // Continue to fallback
  }

  // 3. Try zippopotam with 3s timeout
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const zipRes = await fetch(`https://api.zippopotam.us/in/${cleanPin}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (zipRes.ok) {
      const zipData: any = await zipRes.json();
      if (zipData && Array.isArray(zipData.places) && zipData.places.length > 0) {
        const place = zipData.places[0];
        return res.json({
          success: true,
          city: place["place name"] || "",
          district: place["place name"] || "",
          state: place.state || "",
        });
      }
    }
  } catch {
    // All sources exhausted
  }

  return res.status(404).json({ success: false, message: "Location not found for this PIN code" });
};

// GET /api/order/shipping-toggles (authenticated customer / admin / staff)
export const getShippingToggles = async (_req: Request, res: Response) => {
  try {
    const config = await getShippingConfigFromDB();
    res.json({
      calculateShippingForCOD: config.calculateShippingForCOD !== false,
      calculateShippingForOnline: config.calculateShippingForOnline !== false,
      calculateShippingForQR: config.calculateShippingForQR !== false,
    });
  } catch {
    res.json({
      calculateShippingForCOD: true,
      calculateShippingForOnline: true,
      calculateShippingForQR: true,
    });
  }
};

