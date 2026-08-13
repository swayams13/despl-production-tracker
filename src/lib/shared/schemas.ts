import { z } from "zod";

/**
 * zod is the single source of validation truth — client and server import the
 * same schema (CLAUDE.md conventions).
 *
 * INVARIANT #1: no request schema in this file may ever contain an `actual_*`
 * or `*_at` field. Actual timestamps are set server-side from the database
 * clock. If you find yourself adding one here, the design is wrong.
 */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

export type LoginInput = z.infer<typeof loginSchema>;
