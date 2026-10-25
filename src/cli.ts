#!/usr/bin/env node

/**
 * `basketeer` — a thin CLI over the basketeer SDK.
 *
 * Reads work anonymously; writes (basket / slots / orders / checkout) resume a
 * persisted session via {@link FileTokenStore} and, for `login`, mint one with
 * {@link BrowserAuthBackend}. Results print as JSON to stdout; coded errors go
 * to stderr with a non-zero exit. Per the SDK's ethics ceiling, `checkout` only
 * hands back a payment URL — a human completes payment in a browser.
 */

import { Command, InvalidArgumentError } from "commander";
import { BrowserAuthBackend } from "./auth/browser/playwright.js";
import type { Basket, BookedSlot, NutritionFilter, SearchResult, Slot } from "./index.js";
import { Basketeer, BasketeerError, FileTokenStore } from "./index.js";
import { isMainModule } from "./is-main.js";
import { bestDeal } from "./offers.js";

/** Pretty-print any JSON-serialisable value to stdout. */
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** commander parser: a non-negative integer, else a usage error. */
export function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new InvalidArgumentError("must be a non-negative integer");
  return n;
}

/** commander parser: a non-negative number (decimals allowed), else a usage error. */
export function nonNegativeNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError("must be a non-negative number");
  return n;
}

/** commander parser: a Tesco SKU (tpnc, all digits), else a usage error that echoes the input. */
export function skuArg(value: string): string {
  if (!/^\d{6,12}$/.test(value))
    throw new InvalidArgumentError(
      `expected a numeric SKU like 322246580, got ${JSON.stringify(value)}`,
    );
  return value;
}

/** commander parser: a YYYY-MM-DD date, else a usage error. */
export function isoDateArg(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new InvalidArgumentError("must be a date like 2026-10-27");
  return value;
}

/** commander parser: an hour 0-24, else a usage error. */
export function hourArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 24)
    throw new InvalidArgumentError("must be an hour 0-24");
  return n;
}

const UK_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Date, weekday, HH:MM and minutes-past-midnight of an instant in UK local time (BST/GMT-aware). */
export function ukParts(iso: string): {
  date: string;
  weekday: string;
  time: string;
  minutes: number;
} {
  const parts = UK_FORMAT.formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour");
  const minute = get("minute");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    time: `${hour}:${minute}`,
    minutes: Number(hour) * 60 + Number(minute),
  };
}

/** A YYYY-MM-DD date plus `days`. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's UK date plus `days`, as YYYY-MM-DD. */
function ukDate(days = 0): string {
  return addDays(ukParts(new Date().toISOString()).date, days);
}

/** A slot in UK local time, reduced to what a person (or agent) needs to pick one. */
export function slotView(s: Slot | BookedSlot) {
  const start = ukParts(s.start);
  const end = ukParts(s.end);
  return {
    id: s.id,
    date: start.date,
    day: start.weekday,
    start: start.time,
    end: end.time,
    charge: "charge" in s ? s.charge : null,
    status: s.status,
  };
}

export interface SlotFilter {
  /** Only this UK date. */
  date?: string;
  /** Only slots starting at or after this UK hour. */
  from?: number;
  /** Only slots ending by this UK hour (24 = midnight). */
  to?: number;
  /** Only `Available` slots. */
  available?: boolean;
}

/** Filter slots by UK-local date and time window. */
export function filterSlots<T extends Slot>(slots: T[], f: SlotFilter): T[] {
  return slots.filter((s) => {
    const start = ukParts(s.start);
    const end = ukParts(s.end);
    const endMinutes = end.minutes === 0 && end.date !== start.date ? 24 * 60 : end.minutes;
    return (
      (!f.date || start.date === f.date) &&
      (f.from === undefined || start.minutes >= f.from * 60) &&
      (f.to === undefined || endMinutes <= f.to * 60) &&
      (!f.available || s.status === "Available")
    );
  });
}

