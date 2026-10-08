// src/schemas/product.schema.ts
import { z } from "zod";

export const productAddSchema = z.object({
  code: z
    .string({ required_error: "Product code is required" })
    .min(1, "Code cannot be empty")
    .max(50, "Code too long")
    .trim(),
  name: z
    .string({ required_error: "Product name is required" })
    .min(1, "Name cannot be empty")
    .max(200, "Name too long")
    .trim(),
  description: z.string().max(50000, "Description too long").trim().optional(),
  brand: z.string().max(100, "Brand too long").trim().optional(),
  // Optional per-product SEO overrides — fall back to name/description on the frontend
  // when unset, so filling these in is never required.
  metaTitle: z.string().max(70, "Meta title too long").trim().optional(),
  metaDescription: z.string().max(160, "Meta description too long").trim().optional(),
  purchasePrice: z
    .union([z.string(), z.number()])
    .transform((v) => parseFloat(String(v)))
    .refine((v) => !isNaN(v) && v >= 0, "Purchase price must be a non-negative number")
    .optional(),
  price: z
    .union([z.string(), z.number()])
    .transform((v) => parseFloat(String(v)))
    .refine((v) => !isNaN(v) && v >= 0, "Price must be a non-negative number"),
  category: z
    .string({ required_error: "Category ID is required" })
    .min(1, "Category is required"),
  stock: z
    .union([z.string(), z.number()])
    .transform((v) => parseInt(String(v), 10))
    .optional()
    .default(0),
  sizes: z.any().optional(),
  discount: z
    .union([z.string(), z.number()])
    .transform((v) => (v === "" ? 0 : parseFloat(String(v))))
    .refine((v) => !isNaN(v) && v >= 0 && v <= 100, "Discount must be between 0 and 100")
    .optional()
    .default(0),
  // JSON-stringified AttrEntry[] (multipart fields are always strings) — the
  // controller does its own JSON.parse + shape validation, same as `sizes` above.
  // Without a schema entry here, Zod's default "strip unknown keys" behavior on
  // .safeParse() silently deleted this field before productAdd ever saw it.
  attributeValues: z.any().optional(),
});

export const productUpdateSchema = z.object({
  code: z.string().min(1).max(50).trim().optional(),
  name: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(50000, "Description too long").trim().optional(),
  brand: z.string().max(100).trim().optional(),
  metaTitle: z.string().max(70, "Meta title too long").trim().optional(),
  metaDescription: z.string().max(160, "Meta description too long").trim().optional(),
  purchasePrice: z
    .union([z.string(), z.number()])
    .transform((v) => parseFloat(String(v)))
    .refine((v) => !isNaN(v) && v >= 0, "Purchase price must be a non-negative number")
    .optional(),
  price: z
    .union([z.string(), z.number()])
    .transform((v) => parseFloat(String(v)))
    .refine((v) => !isNaN(v) && v >= 0, "Price must be a non-negative number")
    .optional(),
  category: z.string().min(1).optional(),
  stock: z
    .union([z.string(), z.number()])
    .transform((v) => parseInt(String(v), 10))
    .refine((v) => !isNaN(v) && v >= 0, "Stock must be a non-negative integer")
    .optional(),
  sizes: z.any().optional(),
  discount: z
    .union([z.string(), z.number()])
    .transform((v) => (v === "" ? 0 : parseFloat(String(v))))
    .refine((v) => !isNaN(v) && v >= 0 && v <= 100, "Discount must be between 0 and 100")
    .optional(),
  // Same reasoning as productAddSchema's attributeValues above — both are
  // JSON-stringified and parsed by the controller, not by this schema.
  attributeValues: z.any().optional(),
  removeImages: z.any().optional(),
});
