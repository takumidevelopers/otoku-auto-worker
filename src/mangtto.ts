import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { chromium, Page, Response } from "playwright";
import { logger } from "./logger";

const ENABLE_HALF_CHAPTERS = true;

const IMG_RE =
  /https?:\/\/[^\s"'\\]+?\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?[^\s"'\\]*)?/gi;

const BLOCKED_IMAGE_PARTS = [
  "anilistcdn",
  "/cover/",
  "/banner/",
  "/avatar/",
  "/logo/",
  "/ads/",
  "/advert",
  "doubleclick",
  "google",
  "facebook",
  "/_ipx/",
  "mangtto-hd.png",
  "thumbnail",
  "thumb",
  "profile",
  "icon",
  "character",
  "portrait",
  "default",
];

const ALLOWED_IMAGE_HOST_PARTS = [
  "cdn.zukrein.com",
  "zukrein.com",
  "mangtto.com",
  "mangatoo",
  "mangakakalot",
  "ggpht",
];

export type ChapterSniffResult = {
  chapter: number;
  url: string;
  imageUrls: string[];
};

/*
|--------------------------------------------------------------------------
| MANGTTO_PROGRESSIVE_SCAN_CACHE_V6_2
|--------------------------------------------------------------------------
*/

const MANGTTO_SCAN_CACHE_VERSION_V620 = 1;

const MANGTTO_SCAN_CACHE_TTL_MS_V620 =
  Math.max(
    5 * 60 * 1000,
    Number(
      process.env.MANGTTO_SCAN_CACHE_TTL_MS ||
        24 * 60 * 60 * 1000
    )
  );

const MANGTTO_SCAN_CACHE_DIR_V620 =
  path.resolve(
    process.env.MANGTTO_SCAN_CACHE_DIR ||
      path.join(
        tmpdir(),
        "otoku-worker-mangtto-scan-cache"
      )
  );

type MangttoScanCacheV620 = {
  version: number;
  sourceUrl: string;
  updatedAt: string;
  chapters: ChapterSniffResult[];
};

function normalizeMangttoSeriesUrlV620(
  sourceUrl: string
): string {
  return sourceUrl
    .split("#")[0]
    .replace(/\/$/, "")
    .trim()
    .toLowerCase();
}

function chapterCacheKeyV620(
  chapter: number
): string {
  return Number(chapter.toFixed(2)).toString();
}

function mangttoCacheFileV620(
  sourceUrl: string
): string {
  const normalized =
    normalizeMangttoSeriesUrlV620(sourceUrl);

  const hash =
    createHash("sha256")
      .update(normalized)
      .digest("hex")
      .slice(0, 24);

  return path.join(
    MANGTTO_SCAN_CACHE_DIR_V620,
    `${hash}.json`
  );
}

async function removeMangttoCacheFileV620(
  filePath: string
): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Cache temizliği ana işi durdurmamalı.
  }
}

