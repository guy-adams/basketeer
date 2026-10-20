/**
 * In-process tools for the voice agent: BBC Good Food recipes, a local store of
 * the user's Tesco order history, "my usuals" analysis, and bulk basket adds.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BrowserAuthBackend } from "../dist/auth/browser/playwright.js";
import { Basketeer, FileTokenStore, MAX_HISTORY_PAGE_SIZE } from "../dist/index.js";

const HISTORY_PATH =
  process.env.ORDER_HISTORY_PATH ?? join(homedir(), ".basketeer", "order-history.json");
const RESYNC_AFTER_MS = 6 * 60 * 60 * 1000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const fail = (e: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: `${(e as Error).name ?? "Error"}: ${(e as Error).message ?? e}`,
    },
  ],
  isError: true,
});
const guard =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

// ---------- Tesco client (one per server, so its 1 req/s throttle is shared) ----------

let clientPromise: Promise<Basketeer> | undefined;
const tesco = () => {
  clientPromise ??= Basketeer.resume({
    store: new FileTokenStore(),
    authBackend: new BrowserAuthBackend(),
  });
  return clientPromise.catch((e) => {
    clientPromise = undefined;
    throw e;
  });
};

// ---------- order history store ----------

interface StoredItem {
  sku: string;
  title: string;
  quantity: number;
  unit: string | null;
}
interface StoredOrder {
  orderNo: string;
  date: string | null;
  total: number | null;
  items: StoredItem[];
}
interface HistoryFile {
  syncedAt: string | null;
  orders: Record<string, StoredOrder>;
}

async function loadHistory(): Promise<HistoryFile> {
  try {
    return JSON.parse(await readFile(HISTORY_PATH, "utf8"));
  } catch {
    return { syncedAt: null, orders: {} };
  }
}

/** Pull completed orders newest-first until a page holds only orders we already have. */
async function syncHistory(force = false) {
  const history = await loadHistory();
  if (!force && history.syncedAt && Date.now() - Date.parse(history.syncedAt) < RESYNC_AFTER_MS)
    return { history, added: 0 };
  const client = await tesco();
  let offset: number | null = 0;
  let added = 0;
  while (offset !== null) {
    const page = await client.orders.history({ offset, limit: MAX_HISTORY_PAGE_SIZE });
    let newOnPage = 0;
    for (const o of page.orders) {
      if (history.orders[o.id]) continue;
      newOnPage++;
      history.orders[o.id] = {
        orderNo: o.orderNo,
        date: o.slot?.start ?? null,
        total: o.totalPrice,
        items: o.items
          .filter((it) => it.productId)
          .map((it) => ({
            sku: it.productId!,
            title: it.title,
            quantity: it.quantity,
            unit: it.unit,
          })),
      };
    }
    added += newOnPage;
    // Pages are newest-first, so once a whole page is already known the rest is too.
    offset = newOnPage === 0 ? null : page.nextOffset;
  }
  history.syncedAt = new Date().toISOString();
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 1));
  return { history, added };
}

const ordersSince = (h: HistoryFile, months: number) => {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return Object.values(h.orders).filter((o) => o.date && new Date(o.date) >= cutoff);
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function analyseUsuals(orders: StoredOrder[], minShare: number) {
  // With very little history, one appearance is the best signal we have.
  const minOrders = orders.length >= 3 ? 2 : 1;
  const bySku = new Map<
    string,
    { title: string; unit: string | null; qty: number[]; dates: string[] }
  >();
  for (const o of orders) {
    for (const it of o.items) {
      const e = bySku.get(it.sku) ?? { title: it.title, unit: it.unit, qty: [], dates: [] };
      e.qty.push(it.quantity);
      e.dates.push(o.date!);
      bySku.set(it.sku, e);
    }
  }
  const total = orders.length;
  return [...bySku.entries()]
    .map(([sku, e]) => {
      const dates = e.dates.sort();
      const span = (Date.parse(dates.at(-1)!) - Date.parse(dates[0])) / 86_400_000;
      return {
        sku,
        title: e.title,
        ordersWith: e.dates.length,
        share: Math.round((e.dates.length / total) * 100) / 100,
        typicalQuantity: median(e.qty),
        unit: e.unit,
        everyDays: e.dates.length > 1 ? Math.round(span / (e.dates.length - 1)) : null,
        lastBought: dates.at(-1)!.slice(0, 10),
      };
    })
    .filter((u) => u.ordersWith >= minOrders && u.share >= minShare)
    .sort((a, b) => b.share - a.share);
}

// ---------- BBC Good Food ----------

async function getHtml(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!r.ok) throw new Error(`BBC Good Food returned ${r.status}`);
  return r.text();
}

