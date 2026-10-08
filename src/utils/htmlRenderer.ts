// src/utils/htmlRenderer.ts
// Dynamically renders index.html with live branding & SEO metadata from the database
// so search engines (Googlebot, Bingbot) and social crawlers (WhatsApp, Facebook, Twitter)
// see real company name, logo, favicon, and SEO meta instead of hardcoded defaults.

import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { AppSetting } from "../models/mongoose";
import logger from "./logger";

interface BrandingSeoCache {
  companyName: string;
  companyTagline: string;
  companyLogo: string;
  companyFavicon: string;
  seoTitle: string;
  seoDescription: string;
  seoOgImage: string;
  seoKeywords: string;
  googleVerification: string;
  metaPixelId: string;
  cachedAt: number;
}

let memoryCache: BrandingSeoCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const invalidateHtmlBrandingCache = (): void => {
  memoryCache = null;
};

// Candidate paths where index.html may reside across dev, prod, and various deploy setups
const getCandidateIndexPaths = (): string[] => [
  path.join(__dirname, "../../client/index.html"),
  path.join(__dirname, "../client/index.html"),
  path.join(process.cwd(), "client/index.html"),
  path.join(process.cwd(), "dist/client/index.html"),
  path.join(process.cwd(), "backend/client/index.html"),
  path.join(process.cwd(), "../frontend/dist/index.html"),
  path.join(__dirname, "../../../frontend/dist/index.html"),
  path.join(__dirname, "../../frontend/dist/index.html"),
  path.join(__dirname, "../dist/index.html"),
  path.join(__dirname, "../index.html"),
];

let cachedRawHtml: string | null = null;
let resolvedIndexPath: string | null = null;

const getRawHtmlTemplate = (): string | null => {
  if (cachedRawHtml && process.env.NODE_ENV === "production") {
    return cachedRawHtml;
  }

  // Find existing index.html
  const candidates = getCandidateIndexPaths();
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      resolvedIndexPath = p;
      try {
        cachedRawHtml = fs.readFileSync(p, "utf-8");
        return cachedRawHtml;
      } catch (err) {
        logger.error(`Failed to read index.html from ${p}`, err);
      }
    }
  }

  return null;
};

const escapeHtmlAttr = (str: string): string => {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};

const escapeHtmlContent = (str: string): string => {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};

const fetchBrandingData = async (): Promise<BrandingSeoCache> => {
  const now = Date.now();
  if (memoryCache && now - memoryCache.cachedAt < CACHE_TTL_MS) {
    return memoryCache;
  }

  const defaultData: BrandingSeoCache = {
    companyName: "Bhramananthu Store",
    companyTagline: "Authentic Ayurvedic medicated oil for ear balance, vertigo, tinnitus, and insomnia relief by Panakkal Ayurveda.",
    companyLogo: "",
    companyFavicon: "/favicon.png",
    seoTitle: "Bhramananthu Store | Panakkal Ayurveda",
    seoDescription: "Authentic Ayurvedic medicated oil for ear balance, vertigo, tinnitus, and insomnia relief by Panakkal Ayurveda.",
    seoOgImage: "",
    seoKeywords: "Bhramananthu,Ayurveda,Ear Balance,Vertigo Oil,Tinnitus,Panakkal Ayurveda",
    googleVerification: "",
    metaPixelId: "",
    cachedAt: now,
  };

  try {
    const keys = [
      "COMPANY_NAME",
      "COMPANY_TAGLINE",
      "COMPANY_LOGO",
      "COMPANY_FAVICON",
      "SEO_HOME_TITLE",
      "SEO_HOME_DESCRIPTION",
      "SEO_DEFAULT_DESCRIPTION",
      "SEO_DEFAULT_OG_IMAGE",
      "SEO_KEYWORDS",
      "SEO_GOOGLE_SITE_VERIFICATION",
      "META_PIXEL_ID",
    ];

    const rows = (await AppSetting.find({ key: { $in: keys } }).lean()) || [];

    const map: Record<string, string> = {};
    for (const r of rows) {
      if (r.key && r.value) map[r.key] = r.value;
    }

    const data: BrandingSeoCache = {
      companyName: map["COMPANY_NAME"] || defaultData.companyName,
      companyTagline: map["COMPANY_TAGLINE"] || defaultData.companyTagline,
      companyLogo: map["COMPANY_LOGO"] || "",
      companyFavicon: map["COMPANY_FAVICON"] || defaultData.companyFavicon,
      seoTitle: map["SEO_HOME_TITLE"] || map["COMPANY_NAME"] || defaultData.companyName,
      seoDescription:
        map["SEO_HOME_DESCRIPTION"] ||
        map["SEO_DEFAULT_DESCRIPTION"] ||
        map["COMPANY_TAGLINE"] ||
        defaultData.companyTagline,
      seoOgImage: map["SEO_DEFAULT_OG_IMAGE"] || map["COMPANY_LOGO"] || "",
      seoKeywords: map["SEO_KEYWORDS"] || "",
      googleVerification: map["SEO_GOOGLE_SITE_VERIFICATION"] || "",
      metaPixelId: map["META_PIXEL_ID"] || "",
      cachedAt: now,
    };

    memoryCache = data;
    return data;
  } catch (err) {
    logger.warn("fetchBrandingData fallback to defaults", err);
    return defaultData;
  }
};