/** A search result reduced to what's needed to pick a product. */
export function productBrief(r: SearchResult) {
  return {
    sku: r.sku,
    title: r.title,
    price: r.price.actual,
    unitPrice:
      r.price.unitPrice != null ? `${r.price.unitPrice}/${r.price.unitOfMeasure ?? "each"}` : null,
    offers: r.promotions.map((p) => p.description),
    deal: bestDeal(r.price.actual, r.promotions),
    available: r.available,
  };
}

/**
 * On-offer products for a query, cheapest first by unit price after the deal
 * (falling back to per-item price when Tesco gives no unit price).
 */
export function rankDeals(results: SearchResult[]) {
  return results
    .map((r) => {
      const brief = productBrief(r);
      const deal = brief.deal;
      if (!deal || r.available === false) return null;
      const ratio = r.price.actual ? deal.each / r.price.actual : 1;
      const dealUnit = r.price.unitPrice != null ? r.price.unitPrice * ratio : null;
      return {
        ...brief,
        dealUnitPrice:
          dealUnit != null
            ? `${Math.round(dealUnit * 100) / 100}/${r.price.unitOfMeasure ?? "each"}`
            : null,
        sortKey: dealUnit ?? deal.each,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ sortKey: _sortKey, ...rest }) => rest);
}

/** A basket with each line's product title looked up (one batched request per 15 SKUs). */
async function basketView(client: Basketeer, b: Basket) {
  const skus = b.items.map((i) => i.sku).filter((s): s is string => !!s);
  const titles = new Map<string, string>();
  for (let i = 0; i < skus.length; i += 15) {
    for (const p of await client.getProducts(skus.slice(i, i + 15))) titles.set(p.sku, p.title);
  }
  return {
    guidePrice: b.guidePrice,
    itemCount: b.items.reduce((n, i) => n + i.quantity, 0),
    items: b.items.map((i) => ({
      sku: i.sku,
      title: (i.sku && titles.get(i.sku)) ?? null,
      quantity: i.quantity,
      unit: i.unit,
      cost: i.cost,
      available: i.available,
    })),
  };
}

const store = new FileTokenStore();

/** Resume a persisted session for authenticated commands (refreshing if able). */
function authedClient(): Promise<Basketeer> {
  return Basketeer.resume({ store, authBackend: new BrowserAuthBackend() });
}

/** Anonymous client for read-only commands (no session required). */
function readClient(): Basketeer {
  return new Basketeer();
}

const program = new Command();
program
  .name("basketeer")
  .description("Typed CLI for Tesco grocery automation (basketeer).")
  .showHelpAfterError();

// --- auth -------------------------------------------------------------------

program
  .command("login")
  .description(
    "Open a real Chrome to sign in, then persist the harvested session. " +
      "Without a TTY it detects sign-in automatically instead of waiting for Enter.",
  )
  .option("--timeout <s>", "seconds to wait for sign-in when not on a TTY", nonNegativeInt, 300)
  .action(async (opts: { timeout: number }) => {
    const authBackend = new BrowserAuthBackend({ loginTimeoutMs: opts.timeout * 1000 });
    const client = new Basketeer({ store, authBackend });
    const session = await client.login();
    emit({
      ok: true,
      customerUuid: session.customerUuid,
      expiresAt: session.accessTokenExpiry ?? null,
    });
  });

// --- reads (anonymous) ------------------------------------------------------

program
  .command("search")
  .description("Search the catalogue.")
  .argument("<query>", "search terms")
  .option("--limit <n>", "max results", nonNegativeInt, 10)
  .option(
    "--min-protein <g>",
    "only products with at least this protein per 100g/ml",
    nonNegativeNumber,
  )
  .option("--max-sugar <g>", "only products with at most this sugar per 100g/ml", nonNegativeNumber)
  .option("--sort <field>", "sort hydrated results by a macro (e.g. protein)")
  .option("--hydrate <n>", "max results to fetch nutrition for (default 20)", nonNegativeInt)
  .option("--brief", "print only sku, title, price, unit price, offers and availability")
  .action(
    async (
      query: string,
      opts: {
        limit: number;
        minProtein?: number;
        maxSugar?: number;
        sort?: string;
        hydrate?: number;
        brief?: boolean;
      },
    ) => {
      const usesNutrition = opts.minProtein != null || opts.maxSugar != null || opts.sort != null;
      if (usesNutrition) {
        const where: NutritionFilter = {};
        if (opts.minProtein != null) where.protein = { min: opts.minProtein };
        if (opts.maxSugar != null) where.sugars = { max: opts.maxSugar };
        const sort = opts.sort ? { by: opts.sort, dir: "desc" as const } : undefined;
        emit(
          await readClient().searchByNutrition(query, {
            where,
            sort,
            hydrate: opts.hydrate,
            limit: opts.limit,
          }),
        );
        return;
      }
      const page = await readClient().search(query, { limit: opts.limit });
      const results = page.results.slice(0, opts.limit);
      emit(opts.brief ? results.map(productBrief) : { ...page, results });
    },
  );

