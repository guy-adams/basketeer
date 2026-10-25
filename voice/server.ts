/**
 * Voice shopping server: browser mic -> local Parakeet STT -> Claude (Agent SDK)
 * driving the basketeer CLI -> reply spoken back with local Kokoro TTS.
 *
 *   npm start   (starts the speech sidecars too: stt_tts.py always, clone_tts.py / f5_tts.py on demand)
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CanUseTool,
  createSdkMcpServer,
  getSessionInfo,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Basketeer, MAX_PRODUCT_BATCH_SIZE, resizeImageUrl } from "../dist/index.js";
import { shoppingTools } from "./shopping-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const SPEECH_URL = process.env.SPEECH_URL ?? "http://127.0.0.1:3001";
const BASKETEER_BIN = resolve(HERE, "..", "dist", "cli.js");
const BIN_DIR = join(tmpdir(), "basketeer-voice-bin");
const WORK_DIR = join(tmpdir(), "basketeer-voice-work");

// Expose the repo's CLI as plain `basketeer` on the agent's PATH.
mkdirSync(BIN_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });
rmSync(join(BIN_DIR, "basketeer"), { force: true });
symlinkSync(BASKETEER_BIN, join(BIN_DIR, "basketeer"));

// ---------- speech sidecars ----------

const CLONE_URL = process.env.CLONE_URL ?? "http://127.0.0.1:3002";
const VOICE_SAMPLE = process.env.VOICE_SAMPLE_PATH ?? join(homedir(), ".basketeer", "my-voice.wav");
const isUp = (base: string) =>
  fetch(`${base}/health`).then(
    (r) => r.ok,
    () => false,
  );
const children: ReturnType<typeof spawn>[] = [];
process.on("exit", () => {
  for (const c of children) c.kill();
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit());

/** Start a uv sidecar script unless something already answers at `base`; resolves once it's healthy. */
async function ensureSidecar(base: string, script: string, label: string) {
  if (await isUp(base)) return;
  console.log(`Starting ${label} (first run downloads its model)…`);
  const child = spawn("uv", ["run", join(HERE, script)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(child);
  while (!(await isUp(base))) {
    if (child.exitCode !== null) throw new Error(`${label} exited; see the server output.`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

await ensureSidecar(SPEECH_URL, "stt_tts.py", "speech sidecar");

// The cloning models are big, so each starts only when its voice is picked or used.
const F5_URL = process.env.F5_URL ?? "http://127.0.0.1:3003";
const CLONERS: Record<string, { url: string; script: string; label: string }> = {
  mine: { url: CLONE_URL, script: "clone_tts.py", label: "Chatterbox voice-cloning sidecar" },
  mine_f5: { url: F5_URL, script: "f5_tts.py", label: "F5-TTS voice-cloning sidecar" },
};
const starting = new Map<string, Promise<void>>();
function ensureCloner(voice: string) {
  const c = CLONERS[voice];
  if (!starting.has(voice))
    starting.set(
      voice,
      ensureSidecar(c.url, c.script, c.label).catch((e) => {
        starting.delete(voice);
        throw e;
      }),
    );
  return starting.get(voice)!;
}

/** Per-engine progress after a new recording: "starting" | "preparing" | "ready" | "error: …". */
const prepStatus = new Map<string, string>();
let prepRun = 0;

/** After a new recording, start every cloning engine and have each process the sample now. */
function prepareAllCloners() {
  const run = ++prepRun;
  for (const [voice, c] of Object.entries(CLONERS)) {
    prepStatus.set(voice, "starting");
    ensureCloner(voice)
      .then(async () => {
        if (run !== prepRun) return;
        prepStatus.set(voice, "preparing");
        const r = await fetch(`${c.url}/prepare`, { method: "POST" });
        if (!r.ok) throw new Error(`${c.label} returned ${r.status}`);
        if (run === prepRun) prepStatus.set(voice, "ready");
      })
      .catch((e) => {
        console.error(e);
        if (run === prepRun) prepStatus.set(voice, `error: ${(e as Error).message}`);
      });
  }
}

/** Normalise a recording to mono 24 kHz WAV with the silence trimmed off both ends; returns seconds. */
function saveVoiceSample(audio: Uint8Array): Promise<number> {
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB";
  const tmp = `${VOICE_SAMPLE}.tmp.wav`;
  return new Promise((ok, fail) => {
    const ff = spawn("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      "pipe:0",
      "-ac",
      "1",
      "-ar",
      "24000",
      "-af",
      `${trim},areverse,${trim},areverse`,
      tmp,
    ]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", fail);
    ff.on("close", (code) => {
      if (code !== 0) return fail(new Error(`ffmpeg failed: ${err.trim()}`));
      execFile(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp],
        (e, out) => {
          if (e) return fail(e);
          const seconds = Number(out.trim());
          if (!(seconds >= MIN_SAMPLE_SECONDS)) {
            rmSync(tmp, { force: true });
            return fail(
              new Error(
                `Only ${seconds.toFixed(1)}s of speech; record at least ${MIN_SAMPLE_SECONDS}s.`,
              ),
            );
          }
          renameSync(tmp, VOICE_SAMPLE);
          ok(Math.round(seconds * 10) / 10);
        },
      );
    });
    ff.stdin.end(audio);
  });
}
const MIN_SAMPLE_SECONDS = 6;

const ONES =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
/** 0-999999 in British English words, e.g. 1234 -> "one thousand two hundred and thirty-four". */
function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000)
    return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${numberWords(n % 100)}` : ""}`;
  const rest = n % 1000;
  return `${numberWords(Math.floor(n / 1000))} thousand${rest ? (rest < 100 ? " and " : " ") + numberWords(rest) : ""}`;
}

/**
 * Make text read naturally: "£26.43" -> "twenty-six pounds and forty-three pence", and other
 * whole numbers as words (the cloning models misread digits). Times like 7:30, decimals, and
 * huge numbers are left for the voice to handle.
 */
const ORDINAL: Record<string, string> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};
function ordinalWords(n: number) {
  const w = numberWords(n);
  const last = w.split(/[- ]/).pop()!;
  const ord = ORDINAL[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return w.slice(0, w.length - last.length) + ord;
}
const UNITS: Record<string, [string, string]> = {
  g: ["gram", "grams"],
  kg: ["kilo", "kilos"],
  ml: ["millilitre", "millilitres"],
  l: ["litre", "litres"],
};

export function speakable(text: string) {
  const unit = (n: number, one: string, many: string) =>
    `${numberWords(n)} ${n === 1 ? one : many}`;
  return text
    .replace(/£\s?(\d[\d,]*)(?:\.(\d{1,2}))?/g, (_, whole: string, frac?: string) => {
      const pounds = Number(whole.replace(/,/g, ""));
      const pence = frac ? Number(frac.padEnd(2, "0")) : 0;
      if (!pounds && pence) return unit(pence, "penny", "pence");
      const p = unit(pounds, "pound", "pounds");
      return pence ? `${p} and ${unit(pence, "penny", "pence")}` : p;
    })
    .replace(/\b(\d+)p\b/g, (_, n: string) => unit(Number(n), "penny", "pence"))
    .replace(
      /\b(\d+)(?:\.(\d+))?\s?(kg|g|ml|l)\b/gi,
      (_, whole: string, frac: string | undefined, u: string) => {
        const [one, many] = UNITS[u.toLowerCase()];
        const n = frac
          ? `${numberWords(Number(whole))} point ${[...frac].map((d) => ONES[Number(d)]).join(" ")}`
          : numberWords(Number(whole));
        return `${n} ${whole === "1" && !frac ? one : many}`;
      },
    )
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, (_, n: string) => ordinalWords(Number(n)))
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h: string, m: string) =>
      m === "00"
        ? `${numberWords(Number(h))} o'clock`
        : `${numberWords(Number(h))} ${Number(m) < 10 ? `oh ${ONES[Number(m)]}` : numberWords(Number(m))}`,
    )
    .replace(/(?<![\d.:,])\b\d{1,6}\b(?![.:,]\d)/g, (n) => numberWords(Number(n)));
}

