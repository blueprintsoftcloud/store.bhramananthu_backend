import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User, Otp, StaffProfile } from "../models/mongoose";
import { generateToken } from "../config/tokens";
import {
  generateOtpCode,
  otpEmailPayload,
  OTP_EXPIRY_MINUTES,
} from "../config/mailer";
import { env } from "../config/env";
import logger from "../utils/logger";
import { sendEmail } from "../services/email.service";

// POST /api/auth/signup
export const signup = async (req: Request, res: Response) => {
  try {
    const { username, phone, password } = req.body;
    // Emails are matched/stored case-insensitively everywhere in this app — normalize
    // once at the boundary so "Foo@Gmail.com" and "foo@gmail.com" are always the same
    // account instead of silently becoming two.
    const email: string | undefined = req.body.email ? String(req.body.email).trim().toLowerCase() : undefined;

    const emailExists = email
      ? await User.findOne({ email })
      : null;
    if (emailExists) {
      return res.status(400).json({ Error: "An account with this email address already exists." });
    }
    const phoneExists = phone
      ? await User.findOne({ phone: String(phone) })
      : null;
    if (phoneExists) {
      return res.status(400).json({ Error: "An account with this phone number already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Architecture: 1 SUPER_ADMIN (seeded only) + N ADMIN (partners running the same
    // business) + N CUSTOMERS.
    // - SUPER_ADMIN is never created via signup; the seed script is the only path.
    // - First signup becomes ADMIN.
    // - Every subsequent signup is CUSTOMER.
    const adminExists = await User.findOne({ role: "ADMIN" });
    const role = adminExists ? "CUSTOMER" : "ADMIN";

    const user = await User.create({
      username,
      email,
      phone: String(phone),
      password: hashedPassword,
      role,
    });

    await generateToken(
      { id: user.id, email: user.email ?? "", role: user.role },
      res,
    );

    return res.status(201).json({
      message:
        role === "ADMIN"
          ? "Admin User created successfully"
          : "User created successfully",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err: any) {
    logger.error("signup error", err);
    if (err?.code === "P2002") {
      const field = err?.meta?.target?.includes("email") ? "email address" : "phone number";
      return res.status(400).json({ Error: `An account with this ${field} already exists.` });
    }
    return res
      .status(500)
      .json({ Error: "Server error", details: err.message });
  }
};

// POST /api/auth/login  — Step 1: validate credentials, send OTP
export const login = async (req: Request, res: Response) => {
  try {
    const { password } = req.body;
    const email: string | undefined = req.body.email ? String(req.body.email).trim().toLowerCase() : undefined;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "No account registered with this email" });

    if (!user.password) {
      return res.status(400).json({ message: "This account uses mobile OTP login. Please sign in with your mobile number." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Password is incorrect" });

    // ── Subscription barrier removed (admins can login unconditionally)

    // ── Staff Active Status Barrier (shift-left)
    if (user.role === 'STAFF') {
      const staffProfile = await StaffProfile.findOne({ userId: user._id });
      
      // If the profile doesn't exist or isActive is false, block them instantly
      if (!staffProfile || staffProfile.isActive === false) {
        return res.status(403).json({
          message: 'Your account has been deactivated. Please contact your administrator for access.',
        });
      }
    }

    // Clear old OTPs, create new
    await Otp.deleteMany({ email });
    const otpCode = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await Otp.create({ email, otp: otpCode, expiresAt });

    await sendEmail({
      to: email,
      ...otpEmailPayload(otpCode, "log in to your account"),
    });

    return res.status(200).json({
      message: "Credentials verified. OTP sent to your email.",
      step: "VERIFY_OTP",
      email,
    });
  } catch (err: any) {
    logger.error("login error", err);
    return res
      .status(500)
      .json({ error: "Error occurred", details: err.message });
  }
};

// POST /api/auth/verify-otp  — Step 2: verify OTP, issue tokens
export const verifyLoginOtp = async (req: Request, res: Response) => {
  try {
    const { otp } = req.body;
    const email: string | undefined = req.body.email ? String(req.body.email).trim().toLowerCase() : undefined;

    const otpRecord = await Otp.findOne({ email, otp });

    if (!otpRecord) {
      return res.status(401).json({ message: "Invalid or expired OTP." });
    }

    // Check expiry
    if (otpRecord.expiresAt && otpRecord.expiresAt < new Date()) {
      await Otp.findByIdAndDelete(otpRecord._id);
      return res
        .status(401)
        .json({ message: "OTP has expired. Please request a new one." });
    }

    // Consume OTP
    await Otp.findByIdAndDelete(otpRecord._id);

    const user = await User.findOne({ email });
    if (!user)
      return res.status(400).json({ message: "User record not found." });

    await generateToken(
      {
        id: user.id,
        email: user.email ?? "",
        role: user.role,
      },
      res,
    );

    return res.status(200).json({
      message: "Logged in successfully",
      role: user.role,
    });
  } catch (err: any) {
    logger.error("verifyLoginOtp error", err);
    return res
      .status(500)
      .json({ message: "Server error during verification." });
  }
};

// POST /api/auth/resend-otp
export const resendOtp = async (req: Request, res: Response) => {
  try {
    const email: string | undefined = req.body.email ? String(req.body.email).trim().toLowerCase() : undefined;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await User.findOne({ email });
    // Generic response to avoid email enumeration
    if (!user)
      return res
        .status(200)
        .json({ message: "If registered, OTP has been sent." });

    await Otp.deleteMany({ email });
    const otpCode = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await Otp.create({ email, otp: otpCode, expiresAt });

    await sendEmail({
      to: email,
      ...otpEmailPayload(otpCode, "log in to your account"),
    });

    return res
      .status(200)
      .json({ message: "New verification code sent to your email.", email });
  } catch (err: any) {
    logger.error("resendOtp error", err);
    return res
      .status(500)
      .json({ error: "Error occurred during resend", details: err.message });
  }
};

// Helper — clears both cookies on all paths they may have been previously set under.
const clearAuthCookies = (res: Response) => {
  const req = (res as any).req;
  const isHttps = req
    ? Boolean(req.secure || req.headers["x-forwarded-proto"] === "https")
    : false;
  const isSecure = env.NODE_ENV === "production" && isHttps;
  const opts = { httpOnly: true, sameSite: (isSecure ? "none" : "lax") as "none" | "lax", secure: isSecure };
  // Always clear the canonical root path.
  res.clearCookie("jwt",          { ...opts, path: "/" });
  res.clearCookie("refreshToken", { ...opts, path: "/" });
  // Also clear any stale paths that may have been written by older deployments.
  for (const stalePath of ["/api/auth/refresh", "/api/auth", "/api"]) {
    res.clearCookie("jwt",          { ...opts, path: stalePath });
    res.clearCookie("refreshToken", { ...opts, path: stalePath });
  }
};

// POST /api/auth/logout
export const logout = async (req: Request, res: Response) => {
  // Always clear cookies first — user is logged out regardless of DB outcome.
  clearAuthCookies(res);

  try {
    // Identify the user so we can revoke their refresh token in the DB.
    // The route has no authMiddleware (to avoid a refresh-loop on forced logout),
    // so we resolve the user id directly from the access token or refresh token cookies.
    //   • Valid token   → jwt.verify succeeds → use decoded id
    //   • Expired token → jwt.verify throws TokenExpiredError → jwt.decode gives us the id
    //   • No / tampered → skip DB cleanup (cookies already cleared above)
    let userId: string | undefined = req.user?.id;

    if (!userId) {
      const token = req.cookies?.jwt as string | undefined;
      if (token) {
        try {
          const verified = jwt.verify(token, env.JWT_SECRET) as { id: string };
          userId = verified.id;
        } catch {
          // Token expired or otherwise unverifiable — still extract the payload
          // for DB cleanup only (no privilege is granted from this).
          const decoded = jwt.decode(token) as { id?: string } | null;
          userId = decoded?.id;
        }
      }
    }

    // Layer 2 Fallback: Resolve userId from the refreshToken cookie itself
    if (!userId) {
      const refreshToken = req.cookies?.refreshToken as string | undefined;
      if (refreshToken) {
        try {
          const verified = jwt.verify(refreshToken, env.REFRESH_TOKEN_SECRET) as { id: string };
          userId = verified.id;
        } catch {
          const decoded = jwt.decode(refreshToken) as { id?: string } | null;
          userId = decoded?.id;
        }
      }
    }

    if (userId) {
      await User.findByIdAndUpdate(userId, {
        refreshToken: null,
        previousRefreshToken: null,
        refreshTokenFamily: null,
        lastRotatedAt: null,
      });
    }

    return res.status(200).json({ message: "Logout Successful" });
  } catch (err: any) {
    logger.error("logout error", err);
    // Don't expose internal errors — cookies are already cleared so the user
    // is effectively logged out even if the DB update failed.
    return res.status(200).json({ message: "Logout Successful" });
  }
};

// POST /api/auth/refresh
export const refreshTokens = async (req: Request, res: Response) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ message: "Refresh token not provided." });
  }

  try {
    const decoded = jwt.verify(refreshToken, env.REFRESH_TOKEN_SECRET) as {
      id: string;
      tokenValue: string;
      family?: string;
    };

    const user = await User.findById(decoded.id);

    if (!user) {
      clearAuthCookies(res);
      return res.status(403).json({ message: "Invalid or revoked refresh token." });
    }

    const now = Date.now();
    const GRACE_WINDOW_MS = 15 * 60 * 1000; // 15-minute grace window for in-flight requests / multi-tab synchronization

    const isCurrentToken = user.refreshToken === decoded.tokenValue;

    // Check recent rotated tokens array
    const recentTokens = user.previousRefreshTokens || [];
    const isInRecentTokens = recentTokens.some(
      (item) =>
        item.token === decoded.tokenValue &&
        now - new Date(item.rotatedAt).getTime() < GRACE_WINDOW_MS,
    );

    // Fallback check for single legacy field
    const isLegacyGraceToken =
      !!user.previousRefreshToken &&
      user.previousRefreshToken === decoded.tokenValue &&
      decoded.family === user.refreshTokenFamily &&
      !!user.lastRotatedAt &&
      now - new Date(user.lastRotatedAt).getTime() < GRACE_WINDOW_MS;

    const isGracePeriodToken = isInRecentTokens || isLegacyGraceToken;

    if (!isCurrentToken && !isGracePeriodToken) {
      logger.warn("Refresh token invalid or expired outside grace period", {
        userId: user.id,
        family: decoded.family,
        ip: req.ip,
      });
      clearAuthCookies(res);
      return res.status(403).json({
        message: "Invalid or expired session. Please log in again.",
      });
    }

    // Strict Access Revocation Check for Staff
    if (user.role === "STAFF") {
      const staffProfile = await StaffProfile.findOne({ userId: user._id }).lean();

      if (!staffProfile || staffProfile.isActive === false) {
        clearAuthCookies(res);
        logger.warn(`Refresh blocked: Deactivated staff member attempted token refresh`, { userId: user._id });
        return res
          .status(403)
          .json({ message: "Your account has been deactivated. Please contact your administrator." });
      }
    }

    await generateToken(
      {
        id: user.id,
        email: user.email ?? "",
        role: user.role,
      },
      res,
      decoded.family, // keep rotating within the same session family
    );

    return res
      .status(200)
      .json({ message: "Access token refreshed successfully.", isLoggedIn: true, role: user.role });
  } catch {
    clearAuthCookies(res);
    return res
      .status(403)
      .json({
        message: "Invalid or expired refresh token. Please log in again.",
      });
  }
};

// ─── MSG91 Mobile OTP ─────────────────────────────────────────────────────────
// The MSG91 Widget send/verify OTP calls must be made from the browser.
// This server only calls verifyAccessToken — the one server-side allowed endpoint.
const MSG91_AUTH_KEY = env.MSG91_AUTH_KEY;

/** Shared helper: verify a MSG91 widget access token server-side with 12s timeout. */
const verifyMsg91Token = async (
  accessToken: string,
): Promise<{ ok: boolean; status?: number; body?: Record<string, unknown> }> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(
      "https://control.msg91.com/api/v5/widget/verifyAccessToken",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authkey: MSG91_AUTH_KEY, "access-token": accessToken }),
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);
    const rawText = await resp.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawText); } catch { body = { raw: rawText }; }
    return { ok: resp.ok && body.type === "success", status: resp.status, body };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const e = err as Error;
    if (e?.name === "AbortError" || controller.signal.aborted) {
      logger.error("verifyMsg91Token: timeout verifying token with MSG91 gateway");
      return { ok: false, status: 504, body: { message: "MSG91 verification gateway timeout" } };
    }
    throw err;
  }
};