async function searchRecipes(query: string) {
  const html = await getHtml(`https://www.bbcgoodfood.com/search?q=${encodeURIComponent(query)}`);
  const seen = new Set<string>();
  const results = [];
  // Search cards are embedded as JSON objects starting {"title":"…", each with postType and url.
  for (const chunk of html.split('{"title":"').slice(1)) {
    if (!chunk.includes('"postType":"recipe"')) continue;
    const url = chunk.match(/"url":"(https:\/\/www\.bbcgoodfood\.com\/recipes\/[a-z0-9-]+)"/)?.[1];
    if (!url || seen.has(url) || /\/recipes\/(collection|category)\//.test(url)) continue;
    seen.add(url);
    const rating = chunk.match(/"ratingValue":([\d.]+),"ratingCount":(\d+)/);
    results.push({
      title: JSON.parse(`"${chunk.slice(0, chunk.indexOf('"'))}"`),
      url,
      rating: rating ? Number(rating[1]) : null,
      ratings: rating ? Number(rating[2]) : 0,
      time: chunk.match(/"slug":"time","display":"([^"]+)"/)?.[1] ?? null,
      premium: chunk.includes('"isPremium":true'),
    });
    if (results.length >= 8) break;
  }
  return results;
}

async function getRecipe(url: string) {
  if (!/^https:\/\/www\.bbcgoodfood\.com\/recipes\//.test(url))
    throw new Error("Only bbcgoodfood.com recipe URLs");
  const html = await getHtml(url);
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const nodes = ([] as any[]).concat(data, (data as any)?.["@graph"] ?? []);
    const recipe = nodes.find((n) => n && [].concat(n["@type"]).includes("Recipe" as never));
    if (recipe)
      return {
        name: recipe.name,
        serves: recipe.recipeYield,
        prepTime: recipe.prepTime,
        cookTime: recipe.cookTime,
        totalTime: recipe.totalTime,
        rating: recipe.aggregateRating?.ratingValue ?? null,
        ingredients: recipe.recipeIngredient,
      };
  }
  throw new Error("No recipe data found on that page");
}

// ---------- the MCP server ----------

