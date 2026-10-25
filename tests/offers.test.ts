import { describe, expect, it } from "vitest";
import { rankDeals } from "../src/cli.js";
import type { Promotion, SearchResult } from "../src/index.js";
import { bestDeal } from "../src/offers.js";

const promo = (description: string, clubcard = true): Promotion => ({
  description,
  startDate: null,
  endDate: null,
  attributes: clubcard ? ["CLUBCARD_PRICING"] : [],
  priceAfterDiscount: null,
  priceBeforeDiscount: null,
});

describe("bestDeal", () => {
  it("reads a single-item Clubcard price", () => {
    expect(bestDeal(3.5, [promo("£2.80 Clubcard Price")])).toEqual({
      description: "£2.80 Clubcard Price",
      each: 2.8,
      buy: 1,
      saving: 0.7,
      clubcard: true,
    });
    expect(bestDeal(4, [promo("£3.00 Save 25% Clubcard Price")])?.each).toBe(3);
  });

  it("reads multi-buys", () => {
    const d = bestDeal(2.65, [promo("Any 2 for £4.50 Clubcard Price - Selected Cheese")]);
    expect(d).toMatchObject({ each: 2.25, buy: 2, saving: 0.4 });
    expect(bestDeal(1, [promo("3 for 75p", false)])).toMatchObject({ each: 0.25, buy: 3 });
  });

  it("reads buy-one-get-one-free and half price", () => {
    expect(bestDeal(3, [promo("Buy 1 Get 1 Free", false)])).toMatchObject({ each: 1.5, buy: 2 });
    expect(bestDeal(3, [promo("Buy 2 get 1 free", false)])).toMatchObject({ each: 2, buy: 3 });
    expect(bestDeal(5, [promo("Half Price", false)])).toMatchObject({ each: 2.5, buy: 1 });
  });

  it("skips offers that depend on another product or a meal deal", () => {
    expect(
      bestDeal(0.75, [promo("Buy 1 Dolmio Pasta Sauce and Save 75p on Tesco Pasta")]),
    ).toBeNull();
    expect(
      bestDeal(1.25, [promo("£3.85 Meal Deal Snack Clubcard Price - Selected Drink")]),
    ).toBeNull();
  });

  it("ignores offers that aren't cheaper and picks the best of several", () => {
    expect(bestDeal(3.5, [promo("£3.50 Clubcard Price")])).toBeNull();
    expect(bestDeal(null, [promo("£1.00 Clubcard Price")])).toBeNull();
    const d = bestDeal(3, [promo("£2.50 Clubcard Price"), promo("Any 2 for £4", false)]);
    expect(d).toMatchObject({ each: 2, buy: 2, clubcard: false });
  });
});

describe("rankDeals", () => {
  const result = (
    sku: string,
    price: number,
    unitPrice: number,
    offers: string[],
    available: boolean | null = true,
  ): SearchResult => ({
    sku,
    tpnb: null,
    title: sku,
    brand: null,
    imageUrl: null,
    price: { actual: price, unitPrice, unitOfMeasure: "kg" },
    quantityRules: {} as SearchResult["quantityRules"],
    available,
    onOffer: offers.length > 0,
    promotions: offers.map((o) => promo(o)),
  });

  it("keeps only priceable, available offers, cheapest unit price first", () => {
    const ranked = rankDeals([
      result("full-price", 1, 4, []),
      result("big-block", 5, 10, ["£4.00 Clubcard Price"]), // 8/kg after deal
      result("small-pack", 2, 8, ["Any 2 for £3"]), // 6/kg after deal
      result("sold-out", 1, 1, ["£0.50 Clubcard Price"], false),
    ]);
    expect(ranked.map((r) => [r.sku, r.dealUnitPrice])).toEqual([
      ["small-pack", "6/kg"],
      ["big-block", "8/kg"],
    ]);
  });
});