// POST /api/auth/mobile/login
// OTP was already verified browser-side via MSG91 Widget.
// Backend re-validates the access token, then logs in the existing customer.
// Returns 404 if no account exists — frontend should guide user to sign up.
export const mobileLogin = async (req: Request, res: Response) => {
  const { phone, accessToken } = req.body as { phone: string; accessToken: string };

  try {
    logger.info("mobileLogin: verifying token", { phone: phone.trim() });
    let result: Awaited<ReturnType<typeof verifyMsg91Token>>;
    try {
      result = await verifyMsg91Token(accessToken);
    } catch (fetchErr) {
      const e = fetchErr as Error;
      logger.error("mobileLogin verifyMsg91Token threw", { message: e?.message });
      return res.status(502).json({ message: "Could not verify OTP token. Please try again." });
    }

    if (!result.ok) {
      logger.error("mobileLogin: MSG91 rejected token", result);
      return res.status(401).json({ message: "OTP verification failed. Please try again." });
    }

    // Find the customer — must already exist
    const user = await User.findOne({ phone: phone.trim() });
    if (!user) {
      return res.status(404).json({
        message: "No account found with this number. Please sign up first.",
        code: "NO_ACCOUNT",
      });
    }

    await generateToken({ id: user.id, email: user.email ?? "", role: user.role }, res);
    return res.status(200).json({
      message: "Login successful.",
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err: unknown) {
    const e = err as Error;
    logger.error("mobileLogin error", { message: e?.message, stack: e?.stack });
    return res.status(500).json({ message: "Server error." });
  }
};

// POST /api/auth/mobile/register
// Register a new customer after their phone is verified via MSG91 Widget OTP.
// Requires: name (required), email (optional), phone, accessToken.
export const registerCustomer = async (req: Request, res: Response) => {
  const { name, email, phone, accessToken } = req.body as {
    name: string;
    email?: string;
    phone: string;
    accessToken: string;
  };

  try {
    logger.info("registerCustomer: verifying token", { phone: phone.trim() });
    let result: Awaited<ReturnType<typeof verifyMsg91Token>>;
    try {
      result = await verifyMsg91Token(accessToken);
    } catch (fetchErr) {
      const e = fetchErr as Error;
      logger.error("registerCustomer verifyMsg91Token threw", { message: e?.message });
      return res.status(502).json({ message: "Could not verify OTP token. Please try again." });
    }

    if (!result.ok) {
      return res.status(401).json({ message: "OTP verification failed. Please try again." });
    }

    // Check for duplicate phone or email — specific per field
    const phoneExists = await User.findOne({ phone: phone.trim() });
    if (phoneExists) {
      return res.status(409).json({
        message: "An account with this phone number already exists. Please sign in.",
        code: "DUPLICATE",
      });
    }
    if (email?.trim()) {
      const emailExists = await User.findOne({ email: email.trim().toLowerCase() });
      if (emailExists) {
        return res.status(409).json({
          message: "An account with this email address already exists. Please sign in with a different email.",
          code: "DUPLICATE",
        });
      }
    }

    const user = await User.create({
      username: name.trim(),
      email: email?.trim().toLowerCase() || null,
      phone: phone.trim(),
      role: "CUSTOMER",
    });

    await generateToken(
      { id: user.id, email: user.email ?? "", role: user.role },
      res,
    );
    logger.info("registerCustomer: created user", { id: user.id });
    return res.status(201).json({
      message: "Account created successfully. Welcome!",
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err: unknown) {
    const e = err as Error;
    logger.error("registerCustomer error", { message: e?.message, stack: e?.stack });
    return res.status(500).json({ message: "Server error." });
  }
};

// POST /api/auth/mobile/check-phone
// Called before sending OTP on the Sign In screen.
// Returns 200 if the phone is a registered CUSTOMER/STAFF, 403 if it belongs to
// an admin/superadmin (who must use email/password login), 404 if not found.
export const checkPhoneExists = async (req: Request, res: Response) => {
  const { phone } = req.body as { phone: string };
  try {
    const user = await User.findOne({ phone: phone.trim() });
    if (!user) {
      return res.status(404).json({
        message: "No account found with this number. Please sign up first.",
        code: "NO_ACCOUNT",
      });
    }
    // Block admin / superadmin from using the customer OTP flow
    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      return res.status(403).json({
        message: "This account cannot be accessed via phone login. Please use the Admin Portal.",
        code: "ADMIN_ROLE",
      });
    }
    return res.status(200).json({ exists: true });
  } catch (err: unknown) {
    const e = err as Error;
    logger.error("checkPhoneExists error", { message: e?.message });
    return res.status(500).json({ message: "Server error." });
  }
};

// GET /api/auth/mobile/widget-config
// Exposes client-side public MSG91 widget configuration to the browser
export const getMsg91WidgetConfig = async (_req: Request, res: Response) => {
  return res.status(200).json({
    widgetId: env.MSG91_WIDGET_ID || "",
    tokenAuth: env.MSG91_TOKEN_AUTH || "",
  });
};