const today = () =>
  new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Europe/London",
  });

const systemPrompt =
  () => `You are a voice shopping assistant for the user's Tesco account. The user talks to you through a microphone; your replies are read aloud by a text-to-speech voice. Today is ${today()} (UK time).

You drive their real Tesco account with the \`basketeer\` CLI through the Bash tool. Run it as plain \`basketeer <command>\`, one command per call, no pipes or shell tricks. Output is JSON; errors are "ErrorName: message" with a non-zero exit.

Commands:
- Find products: basketeer search "<terms>" --limit 5 --brief
- Offers on a kind of product: basketeer deals "<generic terms>" --limit 5
- Their usual items: basketeer favourites --limit 50 --brief
- Show basket: basketeer basket get
- Add (increments): basketeer basket add <sku> [qty]
- Set exact quantity (0 removes): basketeer basket set <sku> <qty>
- Remove: basketeer basket remove <sku>
- Delivery slots: basketeer slots --date YYYY-MM-DD [--from H] [--to H] [--available]   or   --start YYYY-MM-DD --end YYYY-MM-DD --available
- Held slot: basketeer slot current
- Book / release slot: basketeer slot book <slotId> / basketeer slot release <slotId>
- Payment link (only if asked): basketeer checkout
- Sign in again: basketeer login
- Past orders: basketeer orders list

Adding items:
1. For generic requests ("milk", "my usual yoghurt") check favourites first (fetch once per conversation and reuse). If a favourite clearly matches, use it.
2. Otherwise search --brief and pick the best match for what they said (size, brand, type).
3. Only ask when it is genuinely ambiguous, offering at most 2-3 short options with prices. Otherwise just add it.
4. "add two"/"another" -> basket add; "make it three"/"three in total" -> basket set. Default quantity 1.
5. Skip unavailable items, say so, and suggest the closest alternative.
6. Several items in one request: handle each, then confirm once at the end.
Saving money (do this every time you add something):
- Search and --brief results carry a "deal" field (each = price per item with the offer, buy = how many you must buy). After picking their item, run basketeer deals with a generic version of it ("cheddar", "beef mince", "passata"). deals matches loosely, so keep only like-for-like alternatives: same kind of product, similar size, same variant (mature/mild, lean/regular, still/sparkling).
- Offer an alternative only if it is cheaper per unit after the deal (dealUnitPrice) and doesn't cost more than about 50p above their pick in total. Offer multi-buys only for things they'd use that many of or cupboard staples, and say the total ("2 for £4.50, so £2.25 each"). If their own pick has a multi-buy, mention it. Clubcard prices count.
- Never swap silently. Add their pick, then offer the swap in one sentence with the saving ("Cathedral City is £2.80 on Clubcard, 70p less. Swap it?"). On yes, remove the original and add the alternative. If nothing is cheaper, say nothing about deals.
- For a recipe or several items: add everything first, then show the best swaps (up to 3) with show_list and say the total you could save in one sentence.
- Skip the check when they named an exact brand and size or said "only that one".
Removing/changing: basket get, match what they said against titles, then remove/set. Ask only if two lines could match.

Recipes (BBC Good Food first):
- Use the recipe_search tool (BBC Good Food) and pick a well-rated, non-premium match; read it with recipe_get. Only if BBC Good Food has nothing suitable, fall back to WebSearch/WebFetch and say where it's from.
- When asked to find a recipe: give the name, roughly how long it takes, and how many it serves, in a sentence or two, and offer to add the ingredients.
- When adding a recipe's ingredients: scale to the servings they asked for, buy sensible pack sizes (one pack covers several of an ingredient), use purchase_history or favourites to pick the brands they normally buy, and skip store-cupboard basics (salt, pepper, water, cooking oil) unless asked. Add everything with one basket_add_many call. At the end say how many items you added, the rough total, and anything you skipped or couldn't find.

Their usuals / regular shop:
- "Add my usuals", "do my regular shop", "the usual things": call usual_items (default last 6 months; their order history is stored and synced automatically), then add every returned item at its typicalQuantity with ONE basket_add_many call. Don't ask first. Then say how many you added, the basket total, and any that were unavailable (suggest alternatives only if asked).
- If they ask to tweak ("just the weekly stuff", "not the monthly bits"), use everyDays and lastBought to filter, e.g. skip items bought within the last everyDays.
- For "which X do I usually get?" or "when did I last buy X?", use purchase_history.
- If usual_items returns a note about having few orders, still add the items, and mention briefly that it's based on just their last order or two.
- If usual_items finds no orders, say so and offer to use their favourites instead.

Delivery slots: work out dates in UK time and say the actual date back. "Next Tuesday" when today is Monday or Tuesday means Tuesday of next week. Morning ~7-12, afternoon ~12-17, evening ~17-22. Check slot current before booking; booking replaces a held slot, so get a yes before swapping. If exactly one slot fits and none is held, book it. Mention they must check out before the reservation expires.

Never pay or attempt checkout. Don't cancel orders unless explicitly asked.

Showing things on screen: the user also sees a screen. Whenever the answer is several things to look at or choose between (delivery slots, product options from a search, recipe ingredients, their usuals, what you just added, past orders, recipe choices), call show_list with them, then keep the spoken reply to a one or two sentence summary that points at it ("I've put Saturday's slots on screen; the earliest is 8 to 9 for £3."). Don't read the whole list aloud. Pass sku for products so pictures and links appear. Use value for prices/charges ("£1.65", "£3.00") and detail for things like pack size, availability, or "Already in basket". A single item or a yes/no answer needs no list.

How to talk: replies are SPOKEN. Plain sentences only: no markdown, lists, bullet points, emoji, SKUs, ids, JSON or URLs. Keep it to one or two short sentences unless they asked for detail. Say prices like "£2.95" and times like "7 to 8 in the morning". For the basket: item count, total, then the items in plain words; summarise long baskets. Do the work, then confirm; don't narrate each command. If the transcript looks garbled or cut off, ask them to repeat.

Errors: AuthExpiredError or "no session" -> run basketeer login (a Chrome window opens) and tell them to sign in to Tesco in that window, then retry. RateLimitedError -> retry once after a pause, then tell them. ItemUnavailableError/LineRejectedError -> offer an alternative.`;

