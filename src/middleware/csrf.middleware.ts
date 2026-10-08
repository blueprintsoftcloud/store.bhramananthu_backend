// src/middleware/csrf.middleware.ts
//
// Double-submit-cookie CSRF protection. This app authenticates via an HttpOnly cookie
// (see auth.middleware.ts), which means any state-changing request the browser sends
// automatically carries valid credentials — including one triggered by a malicious
// third-party page the victim happens to have open. That's a classic CSRF hole, and
// prior to this middleware nothing in the stack closed it.
//
// Mechanism: `ensureCsrfCookie` stamps a random token into a non-HttpOnly `csrfToken`
// cookie on every response (so client-side JS can read it — see
// frontend/src/utils/csrf.ts). `csrfProtection` then requires that same value to be
// echoed back as an `X-CSRF-Token` header on any state-changing request. A
// cross-origin page can trigger the cookie to be sent automatically, but it cannot
// read the cookie's value (browsers enforce same-origin on cookie access) to also set
// the header — so a forged request fails this check even though it carries valid auth
// cookies.
//
// Scoped to authenticated requests only (checks for the presence of the `jwt` cookie):
// unauthenticated mutating routes (signup, login, forgot-password) have no ambient
// session for an attacker to ride, so there's nothing to protect there, and exempting
// them avoids any bootstrapping order-of-operations problem with the cookie.

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../config/env";

const COOKIE_NAME = "csrfToken";
const HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const cookieOptions = (req?: Request) => {
  const isHttps = req
    ? Boolean(req.secure || req.headers["x-forwarded-proto"] === "https")
    : false;
  const isSecure = env.NODE_ENV === "production" && isHttps;
  return {
    httpOnly: false, // must be readable by client-side JS to be echoed back as a header
    sameSite: (isSecure ? "none" : "lax") as "none" | "lax",
    secure: isSecure,
    path: "/",
  };
};

export const ensureCsrfCookie = (req: Request, res: Response, next: NextFunction) => {
  if (!req.cookies?.[COOKIE_NAME]) {
    const token = crypto.randomBytes(32).toString("hex");
    res.cookie(COOKIE_NAME, token, cookieOptions(req));
    // Make it visible to this same request too (in case csrfProtection runs later in
    // the same request/response cycle for some future route ordering change).
    req.cookies[COOKIE_NAME] = token;
  }
  next();
};

export const csrfProtection = (req: Request, res: Response, next: NextFunction) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.cookies?.jwt) return next(); // no ambient session to protect

  const cookieToken = req.cookies?.[COOKIE_NAME];
  const headerToken = req.headers[HEADER_NAME];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    res.status(403).json({ message: "CSRF token missing or invalid." });
    return;
  }
  next();
};
