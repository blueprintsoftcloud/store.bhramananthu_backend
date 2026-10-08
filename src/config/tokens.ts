import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Response } from "express";
import { User } from "../models/index";
import { env } from "./env";

const generateRefreshTokenValue = () => crypto.randomBytes(32).toString("hex");

/**
 * Issues a fresh access/refresh token pair and sets both cookies.
 *
 * `family` identifies one continuous login session across refreshes — reuse-detection
 * (see auth.controller.ts's refreshTokens) depends on it never changing across a
 * rotation. Omit it on a genuine login/signup (starts a brand new family); pass the
 * existing family through on a refresh (rotates the token value but keeps the family).
 */
export const generateToken = async (
  user: { id: string; email: string; role: string },
  res: Response,
  family: string = crypto.randomUUID(),
): Promise<void> => {
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    env.JWT_SECRET,
    { expiresIn: "16m" },
  );

  const refreshTokenValue = generateRefreshTokenValue();
  const refreshToken = jwt.sign(
    { id: user.id, tokenValue: refreshTokenValue, family },
    env.REFRESH_TOKEN_SECRET,
    { expiresIn: "7d" },
  );

  // Store refresh token value + previous tokens (for multi-tab / in-flight concurrency grace period) + family in DB
  const currentUser = await User.findById(user.id);
  const now = new Date();
  const GRACE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes grace window

  // Filter existing recent tokens to keep only those within the grace window (keep up to last 20)
  const existingRecent = (currentUser?.previousRefreshTokens || [])
    .filter(
      (item) => item.token && now.getTime() - new Date(item.rotatedAt).getTime() < GRACE_WINDOW_MS,
    )
    .slice(-20);

  // If currentUser had a valid token that is rotating, record it
  if (currentUser?.refreshToken && currentUser.refreshToken !== refreshTokenValue) {
    existingRecent.push({
      token: currentUser.refreshToken,
      rotatedAt: now,
    });
  }

  await User.findByIdAndUpdate(user.id, {
    refreshToken: refreshTokenValue,
    previousRefreshToken: currentUser?.refreshToken || null,
    previousRefreshTokens: existingRecent,
    refreshTokenFamily: family,
    lastRotatedAt: now,
  });

  // In production (HTTPS) use sameSite:"none" + secure:true.
  // In development (plain HTTP over LAN/localhost) use sameSite:"lax" + secure:false
  // so mobile/desktop browsers accept the cookie without dropping it.
  const req = (res as any).req;
  const isHttps = req
    ? Boolean(req.secure || req.headers["x-forwarded-proto"] === "https")
    : false;
  const isSecure = env.NODE_ENV === "production" && isHttps;
  const cookieOpts = {
    httpOnly: true,
    sameSite: (isSecure ? "none" : "lax") as "none" | "lax",
    secure: isSecure,
  };

  // Purge any stale cookies that may have been stored under non-root paths in
  // older sessions. Browsers treat same-name cookies with different Path values
  // as distinct entries, so we must explicitly clear each stale path.
  // Known stale path: /api/auth/refresh (from an older deployment).
  for (const stalePath of ["/api/auth/refresh", "/api/auth", "/api"]) {
    res.clearCookie("jwt",          { ...cookieOpts, path: stalePath });
    res.clearCookie("refreshToken", { ...cookieOpts, path: stalePath });
  }

  res.cookie("jwt", accessToken, {
    maxAge: 16 * 60 * 1000, // 16 min
    ...cookieOpts,
    path: "/",
  });

  res.cookie("refreshToken", refreshToken, {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    ...cookieOpts,
    path: "/",
  });
};
