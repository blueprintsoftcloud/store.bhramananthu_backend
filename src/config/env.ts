// src/config/env.ts
// Validates ALL environment variables at startup using Zod.
// The app will exit immediately with a clear error if any required variable is missing.
// Import { env } instead of process.env throughout the app.

import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Always load .env from the project root.
// In source this is ../../.env, and in compiled dist this is also ../../.env.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

 console.log(".env loads");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.string().default("5000"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),

  // Database — MONGO_URL is the only var Mongoose reads (see config/database.ts).
  MONGO_URL: z.string().min(1, "MONGO_URL is required"),

  // JWT
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  REFRESH_TOKEN_SECRET: z
    .string()
    .min(1, "REFRESH_TOKEN_SECRET is required")
    .default("mysecretkey123_refresh"),

  // System alert recipient — the health monitor's "[System Alert]" emails go here.
  // (Previously also the SMTP account address; email now sends via MSG91, see below.)
  EMAIL_USER: z.string().default("unaiznoushad105@gmail.com"),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().min(1, "CLOUDINARY_CLOUD_NAME is required"),
  CLOUDINARY_API_KEY: z.string().min(1, "CLOUDINARY_API_KEY is required"),
  CLOUDINARY_API_SECRET: z.string().min(1, "CLOUDINARY_API_SECRET is required"),

  // Razorpay — storefront e-commerce checkout
  RAZORPAY_KEY_ID: z.string().min(1, "RAZORPAY_KEY_ID is required"),
  RAZORPAY_KEY_SECRET: z.string().min(1, "RAZORPAY_KEY_SECRET is required"),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(""),

  // MSG91 Mobile OTP (SMS widget) — MSG91_AUTH_KEY is the account-wide key, also
  // used to authenticate the Email API calls below.
  MSG91_AUTH_KEY: z.string().default(""),
  MSG91_TOKEN_AUTH: z.string().default(""),
  MSG91_WIDGET_ID: z.string().default(""),

  // MSG91 Email API — replaces the old SMTP/nodemailer transport for every
  // transactional email (OTP, order confirmation, order status, system alerts).
  // MSG91_EMAIL_DOMAIN must be a domain verified in MSG91's Email dashboard, and
  // MSG91_EMAIL_FROM must be an address on that domain. Each MSG91_TEMPLATE_*
  // is the id of a template created in MSG91's dashboard (Email > Templates) with
  // {{variable}} placeholders matching what config/mailer.ts's payload builders
  // send — see that file's per-template variable list. Left blank, sendEmail()
  // logs a warning and no-ops instead of failing the request (see config/msg91Email.ts).
  MSG91_EMAIL_DOMAIN: z.string().default(""),
  MSG91_EMAIL_FROM: z.string().default(""),
  MSG91_EMAIL_FROM_NAME: z.string().default("blueprint_crm"),
  MSG91_TEMPLATE_OTP: z.string().default(""),
  MSG91_TEMPLATE_ORDER_CONFIRMATION: z.string().default(""),
  MSG91_TEMPLATE_ORDER_STATUS: z.string().default(""),
  MSG91_TEMPLATE_HEALTH_ALERT: z.string().default(""),

  // Shipping
  WAREHOUSE_LAT: z.string().default("9.9312"),
  WAREHOUSE_LNG: z.string().default("76.2673"),

  // Background job / inventory alert config
  LOW_STOCK_THRESHOLD: z.string().default("5"),

  // Backup / disaster recovery (see docs/DISASTER_RECOVERY.md)
  BACKUP_DIR: z.string().default("./backups"),
  BACKUP_RETENTION_COUNT: z.string().default("14"),

  // CSRF — secret used to sign the double-submit CSRF cookie/token pair.
  CSRF_SECRET: z.string().default("dev_csrf_secret_change_me"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("\n❌ Invalid or missing environment variables:\n");
  const errors = parsed.error.flatten().fieldErrors;
  Object.entries(errors).forEach(([key, messages]) => {
    console.error(`  ${key}: ${messages?.join(", ")}`);
  });
  console.error("\nCreate a .env file based on .env.example and restart.\n");
  process.exit(1);
}

export const env = parsed.data;