program
  .command("deals")
  .description(
    "Find products on offer (Clubcard prices, multi-buys, BOGOF) for a query, cheapest unit price first.",
  )
  .argument("<query>", 'search terms, broad enough to catch alternatives (e.g. "cheddar")')
  .option("--limit <n>", "max deals to print", nonNegativeInt, 5)
  .option("--scan <n>", "search results to scan for offers", nonNegativeInt, 40)
  .action(async (query: string, opts: { limit: number; scan: number }) => {
    const page = await readClient().search(query, { limit: opts.scan });
    emit(rankDeals(page.results.slice(0, opts.scan)).slice(0, opts.limit));
  });

program
  .command("product")
  .description("Look up a single product by SKU (tpnc).")
  .argument("<sku>", "product SKU / tpnc")
  .action(async (sku: string) => {
    emit(await readClient().getProduct(sku));
  });

program
  .command("nutrition")
  .argument("<sku>", "product SKU (tpnc)")
  .description("Print normalized nutrition (macros + micros) for a product.")
  .action(async (sku: string) => {
    emit((await readClient().getProduct(sku)).nutrition);
  });

program
  .command("favourites")
  .description("List the customer's favourites (requires a session).")
  .option("--limit <n>", "max results", nonNegativeInt, 50)
  .option("--brief", "print only sku, title, price, unit price, offers and availability")
  .action(async (opts: { limit: number; brief?: boolean }) => {
    const client = await authedClient();
    const page = await client.favourites({ limit: opts.limit });
    emit(opts.brief ? page.results.slice(0, opts.limit).map(productBrief) : page);
  });

// --- basket -----------------------------------------------------------------

const basket = program.command("basket").description("Inspect and edit the basket.");

basket
  .command("get")
  .description("Show the current basket, with product titles.")
  .option("--raw", "print the full basket object instead of the summary")
  .action(async (opts: { raw?: boolean }) => {
    const client = await authedClient();
    const b = await client.basket.get();
    emit(opts.raw ? b : await basketView(client, b));
  });

basket
  .command("add")
  .description("Add <qty> (default 1) of a product to the basket (increments the line).")
  .argument("<sku>", "product SKU / tpnc", skuArg)
  .argument("[qty]", "quantity to add", nonNegativeInt, 1)
  .action(async (sku: string, qty: number) => {
    const client = await authedClient();
    emit(await basketView(client, await client.basket.add(sku, qty)));
  });

basket
  .command("set")
  .description("Set a basket line to an exact quantity (0 removes it).")
  .argument("<sku>", "product SKU / tpnc", skuArg)
  .argument("<qty>", "exact quantity", nonNegativeInt)
  .action(async (sku: string, qty: number) => {
    const client = await authedClient();
    emit(await basketView(client, await client.basket.set(sku, qty)));
  });

basket
  .command("remove")
  .description("Remove a line from the basket.")
  .argument("<sku>", "product SKU / tpnc", skuArg)
  .action(async (sku: string) => {
    const client = await authedClient();
    emit(await basketView(client, await client.basket.remove(sku)));
  });

// --- slots ------------------------------------------------------------------

