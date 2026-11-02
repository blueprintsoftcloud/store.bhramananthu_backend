import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import path from "path";
import fs from "fs";

import { env } from "./config/env";
import "./config/prisma";
import { connectDB } from "./config/database";
import { errorHandler } from "./middleware/errorHandler.middleware";
import { generalLimiter } from "./middleware/rateLimit.middleware";
import { ensureCsrfCookie, csrfProtection } from "./middleware/csrf.middleware";
import { sanitizeRequest } from "./middleware/sanitize.middleware";
import { requestId } from "./middleware/requestId.middleware";
import initSocket from "./socket/socketManager";
import { initNotificationService } from "./services/notification.service";
import { initMaintenanceSchedule } from "./services/maintenance.service";
import { startHealthMonitor, stopHealthMonitor } from "./monitoring/healthMonitor";

// Routes
import authRoutes from "./routes/auth.routes";
import adminRoutes from "./routes/admin.routes";
import superAdminRoutes from "./routes/superAdmin.routes";
import categoryRoutes from "./routes/category.routes";
import productRoutes from "./routes/product.routes";
import userRoutes from "./routes/user.routes";
import cartRoutes from "./routes/cart.routes";
import orderRoutes from "./routes/order.routes";
import addressRoutes from "./routes/address.routes";
import notificationRoutes from "./routes/notification.routes";
import couponRoutes from "./routes/coupon.routes";
import analyticsRoutes from "./routes/analytics.routes";
import staffRoutes from "./routes/staff.routes";
import auditLogRoutes from "./routes/auditLog.routes";
import settingsRoutes from "./routes/settings.routes";
import paymentLogRoutes from "./routes/paymentLog.routes";
import reviewRoutes from "./routes/review.routes";
import homeBannerRoutes from "./routes/homeBanner.routes";
import deliveryPartnerRoutes from "./routes/deliveryPartner.routes";
import staticPagesRoutes from "./routes/staticPages.routes";
import purchaseFeedbackRoutes from "./routes/purchaseFeedback.routes";
import { getSitemap, getRobotsTxt } from "./controllers/seo.controller";
import { serveDynamicHtml, getFaviconUrl } from "./utils/htmlRenderer";


const app = express();
const server = http.createServer(app);

// ── Request ID ────────────────────────────────────────────────────────────────
// First middleware in the chain so every log line for this request — including
// ones emitted by middleware that runs before routing — carries a correlation id.
app.use(requestId);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Security Headers ─────────────────────────────────────────────────────────
// Was a listed dependency that was never actually registered. Enables
// X-Content-Type-Options, X-Frame-Options, HSTS, cross-origin isolation headers, etc.
// contentSecurityPolicy is deliberately left off here: helmet's default CSP would block
// the Razorpay checkout.js script tag (cart/CheckoutPage.tsx), the MSG91 OTP widget
// script, and Cloudinary-hosted product images — all loaded from external origins the
// frontend depends on today. Turning on a correct CSP requires enumerating every
// external origin this app actually loads from and verifying checkout/OTP/images still
// work in a real browser — not something to guess at blind. Tracked as a follow-up.
app.use(
  helmet({
    contentSecurityPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // This app is deliberately cross-origin (frontend and API run on different
    // origins — see the CORS allowlist below) and serves images from /uploads that
    // the frontend loads directly. Helmet's default "same-origin" CORP would block
    // that cross-origin image loading.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }, // 👈 Allows Razorpay / Bank OTP popups
  }),
);

// ── CORS ──────────────────────────────────────────────────────────────────────
// Reads a comma-separated allowlist from ALLOWED_ORIGINS env var.
// Example .env: ALLOWED_ORIGINS=https://yourapp.com,https://www.yourapp.com
// Falls back to localhost:5173 in development.
const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);


//changed the cors configuration to allow the mobile devices ..............................................

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  }),
);


// app.use(
//   cors({
//     origin: true,
//     credentials: true,
//   })
// );


process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});

// ── Core Middleware ────────────────────────────────────────────────────────────
// Trust the nginx reverse proxy so that express-rate-limit can read the real
// client IP from X-Forwarded-For without throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set("trust proxy", 1);
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(cookieParser());
app.use(ensureCsrfCookie);

