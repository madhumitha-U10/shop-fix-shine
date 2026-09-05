/**
 * Seller-scoped mutations that persist to the Google Sheet through Apps Script.
 *
 * Every handler verifies (server-side) that the signed-in Supabase user owns
 * the seller record before writing. Nothing here trusts the browser.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { SHEETS_API_BASE_FALLBACK } from "@/lib/sheets-shared";

async function postToSheet(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const base = process.env["SHEETS_API_BASE"] ?? SHEETS_API_BASE_FALLBACK;
  const writeToken = process.env["SHEETS_WRITE_TOKEN"] ?? undefined;
  try {
    const res = await fetch(base, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(writeToken ? { ...body, token: writeToken } : body),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    try {
      const parsed = JSON.parse(text) as { success?: boolean; error?: string };
      return parsed.success ? { ok: true } : { ok: false, error: parsed.error ?? "Write rejected" };
    } catch {
      return { ok: false, error: "Backend has no doPost handler yet" };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const profileSchema = z.object({
  sellerId: z.string().min(1),
  businessName: z.string().max(120).optional(),
  tagline: z.string().max(200).optional(),
  about: z.string().max(2000).optional(),
  area: z.string().max(120).optional(),
  whatsapp: z.string().max(20).optional(),
  imageUrl: z.string().max(500).optional(),
});

/** Update the signed-in seller's own profile fields (no status/featured changes). */
export const sellerUpdateProfile = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => profileSchema.parse(data))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const { ownsSeller } = await import("@/lib/seller-authz.server");
    if (!(await ownsSeller(data.sellerId))) return { ok: false, error: "Unauthorized" };

    const row: Record<string, unknown> = { sellerId: data.sellerId };
    if (data.businessName !== undefined) row["name"] = data.businessName;
    if (data.tagline !== undefined) row["tagline"] = data.tagline;
    if (data.about !== undefined) row["description"] = data.about;
    if (data.area !== undefined) row["location"] = data.area;
    if (data.whatsapp !== undefined) {
      row["whatsapp"] = data.whatsapp;
      row["phone"] = data.whatsapp;
    }
    if (data.imageUrl !== undefined) row["imageUrl"] = data.imageUrl;

    if (Object.keys(row).length === 1) return { ok: true };
    return postToSheet({ action: "update", table: "sellers", data: row });
  });

/** Update a catalogue photo for a product the signed-in seller owns. */
export const sellerUpdateProductImage = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        sellerId: z.string().min(1),
        productId: z.string().min(1),
        imageUrl: z.string().max(500),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const { ownsSeller } = await import("@/lib/seller-authz.server");
    if (!(await ownsSeller(data.sellerId))) return { ok: false, error: "Unauthorized" };

    const { readTables } = await import("@/lib/sheets-cache.server");
    const { rows } = await readTables(["products"]);
    const match = (rows["products"] ?? []).find(
      (r) => String(r["productId"] ?? r["id"] ?? "") === data.productId,
    );
    // Unknown to the sheet yet (just created locally) — nothing to update.
    if (!match) return { ok: true };
    if (String(match["sellerId"] ?? "") !== data.sellerId) {
      return { ok: false, error: "Unauthorized" };
    }

    return postToSheet({
      action: "update",
      table: "products",
      data: { productId: data.productId, imageUrl: data.imageUrl },
    });
  });
