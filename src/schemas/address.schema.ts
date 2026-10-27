// src/schemas/address.schema.ts
import { z } from "zod";

export const addressSchema = z.object({
  fullAddress: z
    .string({ required_error: "Full address is required" })
    .min(5, "Address too short")
    .max(300, "Address too long")
    .trim(),
  city: z
    .string({ required_error: "City is required" })
    .min(1, "City cannot be empty")
    .max(100, "City too long")
    .trim(),
  state: z
    .string({ required_error: "State is required" })
    .min(1, "State cannot be empty")
    .max(100, "State too long")
    .trim(),
  zipCode: z
    .string({ required_error: "ZIP code is required" })
    .min(3, "ZIP code too short")
    .max(20, "ZIP code too long")
    .trim(),
  country: z.string().max(100).trim().default("India"),
  landmark: z.string().max(200).trim().optional(),
  locality: z.string().max(150).trim().optional(),
  secondaryPhone: z.string().max(20).trim().optional(),
  isDefault: z.boolean().optional().default(false),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const addressUpdateSchema = addressSchema.partial().extend({
  isDefault: z.boolean().optional(),
});