// ── Request Hardening ────────────────────────────────────────────────────────
// Strips Mongo operator keys ($ne, $where, ...) from body/query/params, then
// enforces the double-submit CSRF token on authenticated, state-changing /api calls.
app.use(sanitizeRequest);
app.use("/api", csrfProtection);

// ── General Rate Limiter ──────────────────────────────────────────────────────
app.use("/api", generalLimiter);

// ── Static Uploads ────────────────────────────────────────────────────────────
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
// Starts every connection on long-polling (works through any proxy, including
// shared-hosting reverse proxies like Passenger) and silently upgrades to
// WebSocket when the host supports it. If a deployment's proxy can't handle the
// upgrade, the client just stays on polling — no hard failure either way.
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  },
  transports: ["polling", "websocket"],
});


initSocket(io);
initNotificationService(io);
app.set("socketio", io);

// ── API Routes ────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/super-admin", superAdminRoutes);
app.use("/api/category", categoryRoutes);
app.use("/api/product", productRoutes);
app.use("/api/user", userRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/order", orderRoutes);
app.use("/api/address", addressRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/coupon", couponRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/audit-logs", auditLogRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/payment-logs", paymentLogRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/home-banners", homeBannerRoutes);
app.use("/api/delivery-partners", deliveryPartnerRoutes);
app.use("/api/pages", staticPagesRoutes);
app.use("/api/purchase-feedback", purchaseFeedbackRoutes);

// ── SEO: sitemap.xml / robots.txt / favicon ──────────────────────────────────
// Mounted at the app root (not under /api) — search engines require robots.txt at
// the domain root, and this backend already serves the built frontend from this
// same origin (see the static/catch-all below), so no separate proxy rule is needed.
app.get("/sitemap.xml", getSitemap);
app.get("/robots.txt", getRobotsTxt);
app.get(["/favicon.ico", "/favicon.png"], async (req, res) => {
  try {
    const faviconUrl = await getFaviconUrl();
    if (faviconUrl && faviconUrl.startsWith("http")) {
      return res.redirect(302, faviconUrl);
    }
  } catch (e) {}
  res.status(404).end();
});

// ── Serve React Frontend ───────────────────────────────────────────────────
const candidateStaticDirs = [
  path.join(__dirname, "../../client"),
  path.join(__dirname, "../client"),
  path.join(process.cwd(), "client"),
  path.join(process.cwd(), "dist/client"),
  path.join(process.cwd(), "backend/client"),
  path.join(process.cwd(), "../frontend/dist"),
  path.join(__dirname, "../../../frontend/dist"),
  path.join(__dirname, "../../frontend/dist"),
];
for (const dir of candidateStaticDirs) {
  if (fs.existsSync(dir)) {
    app.use(
      express.static(dir, {
        index: false,
        maxAge: "1y",
        immutable: true,
      }),
    );
  }
}

// ── React Router Catch-all (Dynamic Branding & SEO Injection) ──────────────
app.get("*splat", (req, res) => {
  serveDynamicHtml(req, res);
});

// ── Error Handler ─────────────────────────────────────────────────────────────
// Must be LAST — Express only routes an error to a 4-arg handler registered
// before the route that raised it. Mounting this ahead of the static/catch-all
// routes above meant any failure serving the frontend (e.g. a missing file)
// fell through to Express's own default handler instead of this one.
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
// listen() first, DB connects in the background — some hosts (Hostinger's Node
// App included) health-check for listen() within a few seconds and kill/restart
// the process if it's still waiting on a slow first Mongo connection. Mongoose
// buffers queries by default, so requests that arrive before the connection is
// ready simply wait rather than error.
const PORT = Number(env.PORT ?? 5000);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on PORT ${PORT}`);
});

connectDB()
  .then(() => {
    console.log("MongoDB connected.");
    initMaintenanceSchedule();
    startHealthMonitor();
  })
  .catch((error) => {
    console.error("Critical startup error:", error);
    process.exit(1);
  });

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// In-flight fire-and-forget background work (email/notification/inventory/audit-log)
// is accepted loss on shutdown — there's no queue to drain now that it runs in-process.
let isShuttingDown = false;
const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received — shutting down gracefully...`);
  try {
    stopHealthMonitor();
    server.close(() => process.exit(0));
    // Force-exit if server.close() hangs (e.g. open keep-alive sockets)
    setTimeout(() => process.exit(0), 10_000).unref();
  } catch (err) {
    console.error("Error during graceful shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Force reload: 2