export const shoppingTools = createSdkMcpServer({
  name: "shop",
  version: "0.1.0",
  tools: [
    tool(
      "recipe_search",
      "Search BBC Good Food for recipes. Returns title, url, rating, number of ratings, time, and whether it's premium (paywalled).",
      { query: z.string().describe("e.g. 'chicken tikka masala'") },
      guard(({ query }) => searchRecipes(query)),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "recipe_get",
      "Fetch a BBC Good Food recipe by url: name, servings, times, and the ingredient list.",
      { url: z.string().url() },
      guard(({ url }) => getRecipe(url)),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "usual_items",
      "Analyse the user's stored Tesco order history (synced automatically) and return the products they buy regularly: sku, title, ordersWith, share (fraction of orders containing it), typicalQuantity, unit, everyDays (average gap), lastBought.",
      {
        months: z.number().int().min(1).max(36).default(6).describe("Look-back window in months."),
        minShare: z
          .number()
          .min(0)
          .max(1)
          .default(0.25)
          .describe("Minimum fraction of orders an item must appear in to count as regular."),
      },
      guard(async ({ months, minShare }) => {
        const { history } = await syncHistory();
        const orders = ordersSince(history, months);
        if (!orders.length)
          return { ordersAnalysed: 0, usuals: [], note: "No orders in that window." };
        const storedTotal = Object.keys(history.orders).length;
        return {
          ordersAnalysed: orders.length,
          storedOrdersTotal: storedTotal,
          from: orders
            .map((o) => o.date!)
            .sort()[0]
            .slice(0, 10),
          note:
            orders.length < 3
              ? `Only ${orders.length} order(s) in this window, so items from any of them count. ${storedTotal} orders stored in total; a longer window may give a better picture.`
              : undefined,
          usuals: analyseUsuals(orders, minShare),
        };
      }),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "purchase_history",
      "Search the stored order history for products whose title contains the text, e.g. to answer 'which bread do I usually get?' or 'when did I last buy coffee?'. Returns matching products with times bought and last date.",
      { text: z.string(), months: z.number().int().min(1).max(36).default(12) },
      guard(async ({ text, months }) => {
        const { history } = await syncHistory();
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = new Map<
          string,
          { sku: string; title: string; times: number; lastBought: string }
        >();
        for (const o of ordersSince(history, months))
          for (const it of o.items) {
            if (!words.every((w) => it.title.toLowerCase().includes(w))) continue;
            const h = hits.get(it.sku) ?? {
              sku: it.sku,
              title: it.title,
              times: 0,
              lastBought: "",
            };
            h.times++;
            if (o.date! > h.lastBought) h.lastBought = o.date!.slice(0, 10);
            hits.set(it.sku, h);
          }
        return [...hits.values()].sort((a, b) => b.times - a.times).slice(0, 15);
      }),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "sync_orders",
      "Force a refresh of the stored order history from Tesco. Normally not needed; usual_items and purchase_history sync automatically.",
      {},
      guard(async () => {
        const { history, added } = await syncHistory(true);
        return { storedOrders: Object.keys(history.orders).length, newOrders: added };
      }),
    ),
    tool(
      "basket_add_many",
      "Add several products in one go (one Tesco request). Each line is brought UP TO the given quantity: lines already in the basket at that quantity or more are left alone. Returns what was added, skipped, and unavailable, plus the new basket total.",
      {
        items: z
          .array(
            z.object({
              sku: z.string(),
              title: z.string().describe("For the summary only."),
              quantity: z.number().positive(),
              unit: z
                .string()
                .nullish()
                .describe("Unit from usual_items, e.g. 'pcs' or 'kg'. Default pcs."),
            }),
          )
          .min(1),
      },
      guard(async ({ items }) => {
        const client = await tesco();
        const current = new Map((await client.basket.get()).items.map((l) => [l.sku, l.quantity]));
        const toAdd = items.filter((it) => (current.get(it.sku) ?? 0) < it.quantity);
        const alreadyIn = items.filter((it) => !toAdd.includes(it)).map((it) => it.title);
        if (!toAdd.length) return { added: [], alreadyIn, unavailable: [], rejected: [] };
        const { basket, rejected, unavailable } = await client.basket.update(
          toAdd.map((it) => ({
            id: it.sku,
            newValue: it.quantity,
            newUnitChoice: it.unit ?? "pcs",
          })),
        );
        const title = (sku: string) => items.find((it) => it.sku === sku)?.title ?? sku;
        const bad = new Set([...rejected, ...unavailable]);
        return {
          added: toAdd.filter((it) => !bad.has(it.sku)).map((it) => `${it.quantity} x ${it.title}`),
          alreadyIn,
          unavailable: unavailable.map(title),
          rejected: rejected.map(title),
          basketTotal: basket.guidePrice,
          basketLines: basket.items.length,
        };
      }),
    ),
  ],
});