async function loadMangttoScanCacheV620(
  sourceUrl: string
): Promise<Map<string, ChapterSniffResult>> {
  const filePath =
    mangttoCacheFileV620(sourceUrl);

  try {
    const raw =
      await fs.readFile(filePath, "utf8");

    const parsed =
      JSON.parse(raw) as MangttoScanCacheV620;

    if (
      parsed.version !== MANGTTO_SCAN_CACHE_VERSION_V620 ||
      normalizeMangttoSeriesUrlV620(parsed.sourceUrl) !==
        normalizeMangttoSeriesUrlV620(sourceUrl) ||
      !Array.isArray(parsed.chapters)
    ) {
      await removeMangttoCacheFileV620(filePath);
      return new Map();
    }

    const updatedAt = Date.parse(parsed.updatedAt);

    if (
      !Number.isFinite(updatedAt) ||
      Date.now() - updatedAt >
        MANGTTO_SCAN_CACHE_TTL_MS_V620
    ) {
      logger.info(
        `MANGTTO_SCAN_CACHE_EXPIRED | ${filePath}`
      );

      await removeMangttoCacheFileV620(filePath);
      return new Map();
    }

    const cache =
      new Map<string, ChapterSniffResult>();

    for (const chapter of parsed.chapters) {
      if (
        !Number.isFinite(Number(chapter.chapter)) ||
        !Array.isArray(chapter.imageUrls) ||
        chapter.imageUrls.length === 0
      ) {
        continue;
      }

      cache.set(
        chapterCacheKeyV620(Number(chapter.chapter)),
        {
          chapter: Number(chapter.chapter),
          url: String(chapter.url || ""),
          imageUrls: uniqueSortedImages(chapter.imageUrls),
        }
      );
    }

    logger.info(
      `MANGTTO_SCAN_CACHE_LOADED | Bölüm: ${cache.size} | Dosya: ${filePath}`
    );

    return cache;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error
        ? String(error.code || "")
        : "";

    if (code !== "ENOENT") {
      logger.warn(
        `MANGTTO_SCAN_CACHE_READ_FAILED | ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );
    }

    return new Map();
  }
}

async function saveMangttoScanCacheV620(
  sourceUrl: string,
  chapters: Map<string, ChapterSniffResult>
): Promise<void> {
  const filePath =
    mangttoCacheFileV620(sourceUrl);

  const tempPath =
    `${filePath}.${process.pid}.tmp`;

  const payload: MangttoScanCacheV620 = {
    version: MANGTTO_SCAN_CACHE_VERSION_V620,
    sourceUrl:
      normalizeMangttoSeriesUrlV620(sourceUrl),
    updatedAt: new Date().toISOString(),
    chapters:
      Array.from(chapters.values()).sort(
        (a, b) => a.chapter - b.chapter
      ),
  };

  try {
    await fs.mkdir(
      MANGTTO_SCAN_CACHE_DIR_V620,
      { recursive: true }
    );

    await fs.writeFile(
      tempPath,
      JSON.stringify(payload),
      "utf8"
    );

    await removeMangttoCacheFileV620(filePath);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await removeMangttoCacheFileV620(tempPath);

    logger.warn(
      `MANGTTO_SCAN_CACHE_WRITE_FAILED | ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }
}


function formatChapter(chapter: number): string {
  if (Number.isInteger(chapter)) return String(chapter);
  return Number(chapter.toFixed(2)).toString();
}

export function buildChapterUrl(sourceUrl: string, chapter: number): string {
  const clean = sourceUrl.split("#")[0].replace(/\/$/, "");
  const chapterText = formatChapter(chapter);

  if (/\/\d+(?:\.\d+)?$/.test(clean)) {
    return clean.replace(/\/\d+(?:\.\d+)?$/, `/${chapterText}#0`);
  }

  return `${clean}/${chapterText}#0`;
}

function normalizeImageUrl(url: string): string {
  return url
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();
}

function isValidMangaPageImage(url: string): boolean {
  const normalized = normalizeImageUrl(url).toLowerCase();

  if (!/^https?:\/\//.test(normalized)) return false;

  if (!/\.(jpg|jpeg|png|webp|avif|gif)(\?|$)/i.test(normalized)) {
    return false;
  }

  if (BLOCKED_IMAGE_PARTS.some((part) => normalized.includes(part))) {
    return false;
  }

  if (normalized.includes("favicon")) return false;
  if (normalized.includes("placeholder")) return false;
  if (normalized.includes("loading")) return false;

  return ALLOWED_IMAGE_HOST_PARTS.some((host) => normalized.includes(host));
}

function extractPageNumber(url: string): number {
  const clean = normalizeImageUrl(url);

  const patterns = [
    /\/(\d+)-[^/]+\.(?:jpg|jpeg|png|webp|avif|gif)/i,
    /\/(\d+)\.(?:jpg|jpeg|png|webp|avif|gif)/i,
    /(?:page|p|img|image)[_-]?(\d+)/i,
    /[?&](?:page|p)=([0-9]+)/i,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }

  return 999999;
}

function uniqueSortedImages(urls: string[]): string[] {
  return Array.from(new Set(urls.map(normalizeImageUrl)))
    .filter(isValidMangaPageImage)
    .sort((a, b) => {
      const pageA = extractPageNumber(a);
      const pageB = extractPageNumber(b);

      if (pageA !== pageB) return pageA - pageB;
      return a.localeCompare(b);
    });
}

async function collectImagesFromDom(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const urls = new Set<string>();

    const pushValue = (value: string | null | undefined) => {
      if (!value) return;

      const parts = value
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean);

      for (const part of parts) {
        if (part.startsWith("http")) urls.add(part);
      }
    };

    document.querySelectorAll("img").forEach((img) => {
      pushValue(img.getAttribute("src"));
      pushValue(img.getAttribute("data-src"));
      pushValue(img.getAttribute("data-original"));
      pushValue(img.getAttribute("data-lazy-src"));
      pushValue(img.getAttribute("data-url"));
      pushValue(img.getAttribute("srcset"));
      pushValue(img.getAttribute("data-srcset"));
    });

    document.querySelectorAll("source").forEach((source) => {
      pushValue(source.getAttribute("srcset"));
      pushValue(source.getAttribute("data-srcset"));
    });

    document.querySelectorAll("[style]").forEach((el) => {
      const style = el.getAttribute("style") || "";
      const matches =
        style.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/gi) || [];

      for (const match of matches) {
        const url = match
          .replace(/^url\(["']?/i, "")
          .replace(/["']?\)$/i, "");

        pushValue(url);
      }
    });

    return Array.from(urls);
  });
}

async function autoScroll(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 3500);
    await page.waitForTimeout(700);
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
}

async function sniffChapter(
  page: Page,
  sourceUrl: string,
  chapter: number
): Promise<ChapterSniffResult> {
  const url = buildChapterUrl(sourceUrl, chapter);

  const hits = new Set<string>();
  const imageEndpoints = new Set<string>();

  const onResponse = async (resp: Response) => {
    try {
      const responseUrl = normalizeImageUrl(resp.url());
      const ct = (resp.headers()["content-type"] || "").toLowerCase();

      if (isValidMangaPageImage(responseUrl)) {
        imageEndpoints.add(responseUrl);
      }

      if (
        ct.includes("application/json") ||
        ct.includes("text/html") ||
        ct.includes("application/javascript") ||
        ct.includes("text/plain")
      ) {
        const text = await resp.text();
        const matches = text.match(IMG_RE) || [];

        for (const img of matches) {
          const normalized = normalizeImageUrl(img);

          if (isValidMangaPageImage(normalized)) {
            hits.add(normalized);
          }
        }
      }

      if (ct.startsWith("image/") && isValidMangaPageImage(responseUrl)) {
        imageEndpoints.add(responseUrl);
      }
    } catch {
      // Bazı response body'leri okunamayabilir.
    }
  };

  page.on("response", onResponse);

  try {
    try {
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: 60000,
      });
    } catch {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    await autoScroll(page);

    const domImages = await collectImagesFromDom(page);
    for (const img of domImages) {
      if (isValidMangaPageImage(img)) {
        hits.add(normalizeImageUrl(img));
      }
    }

    const html = await page.content();
    const matches = html.match(IMG_RE) || [];

    for (const img of matches) {
      const normalized = normalizeImageUrl(img);

      if (isValidMangaPageImage(normalized)) {
        hits.add(normalized);
      }
    }
  } finally {
    page.off("response", onResponse);
  }

  const imageUrls = uniqueSortedImages([...hits, ...imageEndpoints]);

  return {
    chapter,
    url,
    imageUrls,
  };
}

function buildChapterList(startChap: number, endChap: number): number[] {
  const chapters: number[] = [];

  if (!ENABLE_HALF_CHAPTERS) {
    const start = Math.ceil(startChap);
    const end = Math.floor(endChap);

    for (let value = start; value <= end; value++) {
      chapters.push(value);
    }

    return chapters;
  }

  const start = Math.round(startChap * 2);
  const end = Math.round(endChap * 2);

  for (let value = start; value <= end; value++) {
    chapters.push(value / 2);
  }

  return chapters;
}

export async function scanMangttoChapters(params: {
  sourceUrl: string;
  startChap: number;
  endChap: number;
  missLimit?: number;
}): Promise<ChapterSniffResult[]> {
  const results: ChapterSniffResult[] = [];
  let consecutiveMiss = 0;

  const missLimit = params.missLimit || 5;
  const chapterList =
    buildChapterList(params.startChap, params.endChap);

  logger.info(
    `Tarama listesi hazırlandı | halfChapters=${ENABLE_HALF_CHAPTERS} | ${chapterList
      .map(formatChapter)
      .join(", ")}`
  );

  const cachedByChapter =
    await loadMangttoScanCacheV620(
      params.sourceUrl
    );

  const missingChapterCount =
    chapterList.filter(
      (chapter) =>
        !cachedByChapter.has(
          chapterCacheKeyV620(chapter)
        )
    ).length;

  logger.info(
    `MANGTTO_SCAN_CACHE_STATUS | Hit: ${
      chapterList.length - missingChapterCount
    } | Missing: ${missingChapterCount} | Requested: ${chapterList.length}`
  );

  if (missingChapterCount === 0) {
    for (const chapter of chapterList) {
      const cached =
        cachedByChapter.get(
          chapterCacheKeyV620(chapter)
        );

      if (cached) {
        logger.info(
          `MANGTTO_SCAN_CACHE_HIT | Chapter: ${formatChapter(
            chapter
          )} | Görsel: ${cached.imageUrls.length}`
        );
        results.push(cached);
      }
    }

    return results;
  }

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    viewport: {
      width: 1366,
      height: 2200,
    },
  });

  const page = await context.newPage();

  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    for (const chap of chapterList) {
      const cacheKey =
        chapterCacheKeyV620(chap);

      const cached =
        cachedByChapter.get(cacheKey);

      if (cached && cached.imageUrls.length > 0) {
        consecutiveMiss = 0;

        logger.info(
          `MANGTTO_SCAN_CACHE_HIT | Chapter: ${formatChapter(
            chap
          )} | Görsel: ${cached.imageUrls.length}`
        );

        results.push(cached);
        continue;
      }

      logger.info(
        `Chapter taranıyor: ${formatChapter(chap)}`
      );

      let result: ChapterSniffResult;

      try {
        result =
          await sniffChapter(
            page,
            params.sourceUrl,
            chap
          );
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : String(err);

        consecutiveMiss++;

        logger.warn(
          `CHAP ${formatChapter(
            chap
          )} okunamadı, boş sayıldı. Üst üste boş/hatalı: ${consecutiveMiss}/${missLimit}`
        );

        logger.warn(message);

        if (consecutiveMiss >= missLimit) {
          logger.warn(
            `${consecutiveMiss} bölüm üst üste boş/hatalı geldi. Tarama durduruldu.`
          );
          break;
        }

        continue;
      }

      logger.info(
        `CHAP ${formatChapter(
          chap
        )} | Bulunan manga sayfası: ${result.imageUrls.length}`
      );

      if (result.imageUrls.length === 0) {
        consecutiveMiss++;

        logger.warn(
          `Boş bölüm bulundu (${consecutiveMiss}/${missLimit})`
        );

        if (consecutiveMiss >= missLimit) {
          logger.warn(
            `${consecutiveMiss} bölüm üst üste boş geldi. Tarama durduruldu.`
          );
          break;
        }
      } else {
        consecutiveMiss = 0;

        cachedByChapter.set(cacheKey, result);

        await saveMangttoScanCacheV620(
          params.sourceUrl,
          cachedByChapter
        );

        logger.info(
          `MANGTTO_SCAN_CACHE_SAVED | Chapter: ${formatChapter(
            chap
          )} | Toplam cache: ${cachedByChapter.size}`
        );

        results.push(result);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

