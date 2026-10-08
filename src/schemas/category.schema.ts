// src/schemas/category.schema.ts
import { z } from "zod";

// Absent = "not being changed" (categoryUpdate) / "top-level" (categoryAdd). "" is
// treated the same as absent — both are valid since these submit as multipart/form-data,
// where an omitted field never round-trips as `undefined` on every client the same way.
const parentIdField = z
  .union([z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid parent category id"), z.literal("")])
  .optional()
  .nullable();

export const categoryAddSchema = z
  .object({
    // Required for a top-level category (shown as its card badge), but a subcategory
    // is never shown to customers as its own tile — its code is just internal
    // bookkeeping the backend generates silently, so the client isn't asked for one
    // at all (see AddCategoryModal.tsx / categoryAdd's resolvedCode fallback).
    code: z
      .union([z.string().max(50, "Code too long").trim(), z.literal("")])
      .optional(),
    name: z
      .string({ required_error: "Category name is required" })
      .min(1, "Name cannot be empty")
      .max(100, "Name too long")
      .trim(),
    description: z.string().max(500, "Description too long").trim().optional(),
    parentId: parentIdField,
    showFilters: z.union([z.boolean(), z.string().transform((v) => v === "true" || v === "1")]).optional(),
  })
  .refine((data) => data.parentId || (data.code && data.code.length > 0), {
    message: "Category code is required",
    path: ["code"],
  });

export const categoryUpdateSchema = z.object({
  code: z.string().min(1).max(50).trim().optional(),
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).trim().optional(),
  parentId: parentIdField,
  showFilters: z.union([z.boolean(), z.string().transform((v) => v === "true" || v === "1")]).optional(),
});
