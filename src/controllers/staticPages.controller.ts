import { Request, Response } from "express";
import logger from "../utils/logger";
import { createAuditLog } from "../utils/auditLog";

const DEFAULT_ABOUT = {
  title: "About Us",
  body: "Welcome to our store! We are dedicated to bringing you the best products with top-quality service.\n\nOur mission is to provide an exceptional shopping experience with carefully curated collections, prompt support, and seamless delivery.",
};

const DEFAULT_TERMS = {
  title: "Terms & Conditions",
  body: "Welcome to our store. By accessing or using our website, you agree to comply with and be bound by these terms and conditions.\n\nAll orders placed on our store are subject to product availability and confirmation of order price.\n\nWe reserve the right to modify these terms at any time without prior notice.",
};

const DEFAULT_HELP = {
  title: "Help Center",
  faqs: [
    {
      question: "How do I track my order?",
      answer: "You can track your order using the 'Track Order' option in the navigation bar or from your Orders page.",
    },
    {
      question: "What payment methods do you accept?",
      answer: "We accept UPI (Google Pay, PhonePe, Paytm), Credit/Debit Cards, Net Banking, and Cash on Delivery (where applicable).",
    },
    {
      question: "What is your return policy?",
      answer: "We accept returns within 7 days of delivery for eligible items in their original condition and packaging.",
    },
    {
      question: "How can I contact support?",
      answer: "You can reach out to us through our Contact Us page or by emailing our support team.",
    },
  ],
};

const PAGE_KEY_MAP: Record<string, string> = {
  about: "PAGE_ABOUT",
  terms: "PAGE_TERMS",
  help: "PAGE_HELP",
};

const parseJsonOrDefault = <T>(value: string | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/**
 * GET /api/pages
 * Public endpoint to fetch content for About, Terms, and Help pages.
 */
export const getStaticPages = async (_req: Request, res: Response) => {
  try {
    const rows = (await prisma.appSetting.findMany({
      where: {
        key: { in: ["PAGE_ABOUT", "PAGE_TERMS", "PAGE_HELP"] },
      },
    })) || [];

    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }

    const about = parseJsonOrDefault(map["PAGE_ABOUT"], DEFAULT_ABOUT);
    const terms = parseJsonOrDefault(map["PAGE_TERMS"], DEFAULT_TERMS);
    const help = parseJsonOrDefault(map["PAGE_HELP"], DEFAULT_HELP);

    res.status(200).json({
      about,
      terms,
      help,
    });
  } catch (err: any) {
    logger.error("getStaticPages error", err);
    res.status(500).json({ message: "Error fetching static pages content" });
  }
};

/**
 * PUT /api/pages/:page
 * Admin/Staff endpoint to update a static page (about, terms, help).
 */
export const updateStaticPage = async (req: Request, res: Response) => {
  try {
    const pageParam = Array.isArray(req.params.page) ? req.params.page[0] : req.params.page;
    const pageKey = pageParam?.toLowerCase() || "";
    const settingKey = PAGE_KEY_MAP[pageKey];

    if (!settingKey) {
      return res.status(400).json({ message: `Invalid page identifier: ${pageParam}. Valid options: about, terms, help` });
    }

    const content = req.body;
    if (!content || typeof content !== "object") {
      return res.status(400).json({ message: "Invalid page content provided" });
    }

    const jsonValue = JSON.stringify(content);

    await prisma.appSetting.upsert({
      where: { key: settingKey },
      update: { value: jsonValue },
      create: { key: settingKey, value: jsonValue },
    });

    await createAuditLog({
      req,
      action: "UPDATE_STATIC_PAGE",
      entity: "Page",
      entityId: settingKey,
      details: { page: pageKey, content },
    });

    res.status(200).json({
      message: `${pageKey} page updated successfully`,
      page: pageKey,
      content,
    });
  } catch (err: any) {
    logger.error("updateStaticPage error", err);
    res.status(500).json({ message: "Error updating static page" });
  }
};
