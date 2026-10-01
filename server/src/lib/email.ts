import { z } from "zod"

/** An address as both sign-ins take it. Matching is done on normalizeEmail's form. */
export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), "Enter a valid email address.")