// Only `basketeer ...` commands, with no shell metacharacters, may run.
const SAFE_BASH = /^basketeer(\s+[\w@.:/"' £=,+-]+)*\s*$/;
const BLOCKED = /[;&|`$<>\\\n]|\bcheckout\s+--pay/;
const canUseTool: CanUseTool = async (toolName, input) => {
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "").trim();
    if (SAFE_BASH.test(cmd) && !BLOCKED.test(cmd))
      return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "Only plain `basketeer ...` commands are allowed." };
  }
  return { behavior: "deny", message: `${toolName} is not available.` };
};

// ---------- persistent chat: the visible log plus the agent session it continues ----------

const CHAT_PATH = process.env.CHAT_PATH ?? join(homedir(), ".basketeer", "voice-chat.json");
const CHAT_ARCHIVE_PATH = CHAT_PATH.replace(/\.json$/, "-archive.jsonl");
const MAX_LOG = 5000;
type Card = {
  title: string;
  subtitle?: string;
  items: { text: string; detail?: string; value?: string; link?: string; image?: string | null }[];
};
type LogEntry = { role: "me" | "bot" | "sys" | "card"; text: string; at: string; card?: Card };
const chat: { sessionId?: string; messages: LogEntry[] } = (() => {
  try {
    return JSON.parse(readFileSync(CHAT_PATH, "utf8"));
  } catch {
    return { messages: [] };
  }
})();
let saving = Promise.resolve();
function logMessage(role: LogEntry["role"], text: string, card?: Card) {
  chat.messages.push({ role, text, at: new Date().toISOString(), ...(card && { card }) });
  if (chat.messages.length > MAX_LOG) chat.messages.splice(0, chat.messages.length - MAX_LOG);
  return persistChat();
}
function persistChat() {
  // Serialise writes so a slow one can't land after a newer one.
  saving = saving.then(async () => {
    mkdirSync(dirname(CHAT_PATH), { recursive: true });
    await writeFile(CHAT_PATH, JSON.stringify(chat, null, 1));
  });
  return saving;
}

let busy = false;

type Emit = (event: Record<string, unknown>) => void;
let currentEmit: Emit | undefined; // the turn in progress (only one runs at a time)

// ---------- on-screen lists: replies are spoken, so structured things are shown instead ----------

const PRODUCT_URL = (sku: string) => `https://www.tesco.com/shop/en-GB/products/${sku}`;
const uiTools = createSdkMcpServer({
  name: "ui",
  version: "0.1.0",
  tools: [
    tool(
      "show_list",
      "Show a list on the user's screen alongside your spoken reply: delivery slots, search results to choose from, recipe ingredients, their usuals, past orders, basket changes, options. Give each item a short `text`, optional `detail` (second line) and `value` (right-aligned, e.g. a price or charge). For Tesco products pass `sku` and the thumbnail and product link are added automatically. Your spoken reply should then just summarise and point to it, not read the list out.",
      {
        title: z.string().describe("Short heading, e.g. 'Saturday 25 October slots'."),
        subtitle: z.string().optional(),
        items: z
          .array(
            z.object({
              text: z.string(),
              detail: z.string().optional(),
              value: z.string().optional(),
              sku: z
                .string()
                .optional()
                .describe("Tesco product SKU (tpnc), if the item is a product."),
              url: z
                .string()
                .url()
                .optional()
                .describe("Link for non-product items, e.g. a recipe page."),
            }),
          )
          .min(1)
          .max(60),
      },
      async ({ title, subtitle, items }) => {
        const skus = items.flatMap((it) => (it.sku ? [it.sku] : []));
        const images = skus.length
          ? await thumbnails(skus).catch(() => ({}) as Record<string, string | null>)
          : {};
        const card: Card = {
          title,
          subtitle,
          items: items.map(({ sku, url, ...it }) => ({
            ...it,
            link: sku && /^\d+$/.test(sku) ? PRODUCT_URL(sku) : url,
            image: sku ? (images[sku] ?? null) : undefined,
          })),
        };
        await logMessage("card", title, card);
        currentEmit?.({ type: "card", card });
        return { content: [{ type: "text", text: "Shown on screen." }] };
      },
    ),
  ],
});

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") {
    const cmd = String(input.command ?? "").replace(/^basketeer\s+/, "");
    const [verb, ...rest] = cmd.split(/\s+/);
    const arg = rest
      .join(" ")
      .replace(/--\S+(\s+\d+)?/g, "")
      .trim();
    if (verb === "search") return `Searching Tesco for ${arg}`;
    if (verb === "favourites") return "Checking your favourites";
    if (verb === "basket")
      return rest[0] === "get" ? "Looking at your basket" : "Updating your basket";
    if (verb === "slots" || verb === "slot") return "Checking delivery slots";
    if (verb === "login") return "Opening Tesco sign-in";
    return `Running basketeer ${verb}`;
  }
  if (name === "mcp__shop__recipe_search") return `Searching BBC Good Food for ${input.query}`;
  if (name === "mcp__shop__recipe_get") return "Reading the recipe";
  if (name === "mcp__shop__usual_items") return "Working out your usual items";
  if (name === "mcp__shop__purchase_history") return `Checking past orders for ${input.text}`;
  if (name === "mcp__shop__sync_orders") return "Syncing your order history";
  if (name === "mcp__ui__show_list") return "Putting it on screen";
  if (name === "mcp__shop__basket_add_many")
    return `Adding ${(input.items as unknown[])?.length ?? ""} items to your basket`;
  if (name === "WebSearch") return `Searching the web for ${input.query}`;
  if (name === "WebFetch")
    return `Reading ${
      String(input.url ?? "")
        .replace(/^https?:\/\/(www\.)?/, "")
        .split("/")[0]
    }`;
  return name;
}

async function runTurn(text: string, emit: Emit) {
  currentEmit = emit;
  let reply = "";
  for await (const msg of query({
    prompt: text,
    options: {
      resume: chat.sessionId,
      systemPrompt: systemPrompt(),
      tools: ["Bash", "WebSearch", "WebFetch"],
      mcpServers: { shop: shoppingTools, ui: uiTools },
      allowedTools: ["WebSearch", "WebFetch", "mcp__shop__*", "mcp__ui__*"],
      canUseTool,
      settingSources: [],
      cwd: WORK_DIR,
      model: process.env.CLAUDE_MODEL,
      env: { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}` },
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id !== chat.sessionId) {
      chat.sessionId = msg.session_id;
      await persistChat();
    }
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "tool_use")
          emit({
            type: "status",
            text: describeTool(block.name, block.input as Record<string, unknown>),
          });
      }
    }
    if (msg.type === "result") {
      reply = msg.subtype === "success" ? msg.result : "Sorry, something went wrong on my end.";
      if (msg.subtype !== "success") console.error("[agent]", msg.subtype, msg);
    }
  }
  return forSpeech(reply);
}

/** Replies are spoken: drop the "Sources:" block WebSearch appends, and any markdown. */
function forSpeech(text: string) {
  return text
    .replace(/\n+\s*\**sources:?\**[\s\S]*$/i, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#`]+/g, "")
    .trim();
}

function basketFromCli(): Promise<{
  error?: string;
  items?: { sku?: string; imageUrl?: string | null }[];
}> {
  return new Promise((ok) => {
    execFile(
      process.execPath,
      [BASKETEER_BIN, "basket", "get"],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) return ok({ error: stderr.trim().split("\n").pop() || err.message });
        try {
          ok(JSON.parse(stdout));
        } catch {
          ok({ error: "Couldn't read basket" });
        }
      },
    );
  });
}

// ---------- product thumbnails (looked up once per SKU, cached on disk) ----------

const IMAGE_CACHE_PATH = join(homedir(), ".basketeer", "product-images.json");
const imageCache: Record<string, string | null> = (() => {
  try {
    return JSON.parse(readFileSync(IMAGE_CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
})();
const catalogue = new Basketeer(); // anonymous: product reads need no session

async function thumbnails(skus: string[]): Promise<Record<string, string | null>> {
  const missing = [...new Set(skus)].filter((sku) => !(sku in imageCache));
  for (let i = 0; i < missing.length; i += MAX_PRODUCT_BATCH_SIZE) {
    const batch = missing.slice(i, i + MAX_PRODUCT_BATCH_SIZE);
    try {
      const found = new Map((await catalogue.getProducts(batch)).map((p) => [p.sku, p.imageUrl]));
      for (const sku of batch)
        imageCache[sku] = resizeImageUrl(found.get(sku) ?? null, { width: 96, height: 96 });
    } catch (e) {
      console.error("[images]", (e as Error).message); // thumbnails are optional; try again next time
    }
  }
  if (missing.length) await writeFile(IMAGE_CACHE_PATH, JSON.stringify(imageCache)).catch(() => {});
  return Object.fromEntries(skus.map((sku) => [sku, imageCache[sku] ?? null]));
}

async function basketSummary(): Promise<unknown> {
  const basket = await basketFromCli();
  if (!basket.items?.length) return basket;
  const images = await thumbnails(basket.items.flatMap((it) => (it.sku ? [it.sku] : [])));
  for (const it of basket.items) it.imageUrl = it.sku ? images[it.sku] : null;
  return basket;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/api/stt") {
      const r = await fetch(`${SPEECH_URL}/stt`, {
        method: "POST",
        body: new Uint8Array(await body(req)),
      });
      return json(res, r.status, await r.json());
    }
    if (req.method === "POST" && url.pathname === "/api/tts") {
      const { text, voice, speed } = JSON.parse((await body(req)).toString());
      const cloner = CLONERS[voice];
      if (cloner) await ensureCloner(voice);
      const r = await fetch(`${cloner ? cloner.url : SPEECH_URL}/tts`, {
        method: "POST",
        body: JSON.stringify({ text: speakable(text), voice, speed }),
      });
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "audio/wav" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (req.method === "GET" && url.pathname === "/api/my-voice")
      return json(res, 200, {
        recorded: existsSync(VOICE_SAMPLE),
        engines: Object.fromEntries(prepStatus),
      });
    if (req.method === "POST" && url.pathname === "/api/my-voice") {
      mkdirSync(dirname(VOICE_SAMPLE), { recursive: true });
      try {
        const seconds = await saveVoiceSample(new Uint8Array(await body(req)));
        prepareAllCloners();
        return json(res, 200, { ok: true, seconds });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/warm") {
      // Start a cloning model in the background so it's ready by the time it's needed.
      const { voice } = JSON.parse((await body(req)).toString());
      if (CLONERS[voice] && existsSync(VOICE_SAMPLE))
        ensureCloner(voice).catch((e) => console.error(e));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { text } = JSON.parse((await body(req)).toString());
      if (busy) return json(res, 409, { error: "Still working on the last request." });
      busy = true;
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      const emit: Emit = (e) => res.write(`${JSON.stringify(e)}\n`);
      await logMessage("me", text);
      try {
        // The saved session may be gone (e.g. Claude's transcripts were cleared): start afresh.
        if (chat.sessionId && !(await getSessionInfo(chat.sessionId).catch(() => undefined))) {
          console.error("[agent] saved session not found, starting a new one");
          chat.sessionId = undefined;
        }
        const reply = await runTurn(text, emit);
        await logMessage("bot", reply);
        emit({ type: "reply", text: reply });
        emit({ type: "basket", basket: await basketSummary() });
      } catch (e) {
        console.error("[agent]", e);
        const msg = String((e as Error).message ?? e);
        await logMessage("sys", `Error: ${msg}`);
        emit({ type: "error", text: msg });
      } finally {
        busy = false;
        res.end();
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/basket")
      return json(res, 200, await basketSummary());
    if (req.method === "GET" && url.pathname === "/api/history")
      return json(res, 200, { messages: chat.messages, busy });
    if (req.method === "POST" && url.pathname === "/api/reset") {
      // Start afresh: archive the old log (one JSON line per conversation) rather than lose it.
      if (chat.messages.length)
        await appendFile(
          CHAT_ARCHIVE_PATH,
          `${JSON.stringify({ archivedAt: new Date().toISOString(), messages: chat.messages })}\n`,
        );
      chat.sessionId = undefined;
      chat.messages = [];
      await persistChat();
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET") {
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const path = resolve(HERE, "public", file);
      if (!path.startsWith(resolve(HERE, "public"))) return json(res, 403, { error: "forbidden" });
      const data = await readFile(path).catch(() => null);
      if (!data) return json(res, 404, { error: "not found" });
      return res
        .writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" })
        .end(data);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String((e as Error).message ?? e) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Voice shopping on http://localhost:${PORT}`));