program
  .command("slots")
  .description("List delivery slots in UK local time (or collection slots with --collection).")
  .option("--collection", "list click-and-collect slots instead of delivery")
  .option("--date <YYYY-MM-DD>", "only this day", isoDateArg)
  .option("--start <YYYY-MM-DD>", "window start (default today)", isoDateArg)
  .option(
    "--end <YYYY-MM-DD>",
    "window end (default start + 6 days; Tesco shows ~3 weeks ahead)",
    isoDateArg,
  )
  .option("--from <hour>", "only slots starting at or after this UK hour", hourArg)
  .option("--to <hour>", "only slots ending by this UK hour", hourArg)
  .option("--available", "only slots with status Available")
  .option("--raw", "print the full slot objects (UTC) instead of the UK-time summary")
  .action(
    async (
      opts: SlotFilter & { collection?: boolean; start?: string; end?: string; raw?: boolean },
    ) => {
      const client = await authedClient();
      const start = opts.date ?? opts.start ?? ukDate(0);
      const end = opts.date ?? opts.end ?? addDays(start, 6);
      const slots = opts.collection
        ? await client.slots.listCollection({ start, end })
        : await client.slots.list({ start, end });
      emit(opts.raw ? slots : filterSlots(slots, opts).map(slotView));
    },
  );

const slot = program
  .command("slot")
  .description("Book, release, or show your reserved delivery slot.");

slot
  .command("book")
  .description("Reserve a delivery slot by id (from `slots`). Replaces any slot already held.")
  .argument("<slotId>", "slot id")
  .action(async (slotId: string) => {
    const client = await authedClient();
    const booked = await client.slots.book(slotId);
    emit({ ...slotView(booked), reservationExpiry: booked.reservationExpiry });
  });

slot
  .command("release")
  .description("Release a reserved delivery slot by id.")
  .argument("<slotId>", "slot id")
  .action(async (slotId: string) => {
    const client = await authedClient();
    emit(slotView(await client.slots.release(slotId)));
  });

slot
  .command("current")
  .description("Show the delivery slot currently held (searches the next 3 weeks).")
  .action(async () => {
    const client = await authedClient();
    const slots = await client.slots.list({ start: ukDate(0), end: ukDate(21) });
    const held = slots.filter((s) => s.status === "Reserved" || s.status === "Booked");
    emit(
      held.length
        ? held.map(slotView)
        : { reserved: null, note: "No delivery slot reserved in the next 3 weeks." },
    );
  });

// --- orders -----------------------------------------------------------------

const orders = program.command("orders").description("Inspect and manage orders.");

orders
  .command("list")
  .description("List upcoming orders.")
  .action(async () => {
    const client = await authedClient();
    emit(await client.orders.list());
  });

orders
  .command("cancel")
  .description("Cancel an order by order number.")
  .argument("<orderNo>", "order number")
  .action(async (orderNo: string) => {
    const client = await authedClient();
    await client.orders.cancel(orderNo);
    emit({ ok: true, cancelled: orderNo });
  });

orders
  .command("reorder")
  .description("Re-add the last delivered order's items to the basket.")
  .action(async () => {
    const client = await authedClient();
    const last = await client.orders.lastFulfilled();
    if (!last) {
      emit({ ok: false, reason: "no previous fulfilled order" });
      return;
    }
    const items = last.items
      .filter((it) => it.productId)
      .map((it) => ({ id: it.productId!, newValue: it.quantity, newUnitChoice: it.unit ?? "pcs" }));
    const { basket, rejected, unavailable } = await client.basket.update(items);
    emit({
      ok: !rejected.length && !unavailable.length,
      reorderedFrom: last.orderNo,
      lines: items.length,
      rejected,
      unavailable,
      basket,
    });
  });

// --- checkout ---------------------------------------------------------------

program
  .command("checkout")
  .description("Prepare checkout and print the payment URL (a human completes payment).")
  .action(async () => {
    const client = await authedClient();
    const { basket: cart, url } = await client.checkout();
    emit({
      basket: cart,
      paymentUrl: url,
      note: "Payment is browser-bound (3-D Secure). Open paymentUrl and complete payment yourself — the CLI never pays.",
    });
  });

// --- entrypoint -------------------------------------------------------------

// Only parse argv when run as a binary, so the module is importable (tests).
if (isMainModule(import.meta.url)) {
  program.parseAsync().catch((err: unknown) => {
    const name = err instanceof BasketeerError ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${name}: ${message}\n`);
    process.exit(1);
  });
}
