import { homedir } from "node:os";
import { join } from "node:path";
import { AuthExpiredError } from "../../errors.js";
import type { Session } from "../../models.js";
import { sessionFromCookies } from "../harvest.js";
import type { AuthBackend, Credentials } from "../types.js";

/**
 * Browser-minted auth backend (v1's confirmed path).
 *
 * A real Chrome satisfies Akamai's bot defenses natively, so we drive it to
 * log the user in once, then harvest the authenticated session — the
 * `OAuth.AccessToken` bearer, the `UUID` (customer-uuid), and the tesco.com
 * cookies. Every data-plane call afterwards is pure HTTP (see GraphQLTransport).
 *
 * Uses the system Chrome channel and a persistent profile so the session presents
 * as an ordinary browser. The stealth shim sets `navigator.webdriver` to match a
 * normal (non-automated) Chrome before any page scripts run.
 *
 * `playwright` is an OPTIONAL peer dependency — imported lazily so the core
 * library stays dependency-free for the (anonymous) read path and for
 * consumers that supply their own AuthBackend.
 */

const LOGIN_URL = "https://www.tesco.com/account/login";
const HOME_URL = "https://www.tesco.com/groceries/";
// soft-refresh=false forces a rotation even while the current token is still
// valid, so refresh() deterministically returns a fresh ~1h token. The endpoint
// redirects to `from` once the new token is written.
const REFRESH_URL =
  "https://www.tesco.com/account/auth/en-GB/refresh-token?soft-refresh=false" +
  "&from=https%3A%2F%2Fwww.tesco.com%2Fshop%2Fen-GB%2Flanding%2Fgroceries";

const DEFAULT_PROFILE_DIR = join(homedir(), ".basketeer", "chrome-profile");

// Runs before any page scripts; sets navigator properties to match a normal (non-automated) Chrome.
const STEALTH_INIT = `() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
}`;

export interface BrowserAuthOptions {
  /** Persistent Chrome profile dir (keeps you logged in across runs). */
  profileDir?: string;
  /** Use the installed Google Chrome channel (recommended for Akamai). */
  channel?: string;
  /**
   * Run refresh headless. Default false — a headless refresh is reliably
   * Akamai-blocked ("failed some security checks"), so refresh defaults to a
   * (brief) headed Chrome window, which Akamai accepts.
   */
  headlessRefresh?: boolean;
  /**
   * Without a TTY (e.g. run by an agent), `login()` can't wait for Enter, so it
   * polls until the sign-in cookies appear instead. Gives up after this many
   * milliseconds. Default 300000 (5 minutes).
   */
  loginTimeoutMs?: number;
}

export class BrowserAuthBackend implements AuthBackend {
  private readonly profileDir: string;
  private readonly channel: string;
  private readonly headlessRefresh: boolean;
  private readonly loginTimeoutMs: number;

  constructor(opts: BrowserAuthOptions = {}) {
    this.profileDir = opts.profileDir ?? DEFAULT_PROFILE_DIR;
    this.channel = opts.channel ?? "chrome";
    this.headlessRefresh = opts.headlessRefresh ?? false;
    this.loginTimeoutMs = opts.loginTimeoutMs ?? 300_000;
  }

  /**
   * Open a real Chrome, let the user sign in, then harvest the session. On a
   * TTY it waits for Enter; otherwise it polls until the `OAuth.AccessToken` +
   * `UUID` cookies appear (up to `loginTimeoutMs`).
   */
  async login(_credentials?: Credentials): Promise<Session> {
    const { chromium } = await this.loadPlaywright();
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: this.channel,
      headless: false,
      viewport: { width: 1280, height: 800 },
      locale: "en-GB",
      timezoneId: "Europe/London",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    try {
      await ctx.addInitScript(STEALTH_INIT);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(LOGIN_URL);

      if (process.stdin.isTTY) {
        console.log(`\n${"=".repeat(70)}`);
        console.log("TESCO LOGIN — a real Chrome window has opened.");
        console.log("  1. Sign in normally (username, password, 2FA if asked).");
        console.log("  2. Wait until you can see your account / the groceries homepage.");
        console.log("  3. Return here and press Enter to harvest the session.");
        console.log("=".repeat(70));
        await waitForEnter("\n  >>> Press Enter once you are logged in <<<\n");
      } else {
        // stderr, so a caller parsing stdout (e.g. the CLI's JSON) stays clean.
        process.stderr.write(
          `Sign in to Tesco in the Chrome window (waiting up to ${Math.round(this.loginTimeoutMs / 1000)}s)...\n`,
        );
        await waitForSignIn(page, ctx, this.loginTimeoutMs);
      }

      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      return sessionFromCookies(await ctx.cookies());
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  /**
   * Renew via the persistent profile. Akamai rejects a pure-HTTP refresh, but a
   * real (headed) Chrome carrying the profile's `_abck` state rotates the tokens
   * server-side, then redirects to the groceries landing. We wait for that to
   * complete — the new `OAuth.AccessToken` is only written *after* the redirect,
   * so harvesting too early returns the stale token. Throws
   * {@link AuthExpiredError} if the profile is no longer signed in.
   */
  async refresh(_session: Session): Promise<Session> {
    const { chromium } = await this.loadPlaywright();
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: this.channel,
      headless: this.headlessRefresh,
      locale: "en-GB",
      timezoneId: "Europe/London",
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    try {
      await ctx.addInitScript(STEALTH_INIT);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      const tokenNow = async (): Promise<string | undefined> =>
        (await ctx.cookies()).find((c) => c.name === "OAuth.AccessToken")?.value;

      const before = await tokenNow();
      await page
        .goto(REFRESH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => {});

      // Wait for the refresh to land: token rotates AND we leave the auth path.
      for (let i = 0; i < 20; i++) {
        const path = page.url().split("?")[0]!;
        if (path.includes("/account/login")) {
          throw new AuthExpiredError("Tesco session expired — interactive re-login required.");
        }
        const token = await tokenNow();
        if (token && token !== before && !path.includes("/account/auth")) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return sessionFromCookies(await ctx.cookies());
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  private async loadPlaywright(): Promise<typeof import("playwright")> {
    try {
      return await import("playwright");
    } catch {
      throw new Error(
        "BrowserAuthBackend needs the optional 'playwright' peer dependency. " +
          "Install it: npm i -D playwright && npx playwright install chromium",
      );
    }
  }
}

/** Minimal stdin Enter-gate (no deps). Resolves immediately if stdin is not a TTY. */
/** Poll until Tesco's sign-in cookies are set and the page has left the login form. */
async function waitForSignIn(
  page: { url(): string },
  ctx: { cookies(): Promise<{ name: string }[]> },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = new Set((await ctx.cookies()).map((c) => c.name));
    if (
      names.has("OAuth.AccessToken") &&
      names.has("UUID") &&
      !page.url().includes("/account/login")
    )
      return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new AuthExpiredError("Timed out waiting for Tesco sign-in in the browser.");
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve();
    process.stdout.write(prompt);
    const onData = () => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}
