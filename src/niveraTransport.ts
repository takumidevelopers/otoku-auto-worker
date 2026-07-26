import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);
const HELPER_TIMEOUT_MS = 90000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type NiveraTransportTextResult = {
  status: number;
  body: string;
  finalUrl: string;
  location: string;
  impersonate: string;
  diagnostics: string[];
};

export type NiveraTransportBinaryResult = {
  status: number;
  contentType: string;
  impersonate: string;
  buffer: Buffer;
};

function getCookie(): string {
  const cookie = String(
    process.env.NIVERA_COOKIE || process.env.NIVERA_SESSION_COOKIE || ""
  ).trim();

  if (!cookie) {
    throw new Error(
      "NIVERA_COOKIE tanımlı değil. Tarayıcıdaki Nivera Cookie başlığını proje .env dosyasına kaydet."
    );
  }

  return cookie;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveHelperPath(): Promise<string> {
  const configured = String(process.env.NIVERA_FETCH_HELPER || "").trim();
  const candidates = [
    configured,
    path.resolve(process.cwd(), "tools", "nivera_fetch.py"),
    path.resolve(__dirname, "..", "tools", "nivera_fetch.py"),
    path.resolve(__dirname, "..", "..", "tools", "nivera_fetch.py"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  throw new Error(
    `Nivera TLS helper bulunamadı. Aranan yollar: ${candidates.join(" | ")}`
  );
}

type PythonCandidate = { command: string; prefix: string[] };

async function resolvePython(): Promise<PythonCandidate> {
  const configured = String(process.env.NIVERA_PYTHON_EXE || "").trim();
  const candidates: PythonCandidate[] = [];

  if (configured) candidates.push({ command: configured, prefix: [] });

  if (process.platform === "win32") {
    candidates.push({ command: "py", prefix: ["-3"] });
    candidates.push({ command: "python", prefix: [] });
  } else {
    candidates.push({ command: "python3", prefix: [] });
    candidates.push({ command: "python", prefix: [] });
  }

  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = `${candidate.command}|${candidate.prefix.join(" ")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      await execFileAsync(candidate.command, [...candidate.prefix, "--version"], {
        timeout: 10000,
        windowsHide: true,
      });
      return candidate;
    } catch {
      // Sonraki Python adayını dene.
    }
  }

  throw new Error(
    "Python 3 bulunamadı. v3 kurulum scripti proje içindeki .nivera-python-venv yolunu NIVERA_PYTHON_EXE olarak ayarlamalıydı."
  );
}

async function runHelper(args: string[]): Promise<string> {
  const helperPath = await resolveHelperPath();
  const python = await resolvePython();

  const env = {
    ...process.env,
    NIVERA_COOKIE: getCookie(),
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };

  const result = await execFileAsync(
    python.command,
    [...python.prefix, helperPath, ...args],
    {
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
      env,
      encoding: "utf8",
    }
  );

  if (result.stderr?.trim()) {
    logger.info(`Nivera TLS helper | ${result.stderr.trim()}`);
  }

  return String(result.stdout || "").trim();
}


function looksBlocked(result: NiveraTransportTextResult): boolean {
  const target = `${result.location} ${result.finalUrl}`.toLowerCase();
  if (target.includes("/bilgilendirme")) return true;
  if ([301, 302, 303, 307, 308, 401, 403].includes(result.status)) return true;
  if (!result.body.includes("wp-manga-chapter-img")) return true;
  return false;
}

function parseCookieHeader(cookieHeader: string, url: string) {
  const hostname = new URL(url).hostname;
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return null;
      return {
        name: part.slice(0, index).trim(),
        value: part.slice(index + 1).trim(),
        domain: hostname,
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax" as const,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

async function fetchViaBrowser(params: {
  url: string;
  referer?: string;
  warmUrls?: string[];
  diagnostics: string[];
}): Promise<NiveraTransportTextResult | null> {
  if (String(process.env.NIVERA_BROWSER_FALLBACK || "1") === "0") {
    return null;
  }

  let playwright: any;
  try {
    // require kullanımı, Playwright'ı yalnızca TLS yöntemi başarısız olursa yükler.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    playwright = require("playwright");
  } catch (error) {
    params.diagnostics.push(
      `browser:playwright-yok:${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  const profileDir = path.resolve(
    process.env.NIVERA_BROWSER_PROFILE_DIR ||
      path.join(process.cwd(), ".nivera-browser-profile-v3")
  );

  let context: any = null;

  try {
    logger.warn(
      "Nivera TLS taklidi yönlendirildi; gerçek Chromium taşıma katmanı otomatik deneniyor. Kullanıcı etkileşimi gerekmeyecek."
    );

    context = await playwright.chromium.launchPersistentContext(profileDir, {
      headless: process.platform !== "win32",
      viewport: { width: 1365, height: 900 },
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      ignoreHTTPSErrors: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-position=-32000,-32000",
        "--window-size=1365,900",
      ],
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", {
        get: () => ["tr-TR", "tr", "en-US", "en"],
      });
    });

    await context.addCookies(parseCookieHeader(getCookie(), params.url));

    const page = context.pages()[0] || (await context.newPage());

    await page.route("**/*", async (route: any) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    for (const warmUrl of params.warmUrls || []) {
      try {
        await page.goto(warmUrl, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
          referer: params.referer,
        });
      } catch {
        // Hedef bölüm isteği yine de denenir.
      }
    }

    let response = await page.goto(params.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
      referer: params.referer,
    });
    await page.waitForTimeout(750);

    let body = await page.content();
    let finalUrl = page.url();
    let status = Number(response?.status?.() || 0);

    if (finalUrl.toLowerCase().includes("/bilgilendirme")) {
      response = await page.goto(params.url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
        referer: params.referer,
      });
      await page.waitForTimeout(750);
      body = await page.content();
      finalUrl = page.url();
      status = Number(response?.status?.() || 0);
    }

    params.diagnostics.push(
      `browser:status=${status}:url=${finalUrl}:body=${body.length}`
    );

    if (
      status >= 200 &&
      status < 300 &&
      body.includes("wp-manga-chapter-img")
    ) {
      return {
        status,
        body,
        finalUrl,
        location: "",
        impersonate: "chromium-browser",
        diagnostics: params.diagnostics,
      };
    }

    return null;
  } catch (error) {
    params.diagnostics.push(
      `browser:error=${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  } finally {
    await context?.close().catch(() => undefined);
  }
}

export async function fetchNiveraText(params: {
  url: string;
  referer?: string;
  warmUrls?: string[];
}): Promise<NiveraTransportTextResult> {
  const args = ["text", "--url", params.url];

  if (params.referer) args.push("--referer", params.referer);
  for (const warmUrl of params.warmUrls || []) {
    args.push("--warm-url", warmUrl);
  }

  const stdout = await runHelper(args);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Nivera TLS helper geçersiz JSON döndürdü: ${stdout.slice(0, 300)}`
    );
  }

  const value = parsed as Partial<NiveraTransportTextResult>;

  const result: NiveraTransportTextResult = {
    status: Number(value.status || 0),
    body: String(value.body || ""),
    finalUrl: String(value.finalUrl || params.url),
    location: String(value.location || ""),
    impersonate: String(value.impersonate || "unknown"),
    diagnostics: Array.isArray(value.diagnostics)
      ? value.diagnostics.map(String)
      : [],
  };

  if (!looksBlocked(result)) return result;

  const browser = await fetchViaBrowser({
    url: params.url,
    referer: params.referer,
    warmUrls: params.warmUrls,
    diagnostics: result.diagnostics,
  });

  return browser || result;
}

export async function fetchNiveraBinary(params: {
  url: string;
  referer?: string;
}): Promise<NiveraTransportBinaryResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nivera-image-"));
  const outputPath = path.join(tempDir, "payload.bin");

  try {
    const args = [
      "binary",
      "--url",
      params.url,
      "--output",
      outputPath,
    ];

    if (params.referer) args.push("--referer", params.referer);

    const stdout = await runHelper(args);
    const value = JSON.parse(stdout) as {
      status?: number;
      contentType?: string;
      impersonate?: string;
    };

    const buffer = await fs.readFile(outputPath);

    return {
      status: Number(value.status || 0),
      contentType: String(value.contentType || ""),
      impersonate: String(value.impersonate || "unknown"),
      buffer,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