export const renderDynamicHtml = async (): Promise<string | null> => {
  const rawHtml = getRawHtmlTemplate();
  if (!rawHtml) return null;

  const data = await fetchBrandingData();

  const title = data.seoTitle || data.companyName;
  const description = data.seoDescription || data.companyTagline;
  const favicon = data.companyFavicon || "/vite.svg";
  const ogImage = data.seoOgImage || data.companyLogo;

  let html = rawHtml;

  // 1. Replace or inject <title>
  if (/<title>.*?<\/title>/i.test(html)) {
    html = html.replace(/<title>.*?<\/title>/i, `<title>${escapeHtmlContent(title)}</title>`);
  } else {
    html = html.replace("</head>", `  <title>${escapeHtmlContent(title)}</title>\n</head>`);
  }

  // 2. Replace or inject favicon link
  if (/<link[^>]*id=["']app-favicon["'][^>]*>/i.test(html)) {
    html = html.replace(
      /<link[^>]*id=["']app-favicon["'][^>]*>/i,
      `<link id="app-favicon" rel="icon" href="${escapeHtmlAttr(favicon)}" />`,
    );
  } else if (/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*>/i.test(html)) {
    html = html.replace(
      /<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*>/i,
      `<link id="app-favicon" rel="icon" href="${escapeHtmlAttr(favicon)}" />`,
    );
  } else {
    html = html.replace(
      "</head>",
      `  <link id="app-favicon" rel="icon" href="${escapeHtmlAttr(favicon)}" />\n</head>`,
    );
  }

  // 3. Replace or inject meta description
  if (/<meta[^>]*name=["']description["'][^>]*>/i.test(html)) {
    html = html.replace(
      /<meta[^>]*name=["']description["'][^>]*>/i,
      `<meta name="description" content="${escapeHtmlAttr(description)}" />`,
    );
  } else {
    html = html.replace(
      "</head>",
      `  <meta name="description" content="${escapeHtmlAttr(description)}" />\n</head>`,
    );
  }

  // 4. OpenGraph & Twitter Meta tags for search engines and social cards
  const extraMetas: string[] = [];

  // OpenGraph
  extraMetas.push(`<meta property="og:site_name" content="${escapeHtmlAttr(data.companyName)}" />`);
  extraMetas.push(`<meta property="og:title" content="${escapeHtmlAttr(title)}" />`);
  extraMetas.push(`<meta property="og:description" content="${escapeHtmlAttr(description)}" />`);
  if (ogImage) {
    extraMetas.push(`<meta property="og:image" content="${escapeHtmlAttr(ogImage)}" />`);
  }

  // Twitter Card
  extraMetas.push(`<meta name="twitter:card" content="summary_large_image" />`);
  extraMetas.push(`<meta name="twitter:title" content="${escapeHtmlAttr(title)}" />`);
  extraMetas.push(`<meta name="twitter:description" content="${escapeHtmlAttr(description)}" />`);
  if (ogImage) {
    extraMetas.push(`<meta name="twitter:image" content="${escapeHtmlAttr(ogImage)}" />`);
  }

  // Keywords
  if (data.seoKeywords) {
    extraMetas.push(`<meta name="keywords" content="${escapeHtmlAttr(data.seoKeywords)}" />`);
  }

  // Google Site Verification
  if (data.googleVerification) {
    extraMetas.push(`<meta name="google-site-verification" content="${escapeHtmlAttr(data.googleVerification)}" />`);
  }

  // Meta (Facebook) Pixel Base Code
  if (data.metaPixelId) {
    extraMetas.push(`<!-- Meta Pixel Base Code (Dynamic Injection) -->
    <script>
      !function(f,b,e,v,n,t,s)
      {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};
      if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
      n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t,s)}(window, document,'script',
      'https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', '${escapeHtmlAttr(data.metaPixelId)}');
      fbq('track', 'PageView');
    </script>
    <noscript><img height="1" width="1" style="display:none"
      src="https://www.facebook.com/tr?id=${escapeHtmlAttr(data.metaPixelId)}&ev=PageView&noscript=1"
    /></noscript>
    <!-- End Meta Pixel Base Code -->`);
  }

  // Google WebSite Schema for Site Name recognition
  if (data.companyName) {
    const siteSchema = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: data.companyName,
      alternateName: ["Bhramananthu", "store.bhramananthu.com", data.companyName],
      url: "https://store.bhramananthu.com",
    };
    extraMetas.push(`<script type="application/ld+json">${JSON.stringify(siteSchema)}</script>`);
  }

  const metaBlock = `\n    <!-- Server-Injected Dynamic Branding & SEO -->\n    ${extraMetas.join("\n    ")}\n`;

  // Inject metaBlock right before </head>
  html = html.replace("</head>", `${metaBlock}  </head>`);

  return html;
};

export const serveDynamicHtml = async (req: Request, res: Response): Promise<void> => {
  // If the request was for an asset that reached this catch-all, return a clean 404
  // so browsers don't try to parse HTML or JSON error responses as CSS/JS.
  if (
    req.path.startsWith("/assets/") ||
    /\.(js|css|map|png|jpg|jpeg|svg|ico|webp|woff|woff2|ttf)$/i.test(req.path)
  ) {
    res.status(404).type("text/plain").send("Asset not found");
    return;
  }

  // Prevent stale index.html caching on client devices so new deployments never white-screen
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  try {
    const rendered = await renderDynamicHtml();
    if (rendered) {
      res.status(200).type("html").send(rendered);
      return;
    }
  } catch (err) {
    logger.error("serveDynamicHtml error, falling back to static sendFile", err);
  }

  // Fallback to plain sendFile if rendering failed
  const candidates = getCandidateIndexPaths();
  const fallbackPath = resolvedIndexPath || candidates.find((p) => fs.existsSync(p));
  if (fallbackPath && fs.existsSync(fallbackPath)) {
    res.sendFile(fallbackPath);
  } else {
    res.status(404).type("text/plain").send("Application frontend not found.");
  }
};

export const getFaviconUrl = async (): Promise<string | null> => {
  const data = await fetchBrandingData();
  return data.companyFavicon || null;
};
