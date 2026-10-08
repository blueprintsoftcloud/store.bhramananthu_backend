import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User, PasswordReset } from "../models/mongoose";
import {
  generateOtpCode,
  otpEmailPayload,
  OTP_EXPIRY_MINUTES,
} from "../config/mailer";
import { env } from "../config/env";
import logger from "../utils/logger";
import { sendEmail } from "../services/email.service";

// POST /api/auth/forgot-password
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    // Normalize once — emails are matched/stored case-insensitively everywhere.
    const email: string | undefined = req.body.email ? String(req.body.email).trim().toLowerCase() : req.body.email;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res
        .status(404)
        .json({ message: "User with this email does not exist." });
    }

    const otpCode = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await prisma.otp.deleteMany({ where: { email, purpose: "passwordReset" } });
    await prisma.otp.create({
      data: { email, otp: otpCode, purpose: "passwordReset", expiresAt },
    });

    await sendEmail({
      to: email,
      ...otpEmailPayload(otpCode, "reset your password"),
    });

    res.status(200).json({ message: "OTP sent to your email." });
  } catch (err: any) {
    logger.error("forgotPassword error", err);
    res.status(500).json({ message: "Error sending OTP" });
  }
};

// POST /api/auth/verify-reset-otp
export const verifyResetOtp = async (req: Request, res: Response) => {
  try {
    const { otp } = req.body;
    const email: string | undefined = req.body.email ? String(req.body.email).trim().toLowerCase() : req.body.email;

    const otpRecord = await prisma.otp.findFirst({
      where: { email, otp, purpose: "passwordReset" },
    });

    if (!otpRecord || otpRecord.expiresAt < new Date()) {
      if (otpRecord) await prisma.otp.delete({ where: { id: otpRecord.id } });
      return res.status(400).json({ message: "Invalid or expired OTP." });
    }

    await prisma.otp.delete({ where: { id: otpRecord.id } });

    // Issue a short-lived reset token via cookie
    const resetToken = jwt.sign(
      { email, purpose: "password_reset" },
      env.JWT_SECRET,
      { expiresIn: "10m" },
    );

    const isHttps = Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
    const isSecure = env.NODE_ENV === "production" && isHttps;
    res.cookie("reset_token", resetToken, {
      maxAge: 10 * 60 * 1000,
      httpOnly: true,
      sameSite: (isSecure ? "none" : "lax") as "none" | "lax",
      secure: isSecure,
      path: "/",
    });

    res
      .status(200)
      .json({ message: "OTP Verified. You may now reset your password." });
  } catch (err: any) {
    logger.error("verifyResetOtp error", err);
    res.status(500).json({ message: "Error verifying OTP" });
  }
};

// POST /api/auth/reset-password
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { newPassword } = req.body;
    const resetToken = req.cookies.reset_token;

    if (!resetToken) {
      return res
        .status(401)
        .json({ message: "Unauthorized. Missing reset token." });
    }

    let decoded: { email: string; purpose: string };
    try {
      decoded = jwt.verify(resetToken, env.JWT_SECRET) as {
        email: string;
        purpose: string;
      };
    } catch {
      return res
        .status(401)
        .json({ message: "Invalid or expired reset token." });
    }

    if (decoded.purpose !== "password_reset") {
      return res.status(401).json({ message: "Invalid token type." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { email: decoded.email },
      data: { password: hashedPassword },
    });

    const isHttps = Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
    const isSecure = env.NODE_ENV === "production" && isHttps;
    res.clearCookie("reset_token", {
      httpOnly: true,
      sameSite: (isSecure ? "none" : "lax") as "none" | "lax",
      secure: isSecure,
      path: "/",
    });
    res
      .status(200)
      .json({ message: "Password reset successfully. You can now login." });
  } catch (err: any) {
    logger.error("resetPassword error", err);
    res.status(500).json({ message: "Error resetting password" });
  }
};
