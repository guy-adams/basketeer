/**
 * Turn Tesco promotion descriptions into a comparable per-item price.
 *
 * Tesco's `price.afterDiscount` is unreliable (it often just echoes the shelf
 * price), so the deal is read from the human description instead, e.g.
 * "£2.80 Clubcard Price", "Any 2 for £4.50 Clubcard Price - ...",
 * "Buy 1 Get 1 Free", "Half Price". Offers that depend on another product
 * ("Buy 1 X and Save 75p on Y") or on a meal deal can't be priced per item and
 * are skipped.
 */

import type { Promotion } from "./models.js";

export interface Deal {
  /** The promotion text, as Tesco shows it. */
  description: string;
  /** Effective price of one item when the offer is taken up. */
  each: number;
  /** How many items must be bought to get that price (multi-buys > 1). */
  buy: number;
  /** Saving per item versus the shelf price. */
  saving: number;
  /** True if the offer needs a Clubcard. */
  clubcard: boolean;
}

const MONEY = String.raw`(?:£(\d+(?:\.\d{1,2})?)|(\d+)p)`;

function money(pounds: string | undefined, pence: string | undefined): number {
  return pounds !== undefined ? Number(pounds) : Number(pence) / 100;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Per-item terms of one promotion, or null if it can't be priced per item. */
function terms(desc: string, price: number): { each: number; buy: number } | null {
  const d = desc.trim();
  if (/meal deal/i.test(d)) return null;
  // Conditional on buying something else, e.g. "Buy 1 Dolmio ... and Save 75p on Tesco Pasta".
  if (/\band save\b.*\bon\b/i.test(d)) return null;

  let m = d.match(new RegExp(String.raw`^(?:any\s+)?(\d+)\s+for\s+${MONEY}`, "i"));
  if (m) {
    const n = Number(m[1]);
    return n > 0 ? { each: money(m[2], m[3]) / n, buy: n } : null;
  }

  m = d.match(/^buy\s+(\d+)\s+get\s+(\d+)\s+free/i);
  if (m) {
    const pay = Number(m[1]);
    const total = pay + Number(m[2]);
    return { each: (price * pay) / total, buy: total };
  }

  if (/^(?:half|1\/2)\s+price/i.test(d)) return { each: price / 2, buy: 1 };

  m = d.match(new RegExp(String.raw`^${MONEY}(?:\s|$)`, "i"));
  if (m) return { each: money(m[1], m[2]), buy: 1 };

  m = d.match(new RegExp(String.raw`^save\s+${MONEY}`, "i"));
  if (m) return { each: price - money(m[1], m[2]), buy: 1 };

  return null;
}

/** The best per-item deal among a product's promotions, or null if none can be priced. */
export function bestDeal(price: number | null, promotions: Promotion[]): Deal | null {
  if (price == null || !(price > 0)) return null;
  let best: Deal | null = null;
  for (const p of promotions) {
    const t = terms(p.description, price);
    if (!t || !(t.each > 0) || t.each >= price) continue;
    const deal: Deal = {
      description: p.description,
      each: round2(t.each),
      buy: t.buy,
      saving: round2(price - t.each),
      clubcard: p.attributes.includes("CLUBCARD_PRICING") || /clubcard/i.test(p.description),
    };
    if (!best || deal.each < best.each) best = deal;
  }
  return best;
}
