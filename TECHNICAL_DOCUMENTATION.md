# Storra — Complete Technical Documentation

> **For developers joining from Java Spring Boot or Python backgrounds.**
> Generated from deep codebase analysis. May 2026.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Folder Structure & Responsibilities](#3-folder-structure--responsibilities)
4. [Architecture Explanation](#4-architecture-explanation)
5. [Request Lifecycle & Middleware Flow](#5-request-lifecycle--middleware-flow)
6. [Authentication & Authorization Flow](#6-authentication--authorization-flow)
7. [API Documentation](#7-api-documentation)
8. [Database Documentation](#8-database-documentation)
9. [Business Flows](#9-business-flows)
10. [External Integrations](#10-external-integrations)
11. [Environment Configuration](#11-environment-configuration)
12. [Express.js Learning Guide (for Spring Boot / Python developers)](#12-expressjs-learning-guide-for-spring-boot--python-developers)
13. [Code Quality & Architecture Analysis](#13-code-quality--architecture-analysis)
14. [Deployment Notes](#14-deployment-notes)
15. [Risks & Technical Debt](#15-risks--technical-debt)
16. [Suggested Improvements](#16-suggested-improvements)

---

## 1. Project Overview

**Name:** Storra E-Commerce API
**Version:** 2.0.0
**Purpose:** A full-featured e-commerce backend for a boutique/clothing store. Serves a React frontend and supports mobile clients.

### Core Business Domain

This is an **online boutique store** with:

- Customer-facing shopping (browse, cart, checkout, order tracking)
- Admin panel for shop management (products, orders, coupons, staff)
- Super Admin control layer (feature flags, system access)
- Real-time notifications via WebSockets
- Razorpay payment gateway integration (Indian market — payments in INR)
- Geo-based shipping calculation (Kerala, India warehouse origin)

### Main Features Implemented

| Module | Description |
|--------|-------------|
| Auth | Email+OTP 2-step login, mobile OTP via MSG91, refresh tokens, password reset |
| User/Customer | Profile management, profile update with OTP verification |
| Catalog | Categories with attributes, Products with images, filtering |
| Cart | Add/remove/update items, persistent per user |
| Wishlist | Add/remove/clear wishlist |
| Orders | Online (Razorpay) + Pay-on-Delivery, order tracking, admin order placement |
| Payments | Razorpay webhook verification, payment logs |
| Coupons | Percentage/flat discount, usage limits, expiry |
| Reviews | Verified-purchase-only reviews with rating |
| Notifications | Real-time in-app notifications via Socket.IO |
| Analytics | Revenue, orders, customer, product, profit analytics with date ranges |
| Staff | Role-based staff with granular permissions |
| Audit Log | Admin action trail |
| Feature Flags | Super Admin toggles features on/off |
| Homepage CMS | Banners, carousels, featured products, hero sections |
| Settings | Warehouse location, shipping rate configuration |
| Company Settings | Logo, footer, announcement bar |
| Customer Tracker | Admin view of customer wishlist/cart activity |
| Address | GPS-based and manual address with shipping preview |

---

## 2. Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Node.js (v22+) | JavaScript runtime |
| Framework | Express.js v5 | HTTP server and routing |
| Language | TypeScript 5.7 | Type safety |
| Database | MongoDB (via Mongoose v8) | Primary data store |
| ORM Abstraction | Custom `prisma` adapter | Mimics Prisma client API on top of Mongoose |
| Auth | JWT + HttpOnly Cookies | Stateless authentication |
| Password Hashing | bcrypt | Secure password storage |
| Validation | Zod | Runtime schema validation |
| File Uploads | Multer (memory storage) → Cloudinary | Image upload pipeline |
| Email | Nodemailer (Gmail SMTP) | OTP and transactional emails |
| Payment | Razorpay | Indian payment gateway |
| Real-time | Socket.IO v4 | WebSocket notifications |
| Logging | Winston | Structured logging |
| Rate Limiting | express-rate-limit | DDoS/brute-force protection |
| Security | Helmet (not currently applied — see risks) | HTTP security headers |
| CORS | cors package | Cross-origin configuration |
| Compression | compression | gzip response compression (imported but see risks) |
| Process Manager | PM2 (ecosystem.config.js) | Production process management |
| Build | tsc (TypeScript compiler) | Compiles to dist/ |
| Dev Server | tsx watch | Hot-reload in development |

---

## 3. Folder Structure & Responsibilities

```
boutique_backend/
├── src/
│   ├── server.ts               ← Application entry point
│   ├── config/                 ← Singletons and external service config
│   │   ├── env.ts              ← Zod-validated env variables (import this, never process.env)
│   │   ├── database.ts         ← MongoDB connection via Mongoose
│   │   ├── prisma.ts           ← Custom Prisma-like Mongoose adapter (global `prisma` object)
│   │   ├── tokens.ts           ← JWT generation, cookie management
│   │   ├── mailer.ts           ← Nodemailer transporter + OTP templates
│   │   ├── cloudinary.ts       ← Cloudinary upload/delete helpers
│   │   ├── razorpay.ts         ← Razorpay SDK singleton
│   │   └── staffPermissions.ts ← Canonical staff permission list
│   ├── controllers/            ← Business logic (receives req, calls models, sends res)
│   ├── middleware/             ← Request interceptors (auth, validation, rate-limit, etc.)
│   ├── models/
│   │   ├── mongoose.ts         ← ALL Mongoose schemas and model definitions
│   │   └── index.ts            ← Re-exports all models for clean imports
│   ├── routes/                 ← Express Router definitions (URL ↔ controller mapping)
│   ├── schemas/                ← Zod validation schemas (request body shapes)
│   ├── services/
│   │   └── shipping.service.ts ← Haversine distance + shipping charge calculation
│   ├── socket/
│   │   └── socketManager.ts    ← Socket.IO authentication and room management
│   ├── types/
│   │   ├── express.d.ts        ← Extends Express Request with `req.user`
│   │   └── prisma.d.ts         ← Declares global `prisma` variable (the custom adapter)
│   └── utils/
│       ├── auditLog.ts         ← Helper to write audit log entries
│       ├── logger.ts           ← Winston logger instance
│       └── warehouseSettings.ts← Reads warehouse/shipping config from DB
├── scripts/
│   ├── seedSuperAdmin.ts       ← One-time script to create the SUPER_ADMIN user
│   └── seedCategories.ts       ← One-time script to seed categories
├── ecosystem.config.js         ← PM2 process manager config
├── tsconfig.json               ← TypeScript compiler config
└── package.json
```

### Spring Boot Analogy

| Spring Boot | This Project |
|-------------|-------------|
| `@SpringBootApplication` main class | `src/server.ts` |
| `application.properties` / `application.yml` | `.env` + `src/config/env.ts` |
| `@RestController` | `src/controllers/*.ts` |
| `@RequestMapping` / `@GetMapping` | `src/routes/*.ts` |
| `@Service` | `src/services/*.ts` (currently only shipping) |
| `@Repository` / JPA | Mongoose models in `src/models/mongoose.ts` |
| `@Component` Filter/Interceptor | `src/middleware/*.ts` |
| Spring Security filter chain | Middleware chain: `authMiddleware → adminMiddleware → featureGate` |
| Bean configuration | `src/config/*.ts` singletons |
| `@Valid` + `BindingResult` | `validate(schema)` middleware using Zod |
| `@ControllerAdvice` / `@ExceptionHandler` | `src/middleware/errorHandler.middleware.ts` |
| Actuator `/health` | `GET /health` endpoint in server.ts |

---

## 4. Architecture Explanation

### Overall Pattern

This project follows a **layered MVC architecture** without a strict service layer for most features:

```
HTTP Request
     ↓
Express Router (routes/*.ts)
     ↓
Middleware Chain (auth → role check → feature gate → validation)
     ↓
Controller (controllers/*.ts) — contains business logic
     ↓
Model / DB (Mongoose models or prisma adapter)
     ↓
HTTP Response
```

> **Important Note for Spring Boot developers:** In Spring Boot, you have a clean separation of Controller → Service → Repository. In this project, most business logic lives directly in Controllers. There is only one formal Service file (`shipping.service.ts`). This is common in Express.js projects but is worth refactoring as the project grows (see Suggested Improvements).

### The Custom `prisma` Global Adapter

This is the most architecturally unique aspect of this codebase.

The file `src/config/prisma.ts` implements a **custom ORM adapter** that:
- Wraps all Mongoose models
- Exposes a `prisma`-style API globally (e.g., `prisma.user.findMany(...)`, `prisma.order.create(...)`)
- Translates Prisma-style query syntax (where, include, select, orderBy) into MongoDB/Mongoose query syntax
- This object is declared as a global in `src/types/prisma.d.ts`

**Why this exists:** The project was likely migrated or partially planned to use Prisma ORM but stayed with MongoDB/Mongoose. The adapter allows controllers to use familiar Prisma-style API calls without switching ORMs.

**Consequence:** The codebase has two query styles:
- Native Mongoose: `User.findOne({ email })` — used in older/simpler controllers
- Prisma adapter: `prisma.user.findUnique({ where: { email } })` — used in newer controllers and middleware

Both target the same MongoDB database through the same Mongoose models. This is technical debt.

### Role Hierarchy

```
SUPER_ADMIN
    └── Can do everything + toggle feature flags + clear audit logs
ADMIN (Shop Owner)
    └── Can manage everything in the store
STAFF
    └── Has only the specific permissions assigned by Admin
CUSTOMER
    └── Can browse, shop, manage own profile/orders
```

---

## 5. Request Lifecycle & Middleware Flow

### Global Middleware (applied to all `/api/*` routes in server.ts)

```
Request
  → CORS check (origin whitelist from ALLOWED_ORIGINS env)
  → express.json() (parse JSON body)
  → cookieParser() (parse cookies for JWT)
  → generalLimiter (500 req/min rate limit per IP)
  → Route matching
```

### Per-Route Middleware Chain Example (Admin Order Update)

```
PUT /api/order/update/:id
  1. authMiddleware       — verify JWT cookie → set req.user
  2. adminOrStaff("ORDER_UPDATE")  — check role (ADMIN/SUPER_ADMIN pass, STAFF check permissions)
  3. featureGate("ORDER_MANAGEMENT") — check FeatureFlag.isEnabled in DB
  4. validate(updateOrderStatusSchema) — Zod validation of req.body
  5. updateStatus controller — business logic
```

### Middleware Descriptions

| Middleware | File | Purpose |
|-----------|------|---------|
| `authMiddleware` | auth.middleware.ts | Verifies JWT from `jwt` cookie, sets `req.user` |
| `optionalAuthMiddleware` | optionalAuth.middleware.ts | Tries JWT but never blocks (guest + auth) |
| `adminMiddleware` | admin.middleware.ts | Checks `req.user.role === ADMIN or SUPER_ADMIN` |
| `superAdminMiddleware` | superAdmin.middleware.ts | Checks `req.user.role === SUPER_ADMIN` only |
| `adminOrStaff(perm)` | staffPermission.middleware.ts | Admin passes; Staff must have specific permission |
| `featureGate(feature)` | featureGate.middleware.ts | Checks FeatureFlag DB record; SUPER_ADMIN bypasses |
| `validate(schema)` | validate.middleware.ts | Runs Zod schema, replaces req.body with parsed data |
| `upload` | upload.ts | Multer memory storage, 5MB limit, images only |
| `loginLimiter` | rateLimit.middleware.ts | 30 req/15min for login |
| `otpLimiter` | rateLimit.middleware.ts | 5 req/10min for OTP send |
| `signupLimiter` | rateLimit.middleware.ts | 10 req/hr for signup |
| `passwordResetLimiter` | rateLimit.middleware.ts | 5 req/30min for password reset |
| `generalLimiter` | rateLimit.middleware.ts | 500 req/min global API limit |
| `errorHandler` | errorHandler.middleware.ts | Central error handler (mounted last) |

### Error Handling Strategy

The `errorHandler` middleware (mounted last in server.ts) catches all errors forwarded via `next(err)`:

```
Error thrown anywhere
  → next(err) call in controller (or Express auto-catches async errors in v5)
  → errorHandler middleware:
      - AppError instance → res.status(err.statusCode).json({ message })
      - ZodError → res.status(400).json({ errors: fieldErrors })
      - MongoDB duplicate key (code 11000) → res.status(409).json(...)
      - Unknown errors → res.status(500) with generic message in production
```

> **Express 5 note:** Unlike Express 4, Express 5 automatically catches rejected promises from async route handlers. You don't need `try/catch` + `next(err)` for every async function. However, this codebase still uses explicit try/catch throughout (which is fine and explicit).

---

## 6. Authentication & Authorization Flow

### JWT Token Strategy

- **Access Token:** Short-lived (1 hour), JWT signed with `JWT_SECRET`, stored in HttpOnly cookie named `jwt`
- **Refresh Token:** Long-lived (7 days), JWT signed with `REFRESH_TOKEN_SECRET`, stored in HttpOnly cookie named `refreshToken`; the raw token value is also stored in `User.refreshToken` (DB-level revocation)
- **HttpOnly Cookies:** Neither token is accessible from JavaScript — prevents XSS token theft

### Email Login Flow (2-Step)

```
Step 1: POST /api/auth/login
  Client sends { email, password }
  → Server validates credentials with bcrypt
  → Server generates 6-digit OTP, saves to Otp collection (TTL 5min)
  → Sends OTP to user's email via Nodemailer
  → Returns 200 { step: "VERIFY_OTP", email }

Step 2: POST /api/auth/login/verify
  Client sends { email, otp }
  → Server validates OTP record (exists + not expired)
  → Deletes consumed OTP record
  → Calls generateToken() → sets jwt + refreshToken cookies
  → Returns 200 { role }
```

### Mobile OTP Login (MSG91)

```
POST /api/auth/mobile-login
  Client sends { phone, accessToken } (accessToken from MSG91 widget)
  → Server verifies accessToken against MSG91 API
  → Finds or creates user by phone
  → Sets JWT cookies
  → Returns 200 { role }
```

### Token Refresh Flow

```
POST /api/auth/refresh
  → Reads refreshToken cookie
  → Verifies JWT signature
  → Looks up User.refreshToken in DB (validates token isn't revoked)
  → Issues new access token cookie
  → Returns 200
```

### Authorization Layers (in order of strictness)

```
1. authMiddleware     → "Are you logged in?"
2. adminMiddleware    → "Are you ADMIN or SUPER_ADMIN?"
3. superAdminMiddleware → "Are you SUPER_ADMIN?"
4. adminOrStaff(perm) → "Are you ADMIN, or STAFF with this specific permission?"
5. featureGate(feat)  → "Is this feature enabled by Super Admin?"
```

### Socket.IO Authentication

Socket connections are authenticated via the same JWT cookie or a token passed in `socket.handshake.auth.token`. On connection:
- User joins their private room `socket.join(user.id)` — for personal notifications
- ADMIN/SUPER_ADMIN also join `admin-room` — for admin-broadcast events

---

## 7. API Documentation

**Total APIs: ~80+** grouped by module below.

### Base URL: `/api`

---

### AUTH MODULE — `/api/auth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/signup` | No | Register user. First signup becomes ADMIN; subsequent become CUSTOMER |
| POST | `/login` | No | Step 1: verify credentials, send OTP to email |
| POST | `/login/verify` | No | Step 2: verify OTP, issue JWT cookies |
| POST | `/resend-otp` | No | Resend OTP to email |
| POST | `/refresh` | No (cookie) | Refresh access token using refresh token cookie |
| POST | `/logout` | No | Clear JWT cookies, revoke refresh token in DB |
| GET | `/status` | Optional | Check session status (used by frontend on load) |
| POST | `/forgot-password` | No | Send password reset OTP to email |
| POST | `/verify-reset-otp` | No | Verify password reset OTP |
| POST | `/reset-password` | No | Set new password (requires verified reset session) |
| POST | `/mobile-login` | No | Login/register via MSG91 mobile OTP |
| POST | `/mobile-register` | No | Register via mobile (creates account) |
| GET | `/check-phone` | No | Check if phone number is registered |

**Request / Response Examples:**

```json
POST /api/auth/signup
Body: { "username": "John", "email": "john@example.com", "phone": "9876543210", "password": "secret123" }
Response 201: { "message": "User created successfully", "user": { "id", "username", "email", "role": "CUSTOMER" } }
```

```json
POST /api/auth/login
Body: { "email": "john@example.com", "password": "secret123" }
Response 200: { "message": "Credentials verified. OTP sent to your email.", "step": "VERIFY_OTP", "email": "john@example.com" }
```

---

### ADMIN MODULE — `/api/admin`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/users` | ADMIN | List all customers (paginated) |
| POST | `/users` | ADMIN | Create a new user account |
| PATCH | `/users/:id` | ADMIN | Update user details |
| DELETE | `/users/:id` | ADMIN | Delete a user |
| GET | `/adminProfile` | ADMIN | Get admin's own profile |
| PATCH | `/avatar` | ADMIN | Update admin avatar |
| DELETE | `/avatar` | ADMIN | Remove admin avatar |
| POST | `/adminProfile/request-update` | ADMIN | Request profile update (sends OTP) |
| POST | `/adminProfile/verify-update` | ADMIN | Verify OTP and apply profile changes |
| GET | `/summary` | ADMIN | Analytics summary cards (30-day stats) |
| GET | `/dashboard` | ADMIN | Live dashboard data (recent orders, stock alerts) |
| GET | `/company-settings` | Public | Get company info (used for invoices) |
| PUT | `/company-settings` | ADMIN | Update company info + upload logo/favicon |
| PATCH | `/announcement-toggle` | ADMIN | Toggle announcement bar on/off |
| POST | `/upload-image` | ADMIN | Upload a single image to Cloudinary |
| GET | `/homepage-config` | ADMIN | Get hero + footer config |
| PUT | `/homepage-config/hero` | ADMIN | Update hero section |
| PUT | `/homepage-config/footer` | ADMIN | Update footer section |
| GET | `/tracker/customers` | ADMIN | List customers with activity |
| GET | `/tracker/customers/:userId/wishlist` | ADMIN | View customer's wishlist |
| GET | `/tracker/customers/:userId/cart` | ADMIN | View customer's cart |

---

### SUPER ADMIN MODULE — `/api/super-admin`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/features` | ADMIN+ | List all feature flags and their status |
| PATCH | `/features/:feature` | SUPER_ADMIN | Enable/disable a feature flag |
| GET | `/summary` | SUPER_ADMIN | Super admin dashboard stats |
| GET | `/admin-user` | SUPER_ADMIN | Get the ADMIN user info |

**Feature Flags (toggleable by SUPER_ADMIN):**
`USER_MANAGEMENT`, `CATEGORY_MANAGEMENT`, `PRODUCT_MANAGEMENT`, `ORDER_MANAGEMENT`, `COUPON_MANAGEMENT`, `NOTIFICATION_MANAGEMENT`, `REPORTS_ANALYTICS`, `STAFF_MANAGEMENT`, `STAFF_PERMISSION_MANAGEMENT`, `WAREHOUSE_SETTINGS`, `AUDIT_LOG`, `CUSTOMER_ACTIVITY_TRACKER`, `PAYMENT_LOGS`, `PRODUCT_REVIEWS`, `HOMEPAGE_MANAGEMENT`, `ADMIN_ORDER`

---

### CATEGORY MODULE — `/api/category`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/list` | Public | List all active categories |
| POST | `/add` | ADMIN/STAFF(CATEGORY_ADD) | Create category with image upload |
| PUT | `/update/:id` | ADMIN/STAFF(CATEGORY_EDIT) | Update category |
| DELETE | `/delete/:id` | ADMIN/STAFF(CATEGORY_DELETE) | Delete category |
| GET | `/:categoryId/attributes` | Public | Get attributes for a category |
| POST | `/:categoryId/attributes` | ADMIN/STAFF(CATEGORY_EDIT) | Add attribute to category |
| PUT | `/:categoryId/attributes/:attrId` | ADMIN/STAFF(CATEGORY_EDIT) | Update attribute |
| DELETE | `/:categoryId/attributes/:attrId` | ADMIN/STAFF(CATEGORY_EDIT) | Delete attribute |
| POST | `/:categoryId/attributes/:attrId/values` | ADMIN/STAFF(CATEGORY_EDIT) | Add attribute value |
| PUT | `/:categoryId/attributes/:attrId/values/:valueId` | ADMIN/STAFF(CATEGORY_EDIT) | Update attribute value |
| DELETE | `/:categoryId/attributes/:attrId/values/:valueId` | ADMIN/STAFF(CATEGORY_EDIT) | Delete attribute value |

---

### PRODUCT MODULE — `/api/product` (Admin) and `/api/user/shop` (Public)

**Admin Product Management (`/api/product`):**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/list` | ADMIN/STAFF(PRODUCT_VIEW) | List all products (admin view) |
| POST | `/add` | ADMIN/STAFF(PRODUCT_ADD) | Create product with image upload (1 main + 10 gallery) |
| PUT | `/update/:id` | ADMIN/STAFF(PRODUCT_EDIT) | Update product |
| DELETE | `/delete/:id` | ADMIN/STAFF(PRODUCT_DELETE) | Delete product |

**Public Product Browsing (`/api/user/shop`):**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/shop/categories` | Public | All categories |
| GET | `/shop/products` | Public | All products (with filters: category, price, sort) |
| GET | `/shop/global-search` | Public | Search across products and categories |
| GET | `/shop/product/:productId` | Public | Single product detail with attributes |
| GET | `/shop/categories/:categoryId` | Public | Products by category |
| GET | `/shop/categories/:categoryId/filters` | Public | Available filter attributes for a category |
| GET | `/products/search` | Public | Text search for products |

---

### USER MODULE — `/api/user`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/profile` | AUTH | Get own profile |
| POST | `/profile/request-update` | AUTH | Request email/phone update with OTP |
| POST | `/profile/verify-update` | AUTH | Verify OTP and apply profile changes |
| POST | `/:id/reviews` | AUTH | Submit a product review |
| GET | `/wishlist` | AUTH | Get wishlist |
| POST | `/wishlist` | AUTH | Add product to wishlist |
| DELETE | `/wishlist/:productId` | AUTH | Remove from wishlist |
| DELETE | `/wishlist` | AUTH | Clear entire wishlist |

---

### CART MODULE — `/api/cart`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/add` | AUTH | Add product to cart |
| GET | `/list` | AUTH | Get cart with product details |
| DELETE | `/remove/:productId` | AUTH | Remove item from cart |
| PUT | `/updateQuantity/:productId` | AUTH | Update item quantity |

---

### ORDER MODULE — `/api/order`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/pre-checkout` | AUTH | Validate cart before checkout, remove OOS items |
| POST | `/place` | AUTH | Create Razorpay order (online payment) |
| POST | `/verifyPayment` | AUTH | Verify Razorpay signature, confirm order |
| POST | `/placeOrderPOD` | AUTH | Place Pay-on-Delivery order |
| POST | `/cancel/:id` | AUTH | Cancel own order |
| GET | `/myOrders` | AUTH | Get own order history |
| GET | `/my-transactions` | AUTH | Get own payment transaction history |
| GET | `/all` | ADMIN/STAFF(ORDER_VIEW) | All orders (admin view, paginated, filterable) |
| GET | `/customer-transactions` | ADMIN/STAFF(ORDER_VIEW) | All customer transactions |
| PUT | `/update/:id` | ADMIN/STAFF(ORDER_UPDATE) | Update order status |
| GET | `/admin-order/search-customers` | ADMIN/STAFF(ORDER_CREATE) | Search customers for admin order |
| GET | `/admin-order/products` | ADMIN/STAFF(ORDER_CREATE) | Get products for admin order form |
| POST | `/admin-order/place` | ADMIN/STAFF(ORDER_CREATE) | Place order on behalf of customer |
| GET | `/:id` | AUTH | Get single order (customer gets own, admin gets any) |

**Order Status Transitions:** `PROCESSING → CONFIRMED → SHIPPED → DELIVERED` (or `CANCELLED`)

**Payment Status:** `PENDING → PAID` (or `FAILED`, `REFUNDED`)

---

### ADDRESS MODULE — `/api/address`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/save-geo` | AUTH | Save GPS coordinates as default address |
| POST | `/save-manual` | AUTH | Save manually entered address |
| GET | `/default` | AUTH | Get default delivery address |
| POST | `/preview-shipping` | AUTH | Preview shipping cost for an address |

---

### COUPON MODULE — `/api/coupon`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin` | ADMIN | List all coupons |
| POST | `/admin` | ADMIN | Create coupon |
| PATCH | `/admin/:id` | ADMIN | Update coupon |
| DELETE | `/admin/:id` | ADMIN | Delete coupon |
| PATCH | `/admin/:id/toggle` | ADMIN | Enable/disable coupon |
| POST | `/validate` | AUTH | Validate a coupon code at checkout |

---

### NOTIFICATION MODULE — `/api/notifications`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | AUTH | Get own notifications (paginated) |
| PUT | `/mark-all-read` | AUTH | Mark all notifications as read |
| PUT | `/:id/read` | AUTH | Mark one notification as read |
| DELETE | `/clear-all` | AUTH | Delete all own notifications |
| DELETE | `/:id` | AUTH | Delete one notification |
| GET | `/user` | AUTH | Legacy alias for GET `/` |

---

### ANALYTICS MODULE — `/api/analytics`

All require `ADMIN + REPORTS_ANALYTICS feature enabled`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/summary` | Revenue, orders, customers, products cards (30d vs 30d) |
| GET | `/summary-range` | Custom date range summary |
| GET | `/revenue` | Revenue by day (chart data) |
| GET | `/order-status` | Order count by status (pie chart) |
| GET | `/top-products` | Top selling products |
| GET | `/top-categories` | Top selling categories |
| GET | `/profit` | Profit summary (revenue - purchase cost) |
| GET | `/profit-by-day` | Profit chart data |
| GET | `/top-products-profit` | Most profitable products |
| GET | `/payment-methods` | Breakdown by ONLINE/POD/CASH |

---

### STAFF MODULE — `/api/staff`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/profile` | STAFF+ | Get own staff profile |
| GET | `/dashboard` | STAFF+ | Staff dashboard |
| PATCH | `/me` | STAFF+ | Update own profile |
| PATCH | `/me/avatar` | STAFF+ | Update own avatar |
| DELETE | `/me/avatar` | STAFF+ | Delete own avatar |
| GET | `/` | ADMIN | List all staff |
| POST | `/` | ADMIN | Create staff member |
| GET | `/:id` | ADMIN | Get staff by ID |
| PATCH | `/:id` | ADMIN | Update staff |
| PATCH | `/:id/permissions` | ADMIN | Update staff permissions |
| PATCH | `/:id/toggle` | ADMIN | Activate/deactivate staff account |
| DELETE | `/:id` | ADMIN | Delete staff |

**Staff Permissions:** `CATEGORY_VIEW`, `CATEGORY_ADD`, `CATEGORY_EDIT`, `CATEGORY_DELETE`, `PRODUCT_VIEW`, `PRODUCT_ADD`, `PRODUCT_EDIT`, `PRODUCT_DELETE`, `ORDER_VIEW`, `ORDER_UPDATE`, `ORDER_CREATE`

---

### AUDIT LOG MODULE — `/api/audit-logs`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | ADMIN | List audit logs (paginated, filterable by action/entity) |
| DELETE | `/` | SUPER_ADMIN | Clear all audit logs |

---

### SETTINGS MODULE — `/api/settings`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/warehouse` | ADMIN | Get warehouse GPS coordinates |
| PUT | `/warehouse` | ADMIN | Update warehouse location |
| GET | `/shipping-config` | ADMIN | Get shipping rate config |
| PUT | `/shipping-config` | ADMIN | Update shipping rates |

---

### PAYMENT LOGS MODULE — `/api/payment-logs`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | ADMIN/STAFF(ORDER_VIEW) | List all payment logs |
| GET | `/:id` | ADMIN/STAFF(ORDER_VIEW) | Get payment log by ID |

---

### REVIEWS MODULE — `/api/reviews`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin/all` | ADMIN | All reviews (admin) |
| DELETE | `/admin/:reviewId` | ADMIN | Admin delete any review |
| GET | `/my/:productId` | AUTH | Get own review for a product + eligibility check |
| POST | `/:productId` | AUTH | Submit review (must have delivered order for product) |
| PATCH | `/:reviewId` | AUTH | Edit own review |
| DELETE | `/:reviewId` | AUTH | Delete own review |
| GET | `/:productId` | Public/Optional | All reviews for a product |

---

### HOME BANNER MODULE — `/api/home-banners`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Public | Get active banners (homepage) |
| GET | `/homepage-config` | Public | Get homepage config |
| GET | `/admin` | ADMIN | All banners (admin) |
| PUT | `/discount-header` | ADMIN | Update discount header banner |
| PUT | `/carousel-header` | ADMIN | Update carousel header |
| PUT | `/featured-header` | ADMIN | Update featured header |
| PUT | `/promo-header` | ADMIN | Update promo header |
| GET | `/featured-products` | ADMIN | Get featured products list |
| PATCH | `/featured-products/:productId/toggle` | ADMIN | Toggle product as featured |
| PATCH | `/featured-products/:productId/order` | ADMIN | Set featured order position |
| POST | `/` | ADMIN | Create banner with image |
| PATCH | `/:id` | ADMIN | Update banner |
| DELETE | `/:id` | ADMIN | Delete banner |
| PATCH | `/:id/toggle` | ADMIN | Toggle banner active state |

---

### UTILITY ENDPOINTS

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | Public | Health check — returns `{ status: "ok", timestamp }` |

---

## 8. Database Documentation

The project uses a single **MongoDB** database. All collections are defined in `src/models/mongoose.ts`.

### Collections Overview

---

#### `users` Collection

**Purpose:** Stores all user accounts (CUSTOMER, ADMIN, SUPER_ADMIN, STAFF roles)

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | MongoDB auto-generated ID |
| `username` | String (required) | Display name |
| `email` | String (sparse unique) | Email address — optional (mobile users may not have email) |
| `phone` | String (unique, required) | Mobile number — primary identifier for mobile login |
| `password` | String | bcrypt-hashed password — missing for OAuth/mobile-only users |
| `role` | Enum: CUSTOMER/ADMIN/SUPER_ADMIN/STAFF | Access level |
| `isVerified` | Boolean (default false) | Email verification status |
| `refreshToken` | String | Current refresh token value (for revocation) |
| `avatar` | String | Cloudinary URL |
| `createdAt` | Date | Timestamps |
| `updatedAt` | Date | Timestamps |

**Indexes:** `role`
**Business Logic:** First signup creates ADMIN; all others are CUSTOMER. SUPER_ADMIN and STAFF are created by scripts/Admin.

---

#### `addresses` Collection

**Purpose:** Delivery addresses for users

| Field | Type | Description |
|-------|------|-------------|
| `userId` | ObjectId (ref: User) | Owner |
| `fullAddress` | String | Street address |
| `city` / `state` / `zipCode` / `country` | String | Location details |
| `landmark` | String (optional) | Delivery landmark |
| `isDefault` | Boolean | Only one default per user |
| `latitude` / `longitude` | Number | GPS coords for distance-based shipping |

**Indexes:** `userId`
**Business Logic:** Only the default address is used at checkout. GPS coordinates drive the Haversine shipping calculation.

---

#### `categories` Collection

**Purpose:** Product categories (top-level only, no subcategories)

| Field | Type | Description |
|-------|------|-------------|
| `code` | String (unique) | Short identifier (e.g., "TOPS") |
| `name` | String | Display name |
| `description` | String (optional) | Description |
| `image` | String | Cloudinary URL |
| `isActive` | Boolean | Hide/show category |

---

#### `products` Collection

**Purpose:** Product catalog

| Field | Type | Description |
|-------|------|-------------|
| `code` | String (unique) | SKU |
| `name` | String | Product name |
| `description` | String | Rich text description |
| `purchasePrice` | Number (optional) | Cost price — used only for profit analytics |
| `price` | Number (required) | Selling price in INR |
| `stock` | Number | Available inventory |
| `sizes` | [String] | Available sizes (e.g., ["S","M","L"]) |
| `discount` | Number | Discount percentage (display only — actual discount via coupons) |
| `image` | String | Primary Cloudinary URL |
| `images` | [String] | Gallery Cloudinary URLs |
| `rating` | Number | Average rating (computed field, updated on review) |
| `numReviews` | Number | Count of reviews |
| `isActive` | Boolean | Soft-delete flag |
| `isFeatured` | Boolean | Show on homepage featured section |
| `featuredOrder` | Number | Sort order in featured section |
| `categoryId` | ObjectId (ref: Category) | Parent category |

**Indexes:** `categoryId`, `name`, `price`, `isActive`, `isFeatured`

---

#### `categoryattributes` Collection

**Purpose:** Dynamic attributes per category (e.g., "Color", "Material" for a "Tops" category)

| Field | Type | Description |
|-------|------|-------------|
| `categoryId` | ObjectId (ref: Category) | Parent category |
| `name` | String | Attribute name |
| `type` | Enum: SELECT/MULTISELECT/TEXT/NUMBER/BOOLEAN | Input type |
| `isFilterable` | Boolean | Show as filter on shop page |
| `isRequired` | Boolean | Required when adding product |
| `sortOrder` | Number | Display order |

**Unique index:** `(categoryId, name)`

---

#### `categoryattributevalues` Collection

**Purpose:** Predefined options for SELECT/MULTISELECT attributes (e.g., "Red", "Blue" for Color)

| Field | Type | Description |
|-------|------|-------------|
| `attributeId` | ObjectId (ref: CategoryAttribute) | Parent attribute |
| `value` | String | Option value |
| `sortOrder` | Number | Display order |

**Unique index:** `(attributeId, value)`

---

#### `productattributevalues` Collection

**Purpose:** The actual attribute values assigned to a product

| Field | Type | Description |
|-------|------|-------------|
| `productId` | ObjectId (ref: Product) | Product |
| `attributeId` | ObjectId (ref: CategoryAttribute) | Which attribute |
| `attributeValueId` | ObjectId (ref: CategoryAttributeValue) | For SELECT types |
| `textValue` | String | For TEXT/NUMBER/BOOLEAN types |

---

#### `carts` Collection

**Purpose:** Shopping cart — one per user

| Field | Type | Description |
|-------|------|-------------|
| `userId` | ObjectId (unique, ref: User) | One cart per user |

---

#### `cartitems` Collection

**Purpose:** Individual items in a cart

| Field | Type | Description |
|-------|------|-------------|
| `cartId` | ObjectId (ref: Cart) | Parent cart |
| `productId` | ObjectId (ref: Product) | The product |
| `quantity` | Number | Quantity |

---

#### `orders` Collection

**Purpose:** Customer orders

| Field | Type | Description |
|-------|------|-------------|
| `userId` | ObjectId (ref: User) | Customer |
| `totalAmount` | Number | Subtotal before shipping/discount |
| `shippingCharge` | Number | Calculated shipping fee |
| `discountAmount` | Number | Coupon discount applied |
| `taxAmount` | Number | Tax (currently always 0) |
| `finalAmount` | Number | Amount charged to customer |
| `paymentMethod` | Enum: ONLINE/POD/CASH | How paid |
| `paymentStatus` | Enum: PENDING/PAID/FAILED/REFUNDED | Payment state |
| `orderStatus` | Enum: PROCESSING/CONFIRMED/SHIPPED/DELIVERED/CANCELLED | Fulfillment state |
| `razorpayOrderId` | String | Razorpay order reference |
| `razorpayPaymentId` | String | Razorpay payment reference (set after payment) |
| `razorpaySignature` | String | HMAC signature (verified server-side) |
| `shippingAddress` | Mixed | Snapshot of delivery address at order time |
| `couponId` | ObjectId (ref: Coupon) | Applied coupon |
| `placedByAdminId` | ObjectId (ref: User) | Set when admin places order on behalf of customer |

**Indexes:** `userId`, `orderStatus`, `createdAt`, `placedByAdminId`

---

#### `orderitems` Collection

| Field | Type | Description |
|-------|------|-------------|
| `orderId` | ObjectId (ref: Order) | Parent order |
| `productId` | ObjectId (ref: Product) | The product |
| `quantity` | Number | Quantity ordered |
| `price` | Number | Price at time of order (price snapshot) |

**Index:** `orderId`

---

#### `wishlists` Collection

| Field | Type | Description |
|-------|------|-------------|
| `userId` | ObjectId (ref: User) | Owner |
| `productId` | ObjectId (ref: Product) | Wishlisted product |

**Unique index:** `(userId, productId)` — prevents duplicates

---

#### `reviews` Collection

| Field | Type | Description |
|-------|------|-------------|
| `userId` | ObjectId (ref: User) | Reviewer |
| `productId` | ObjectId (ref: Product) | Reviewed product |
| `rating` | Number (1-5) | Star rating |
| `comment` | String | Review text |

**Unique index:** `(userId, productId)` — one review per user per product
**Index:** `productId`
**Business Logic:** Review creation checks that the user has a DELIVERED order containing the product (verified-purchase reviews only).

---

#### `notifications` Collection

| Field | Type | Description |
|-------|------|-------------|
| `message` | String | Notification text |
| `type` | Enum: NEW_ORDER/ORDER_UPDATE/PAYMENT_FAILED/PAYMENT_SUCCESS/LOW_STOCK/GENERAL | Category |
| `isRead` | Boolean | Read state |
| `orderId` | ObjectId (ref: Order) | Related order (optional) |
| `triggeredById` | ObjectId (ref: User) | Who caused this notification |
| `recipientId` | ObjectId (ref: User) | Who receives it (null = broadcast) |
| `recipientRole` | String | Role-based routing fallback |

**Indexes:** `recipientId`, `(recipientRole, isRead)`

---

#### `otps` Collection

**Purpose:** Temporary OTP storage (login, password reset, profile update)

| Field | Type | Description |
|-------|------|-------------|
| `email` | String | Target email |
| `otp` | String | 6-digit code |
| `purpose` | String | "login", "reset", "update" |
| `expiresAt` | Date | Expiry (5 minutes) |
| `used` | Boolean | Consumed flag |

**Index:** `(email, purpose)`
> **Note:** OTPs are deleted on use (not just marked used). The `used` field exists but deletion is the actual consumption mechanism.

---

#### `coupons` Collection

| Field | Type | Description |
|-------|------|-------------|
| `code` | String (unique) | Coupon code (case-sensitive) |
| `description` | String | Admin description |
| `discountType` | Enum: PERCENTAGE/FLAT | Discount calculation type |
| `discountValue` | Number | Amount (% or ₹) |
| `minOrderAmount` | Number | Minimum order subtotal to apply |
| `maxUses` | Number | Total usage limit (null = unlimited) |
| `usedCount` | Number | How many times used |
| `isActive` | Boolean | Enable/disable |
| `expiresAt` | Date | Expiry date (null = no expiry) |

---

#### `staffprofiles` Collection

| Field | Type | Description |
|-------|------|-------------|
| `userId` | ObjectId (unique, ref: User) | The staff user |
| `managedBy` | ObjectId (ref: User) | Admin who created them |
| `permissions` | [String] | Granted permissions |
| `isActive` | Boolean | Account active/inactive |
| `notes` | String | Admin notes |

**Index:** `managedBy`

---

#### `auditlogs` Collection

| Field | Type | Description |
|-------|------|-------------|
| `userId` | ObjectId (ref: User) | Who performed the action |
| `action` | String | Action code (e.g., "CREATE_COUPON") |
| `entity` | String | Resource type (e.g., "Coupon") |
| `entityId` | String | ID of affected entity |
| `details` | Mixed | Additional context (JSON) |
| `ipAddress` | String | Client IP |

**Indexes:** `userId`, `action`, `createdAt`

---

#### `featureflags` Collection

| Field | Type | Description |
|-------|------|-------------|
| `feature` | String (unique, enum) | Feature name |
| `isEnabled` | Boolean | Current state |

**Business Logic:** Only SUPER_ADMIN can toggle. SUPER_ADMIN is never blocked by feature gates. A missing row = feature is enabled (default-on).

---

#### `appsettings` Collection

**Purpose:** Key-value store for dynamic runtime configuration

| Key | Description |
|-----|-------------|
| `WAREHOUSE_LAT` | Warehouse GPS latitude |
| `WAREHOUSE_LNG` | Warehouse GPS longitude |
| `SHIPPING_SAME_STATE` | State name for local shipping (default: Kerala) |
| `SHIPPING_OTHER_STATE_FLAT` | Flat rate for other Indian states (₹150) |
| `SHIPPING_SAME_STATE_BASE` | Base local shipping rate (₹50) |
| `SHIPPING_SAME_STATE_PER_KM` | Per-km rate beyond threshold (₹5) |
| `SHIPPING_SAME_STATE_FREE_KM` | Distance threshold before per-km kicks in (10km) |
| `SHIPPING_MANUAL_FLAT` | Flat rate for manual (no GPS) addresses (₹50) |

---

#### `paymentlogs` Collection

**Purpose:** Immutable audit trail of all payment events

| Field | Type | Description |
|-------|------|-------------|
| `userId` | ObjectId (ref: User) | Customer |
| `orderId` | ObjectId (ref: Order) | Order |
| `amount` | Number | Amount |
| `event` | String | Event type (ORDER_CREATED, PAYMENT_VERIFIED, etc.) |
| `paymentStatus` | Enum | Payment status at time of event |
| `paymentMethod` | Enum | Method |
| `razorpayOrderId/PaymentId/Signature` | String | Razorpay references |
| `signatureValid` | Boolean/null | Signature verification result |
| `gatewayResponse` | Mixed | Raw Razorpay response |
| `ipAddress` | String | Client IP |

---

#### `homebanners` Collection

| Field | Type | Description |
|-------|------|-------------|
| `type` | String | Banner section type |
| `title` | String | Display title |
| `image` | String | Cloudinary URL |
| `link` | String | Click-through URL |
| `discount` | String | Discount label text |
| `isActive` | Boolean | Visibility |
| `sortOrder` | Number | Display order |

---

#### `customertrackers` Collection

| Field | Type | Description |
|-------|------|-------------|
| `userId` | ObjectId (ref: User) | Customer |
| `pagePath` | String | Page visited |
| `action` | String | Action performed |

---

#### `companysettings` Collection

**Purpose:** Store company info (name, logo, address, footer links, etc.)

---

#### `passwordresets` Collection

**Purpose:** Tracks verified password reset sessions (after OTP verification, before new password set)

---

### Entity Relationship Overview

```
User ─────┬──── Address (1:many)
          ├──── Cart (1:1) ────── CartItem (1:many) ──── Product
          ├──── Order (1:many) ── OrderItem (1:many) ─── Product
          ├──── Wishlist (1:many) ── Product
          ├──── Review (1:many) ── Product
          ├──── Notification (1:many)
          ├──── StaffProfile (1:1, STAFF users only)
          └──── AuditLog (1:many)

Category ─── Product (1:many)
         └── CategoryAttribute (1:many) ── CategoryAttributeValue (1:many)
                                       └── ProductAttributeValue ── Product

Order ── Coupon (many:1)
      └── PaymentLog (1:many)
```

---

## 9. Business Flows

### 9.1 User Registration Flow

```
1. Client: POST /api/auth/signup { username, email, phone, password }
2. Zod validates body (signupLimiter: 10/hr)
3. Check email uniqueness in User collection
4. Check phone uniqueness in User collection
5. bcrypt.hash(password, 10)
6. Check if any ADMIN exists:
   - No ADMIN → this user becomes ADMIN (shop owner)
   - ADMIN exists → role = CUSTOMER
7. User.create(...)
8. generateToken() → sets jwt + refreshToken HttpOnly cookies
9. Response 201 with user info
```

### 9.2 Login Flow (2-Step)

```
Step 1: POST /api/auth/login
1. loginLimiter (30/15min)
2. Zod validates { email, password }
3. User.findOne({ email })
4. bcrypt.compare(password, user.password)
5. Otp.deleteMany({ email }) — clear old OTPs
6. generateOtpCode() — 6 random digits
7. Otp.create({ email, otp, expiresAt: now+5min })
8. transporter.sendMail(otpEmailTemplate)
9. Response 200 { step: "VERIFY_OTP" }

Step 2: POST /api/auth/login/verify
1. loginLimiter
2. Zod validates { email, otp }
3. Otp.findOne({ email, otp })
4. Check expiresAt > now
5. Otp.findByIdAndDelete(otpRecord._id)
6. generateToken() → jwt + refreshToken cookies
7. Response 200 { role }
```

### 9.3 Online Payment Order Flow

```
1. Customer builds cart (POST /api/cart/add)
2. Customer reviews cart
3. POST /api/order/pre-checkout
   → Validate cart has stock-available items
   → Remove out-of-stock items automatically
4. Customer selects/saves delivery address
5. Customer optionally validates coupon (POST /api/coupon/validate)
6. POST /api/order/place { couponId? }
   → Server recalculates: subtotal, shipping (Haversine), coupon discount
   → Creates Razorpay order (razorpay.orders.create)
   → Creates Order in DB (status: PROCESSING, paymentStatus: PENDING)
   → Increments coupon.usedCount
   → Deducts product stock (atomic updateMany with stock >= qty check)
   → Creates PaymentLog (ORDER_CREATED event)
   → Sends socket notifications to admin + customer
   → Returns { order, rzpOrder, razorpay_key_id }
7. Client opens Razorpay checkout with razorpay_key_id + rzpOrder
8. Customer pays on Razorpay
9. POST /api/order/verifyPayment { razorpay_order_id, razorpay_payment_id, razorpay_signature }
   → HMAC-SHA256 signature verification (server-side)
   → On valid signature:
       - Order updated: paymentStatus=PAID, orderStatus=CONFIRMED
       - Cart cleared
       - PaymentLog created (PAYMENT_SUCCESS)
       - Order confirmation email sent to customer
       - Socket notifications to admin + customer
   → On invalid signature:
       - Order updated: paymentStatus=FAILED
       - Stock restored
       - PaymentLog created (PAYMENT_FAILED)
       - Failure notifications sent
```

### 9.4 Pay-on-Delivery Order Flow

```
POST /api/order/placeOrderPOD
1. Fetch cart + default address
2. Calculate shipping server-side
3. Validate coupon if provided
4. Create Order (paymentMethod=POD, paymentStatus=PENDING, orderStatus=PROCESSING)
5. Deduct stock
6. Clear cart
7. Create PaymentLog
8. Send notifications (admin + customer)
9. Send confirmation email
10. Return order
```

### 9.5 Order Status Update Flow

```
PUT /api/order/update/:id { orderStatus }
1. Auth: must be ADMIN or STAFF with ORDER_UPDATE permission
2. Feature gate: ORDER_MANAGEMENT
3. Validate status transition
4. Update Order.orderStatus
5. Create AuditLog entry
6. Send status update email to customer (orderStatusEmailTemplate)
7. Send socket notification to customer
8. Return updated order
```

### 9.6 Profile Update Flow (OTP-Protected)

```
POST /api/admin/adminProfile/request-update { email?, phone?, username? }
1. Validate new email/phone uniqueness
2. Generate OTP, store in Otp collection
3. Send OTP to current email
4. Store pending changes in TempUpdate collection

POST /api/admin/adminProfile/verify-update { otp }
1. Verify OTP from Otp collection
2. Retrieve pending changes from TempUpdate
3. Apply changes to User
4. Delete OTP + TempUpdate records
5. Return updated user
```

### 9.7 Real-Time Notification Flow

```
On order events (new order, payment, status change):
1. Controller calls notifyUsers(req, orderId, message, type, actorId, recipientIds)
2. For each recipientId:
   a. Notification.create({ message, orderId, type, triggeredById, recipientId })
   b. io.to(recipientId).emit("new-notification", notif)
      → Customer receives in their private room
      → Admin receives in their private room (and admin-room)
```

### 9.8 Shipping Calculation Flow

```
Customer submits address (GPS or manual):
1. If GPS coordinates: calculate Haversine distance from warehouse
   - Same city (Kerala, within threshold): base rate + per-km charge
   - Different Indian state: flat ₹150
   - International: flat ₹1500
   - No valid GPS (manual address): flat base rate ₹50
2. All rate constants come from AppSetting collection (DB-configurable)
3. Falls back to .env defaults if not configured in DB
```

### 9.9 Feature Flag Flow

```
Admin toggles feature:
  PATCH /api/super-admin/features/:feature { isEnabled: false }
  → SUPER_ADMIN only
  → Updates FeatureFlag.isEnabled in DB
  → Immediate effect on all subsequent requests

On protected routes:
  featureGate("FEATURE_NAME") middleware
  → SUPER_ADMIN: always passes
  → Others: checks FeatureFlag.isEnabled
  → false → 403 { message: "This feature has been disabled..." }
```

---

## 10. External Integrations

### 10.1 Razorpay (Payment Gateway)

- **SDK:** `razorpay` npm package
- **Config:** `src/config/razorpay.ts`
- **Usage:**
  - `razorpay.orders.create({ amount, currency, receipt })` — create payment intent
  - Signature verification: `HMAC-SHA256(razorpayOrderId|razorpayPaymentId, RAZORPAY_KEY_SECRET)`
- **Currency:** INR (amount in paise — multiply by 100)
- **Environment variables:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`

### 10.2 Cloudinary (Image Storage)

- **SDK:** `cloudinary` v1
- **Config:** `src/config/cloudinary.ts`
- **Usage:** `uploadToCloudinary(buffer, folder)` — uploads multer memory buffer to a folder
- **Deletion:** `deleteFromCloudinary(url)` — extracts public_id from URL and deletes
- **Environment variables:** `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- **Folders used:** `categories/`, `products/`, `avatars/`, `banners/`

### 10.3 Nodemailer / Gmail SMTP (Email)

- **Config:** `src/config/mailer.ts`
- **Emails sent:**
  - OTP verification (login, profile update)
  - Password reset OTP
  - Order confirmation
  - Order status update notifications
- **Environment variables:** `EMAIL_USER`, `EMAIL_PASS`
- **Note:** Uses Gmail SMTP. For production, should be replaced with a dedicated service (SendGrid, AWS SES) for reliability and deliverability.

### 10.4 MSG91 (Mobile OTP)

- **Purpose:** Mobile phone number verification via SMS OTP
- **Flow:** Frontend opens MSG91 widget → user enters phone + receives OTP via SMS → widget returns an `accessToken` → backend verifies `accessToken` against MSG91 API
- **Environment variables:** `MSG91_AUTH_KEY`, `MSG91_TOKEN_AUTH`, `MSG91_WIDGET_ID`

### 10.5 Socket.IO (Real-time)

- **Version:** 4.x
- **Transport:** WebSocket with polling fallback
- **Authentication:** JWT from cookie or `handshake.auth.token`
- **Rooms:**
  - `user.id` — private room for each user (personal notifications)
  - `admin-room` — shared room for all admins

---

## 11. Environment Configuration

All environment variables are validated at startup using Zod (`src/config/env.ts`). The app will **crash immediately with a clear error** if required variables are missing.

```env
# Server
NODE_ENV=development|production|test
PORT=5000
ALLOWED_ORIGINS=https://yourapp.com,https://www.yourapp.com

# Database
MONGO_URL=mongodb+srv://...   # or DATABASE_URL

# JWT
JWT_SECRET=<strong-random-secret>
REFRESH_TOKEN_SECRET=<strong-random-secret>

# Email
EMAIL_USER=your@gmail.com
EMAIL_PASS=your-app-password

# Cloudinary
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# Razorpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=

# MSG91 Mobile OTP (optional — default empty)
MSG91_AUTH_KEY=
MSG91_TOKEN_AUTH=
MSG91_WIDGET_ID=

# Warehouse (fallback — override via AppSetting DB records)
WAREHOUSE_LAT=9.9312
WAREHOUSE_LNG=76.2673
```

**Best Practice:** Never import `process.env` directly. Always use:
```typescript
import { env } from './config/env';
env.JWT_SECRET  // typed, validated at startup
```

---

## 12. Express.js Learning Guide (for Spring Boot / Python developers)

### 12.1 How Express Handles Requests

**Spring Boot:** Every incoming request is handled by a dispatcher servlet that routes to `@RestController` methods through a filter chain.

**Express:** Requests flow through a sequential **middleware stack**. Each function has the signature:
```typescript
(req: Request, res: Response, next: NextFunction) => void
```
Calling `next()` passes control to the next middleware. Not calling it stops the chain.

```typescript
// Spring Boot
@GetMapping("/products")
@PreAuthorize("hasRole('ADMIN')")
public ResponseEntity<List<Product>> getProducts() { ... }

// Express equivalent
router.get("/list",
  authMiddleware,      // ← filter 1: check JWT
  adminMiddleware,     // ← filter 2: check role
  productListController // ← the handler (like @GetMapping method)
);
```

### 12.2 Middleware Chaining vs. Interceptors

| Concept | Spring Boot | Express |
|---------|-------------|---------|
| Pre-processing | `HandlerInterceptor.preHandle()` | Middleware before controller |
| Post-processing | `HandlerInterceptor.postHandle()` | Middleware after controller (rare) |
| Exception handling | `@ControllerAdvice` | `errorHandler` (4-arg middleware, mounted last) |
| Method-level auth | `@PreAuthorize` | Middleware in route definition |
| Global filter | `SecurityFilterChain` | `app.use(middleware)` in server.ts |

### 12.3 Async Handling

**Python (Flask/FastAPI):** `async def` with `await`
**Spring Boot:** `@Async`, CompletableFuture, or reactive WebFlux
**Express (this project):** Native `async/await` with try/catch

```typescript
// All controllers are async functions
export const getProduct = async (req: Request, res: Response) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Not found" });
    res.json(product);
  } catch (err) {
    // In Express 5, unhandled rejections auto-call next(err)
    // But this project uses explicit try/catch throughout
    res.status(500).json({ message: "Server error" });
  }
};
```

### 12.4 Routing Structure

```typescript
// Spring Boot
@RestController
@RequestMapping("/api/products")
public class ProductController {
  @GetMapping("/{id}")
  public Product getById(@PathVariable String id) { ... }
}

// Express — routes and controllers are separate
// routes/product.routes.ts
router.get("/:id", authMiddleware, getProductById);

// controllers/product.controller.ts
export const getProductById = async (req, res) => {
  const product = await Product.findById(req.params.id); // :id → req.params.id
  res.json(product);
};
```

### 12.5 Request Data Access

| Data | Spring Boot | Express |
|------|-------------|---------|
| Path params (`/user/:id`) | `@PathVariable String id` | `req.params.id` |
| Query params (`?page=1`) | `@RequestParam int page` | `req.query.page` |
| Request body (JSON) | `@RequestBody UserDto dto` | `req.body` (after `express.json()`) |
| Headers | `@RequestHeader` | `req.headers['x-custom']` |
| Cookies | Spring Cookie / `@CookieValue` | `req.cookies.jwt` (after `cookieParser()`) |
| Uploaded files | `MultipartFile` | `req.file` / `req.files` (after multer) |

### 12.6 Dependency Injection Alternative

Express has **no built-in DI container**. Dependencies are handled by:
- **Module singletons:** `src/config/*.ts` files export singleton instances
- **Direct imports:** Controllers import models and config directly
- This is fine for this scale but for larger apps, consider `tsyringe` or `inversify`

```typescript
// Spring Boot
@Autowired
private ProductRepository productRepository;

// Express — just import
import { Product } from '../models/mongoose';
const product = await Product.findById(id);
```

### 12.7 Validation

| Spring Boot | Express (this project) |
|-------------|----------------------|
| `@Valid` + JSR-303 annotations on DTO | `validate(zodSchema)` middleware |
| `@NotNull`, `@Size`, `@Email` | `z.string().email()`, `z.string().min(8)` |
| `BindingResult` | Errors returned as 400 JSON automatically |
| Method-level validation | Middleware before controller in route |

```typescript
// Zod schema definition
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

// Route usage
router.post("/login", validate(loginSchema), loginController);
// validate() replaces req.body with the parsed, type-safe data
// Invalid body → 400 JSON with field-level errors automatically
```

### 12.8 Database Access

| Concept | Spring Boot (JPA) | Express (Mongoose) |
|---------|------------------|--------------------|
| Entity | `@Entity class Product` | `const ProductSchema = new Schema(...)` |
| Repository | `JpaRepository<Product, Long>` | `mongoose.model('Product', ProductSchema)` |
| Find by ID | `productRepo.findById(id)` | `Product.findById(id)` |
| Save | `productRepo.save(entity)` | `new Product(data).save()` or `Product.create(data)` |
| Update | `productRepo.save(updated)` | `Product.findByIdAndUpdate(id, data)` |
| Delete | `productRepo.deleteById(id)` | `Product.findByIdAndDelete(id)` |
| Query | `@Query("SELECT p FROM Product p WHERE...")` | `Product.find({ isActive: true, price: { $gte: 100 } })` |
| Relationships | `@OneToMany`, `@JoinColumn` | `populate('categoryId')` or the custom prisma adapter `include` |
| Transactions | `@Transactional` | **No built-in transactions** in this project (MongoDB multi-document transactions not used — see risks) |

### 12.9 Error Handling

```typescript
// Spring Boot: throw exception, @ControllerAdvice catches
throw new ResourceNotFoundException("Product not found");

// Express: throw AppError, errorHandler catches it
throw new AppError(404, "Product not found");

// Or call next(err) for async context
next(new AppError(404, "Product not found"));
```

### 12.10 Common Express Pitfalls (for Spring Boot devs)

1. **Middleware order matters.** Unlike Spring's `@Order`, Express processes middleware in the exact order they are registered. Register error handlers LAST.

2. **No automatic response.** You must always call `res.json()` or `res.send()`. Forgetting it causes the request to hang.

3. **`async` routes in Express 4 needed explicit error forwarding.** In Express 5 (used here), unhandled rejections are auto-forwarded. But the project uses explicit try/catch anyway.

4. **Route parameter order matters.** Specific routes (`/admin`, `/clear-all`) must come before wildcard routes (`/:id`). See `notification.routes.ts` comment.

5. **`req.user` doesn't exist by default.** It's added by the custom `express.d.ts` type augmentation and populated by `authMiddleware`.

6. **No session by default.** Express is stateless. This project uses JWT cookies instead of server-side sessions.

---

## 13. Code Quality & Architecture Analysis

### Strengths

- TypeScript throughout — good type safety
- Zod validation at all entry points — prevents garbage input
- Centralized error handling — consistent error responses
- Rate limiting on all sensitive endpoints
- HttpOnly JWT cookies — XSS-resistant auth
- HMAC signature verification for Razorpay payments
- Audit logging on admin actions
- Feature flags architecture — flexible feature rollout control
- Winston structured logging
- Environment validation at startup

### Issues and Technical Debt

#### Critical / High Priority

1. **Mixed ORM usage (Technical Debt)**
   - Some controllers use native Mongoose (`User.findOne()`)
   - Other controllers and ALL middleware use the custom `prisma` adapter (`prisma.user.findUnique()`)
   - The adapter itself is complex (~500 lines) and a custom wheel-reinvention
   - **Risk:** Bugs in the adapter could silently affect queries
   - **Fix:** Pick one approach and migrate. Either pure Mongoose everywhere, or proper Prisma ORM with a proper DB.

2. **No Database Transactions**
   - Order placement deducts stock, creates order, creates payment log in separate DB calls
   - If any step fails mid-way, data can be inconsistent (e.g., stock deducted but order not created)
   - **Fix:** Use MongoDB sessions + transactions for multi-step operations

3. **`featureGate` middleware references `prisma` but FeatureFlag is a Mongoose model**
   - The adapter handles this, but it's confusing and error-prone

4. **`helmet` and `compression` imported in package.json but NOT applied in server.ts**
   - Security headers (CSP, HSTS, X-Frame-Options, etc.) are missing in production
   - **Fix:** Add `app.use(helmet())` and `app.use(compression())` in server.ts

#### Medium Priority

5. **Business logic in controllers, not services**
   - `order.controller.ts` is ~600+ lines handling order placement, payment verification, stock management, notification fan-out, and email sending
   - This should be split into an `OrderService`, `NotificationService`, `StockService`

6. **No pagination on several list endpoints**
   - Some endpoints return all records without pagination (memory risk at scale)

7. **`taxAmount` field always 0**
   - Tax calculation is not implemented despite the field existing

8. **`Product.discount` field is UI-only**
   - Discount on the product model is for display purposes only; actual discounts are applied only via coupons at checkout. This is confusing.

9. **No input sanitization beyond Zod**
   - Zod validates shape but NoSQL injection via MongoDB operators in query strings is not explicitly guarded

10. **Console.log in socketManager.ts**
    - `console.log` instead of `logger.info` — logs won't go to Winston

11. **OTP security: plain text OTP stored in DB**
    - OTPs should ideally be hashed before storage (SHA-256) to prevent leakage from DB read access

12. **Two bcrypt packages: `bcrypt` and `bcryptjs`**
    - Both are in dependencies; only one should be used

#### Low Priority

13. **No API versioning (`/api/v1/...`)**
14. **No request ID / correlation ID for distributed tracing**
15. **No OpenAPI/Swagger definition** (swagger-jsdoc installed but not fully used)
16. **PM2 cluster mode not configured** — single-threaded in production

---

## 14. Deployment Notes

### PM2 Configuration (`ecosystem.config.js`)

The project includes a PM2 config for production deployment. Start with:
```bash
npm run build      # tsc → dist/
pm2 start ecosystem.config.js
```

### Build Process

```bash
npm install --include=dev
npx tsc           # outputs to dist/
node dist/server.js
```

### First-Time Setup

1. Copy `.env.example` to `.env` and fill all variables
2. Run MongoDB (local or Atlas)
3. Run seed scripts:
   ```bash
   npx tsx scripts/seedSuperAdmin.ts   # creates SUPER_ADMIN user
   npx tsx scripts/seedCategories.ts   # seeds initial categories
   ```
4. First `/api/auth/signup` call creates the ADMIN user (shop owner)

### Serving the Frontend

The server serves a built React app from the `client/` folder:
```
app.use(express.static(path.join(__dirname, '../client')));
app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, '../client', 'index.html'));
});
```
The React build must be placed in `client/` before starting the server.

---

## 15. Risks & Technical Debt

| Risk | Severity | Description |
|------|----------|-------------|
| No DB transactions | HIGH | Multi-step operations (order placement) can leave data in inconsistent state |
| `helmet` not applied | HIGH | Missing HTTP security headers in production (HSTS, CSP, X-Frame-Options, etc.) |
| Mixed ORM styles | MEDIUM | Custom prisma adapter + native Mongoose — maintenance risk |
| Business logic in controllers | MEDIUM | Thick controllers are hard to test and maintain |
| OTP stored in plaintext | MEDIUM | Database access reveals unencrypted OTPs |
| Gmail SMTP | MEDIUM | Unreliable for production transactional email; rate limits apply |
| No NoSQL injection guard | MEDIUM | Query string fields with `$` operators could be exploited |
| `taxAmount` always 0 | LOW | GST calculation unimplemented despite field |
| Duplicate bcrypt packages | LOW | Package bloat and potential inconsistency |
| No API versioning | LOW | Breaking changes require coordinated frontend update |
| `compression` not applied | LOW | Responses are not gzip-compressed |
| Console.log in Socket code | LOW | Logs bypass Winston |

---

## 16. Suggested Improvements

### Short-term (Next Sprint)

1. **Apply `helmet`:** Add `app.use(helmet())` to server.ts immediately
2. **Apply `compression`:** Add `app.use(compression())` to server.ts
3. **Remove duplicate bcrypt:** Keep only `bcryptjs` (pure JS, no native deps)
4. **Replace `console.log` with `logger`** in socketManager.ts and any remaining places
5. **Hash OTPs before storage** — store `SHA256(otp)` and compare with `SHA256(userInput)`

### Medium-term (Architecture)

6. **Introduce Service Layer:** Extract business logic from controllers
   ```
   controllers/ → thin (HTTP in/out)
   services/    → business logic, validation, orchestration
   models/      → pure Mongoose models
   ```
7. **Add MongoDB Transactions** for order placement and payment verification:
   ```typescript
   const session = await mongoose.startSession();
   session.startTransaction();
   try {
     await Order.create([...], { session });
     await deductStock(items, session);
     await session.commitTransaction();
   } catch {
     await session.abortTransaction();
   }
   ```
8. **Pick one ORM approach:** Either migrate fully to native Mongoose (simpler) or switch to PostgreSQL + actual Prisma ORM

### Long-term (Scalability)

9. **API versioning:** Prefix all routes with `/api/v1/`
10. **Redis for OTP/session caching** instead of MongoDB OTP collection
11. **Message queue** (BullMQ/RabbitMQ) for email sending — prevent blocking on order placement
12. **Replace Gmail SMTP** with SendGrid or AWS SES
13. **PM2 cluster mode** to utilize all CPU cores
14. **Health check endpoint enhancement** — add DB connectivity check to `/health`
15. **Add Request ID middleware** for distributed tracing
16. **Implement proper GST/tax calculation**

---

*Documentation generated from deep analysis of the complete codebase. Last updated: May 2026.*
