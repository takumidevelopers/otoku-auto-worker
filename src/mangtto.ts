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
  const chapterList = buildChapterList(params.startChap, params.endChap);

  logger.info(
    `Tarama listesi hazırlandı | halfChapters=${ENABLE_HALF_CHAPTERS} | ${chapterList
      .map(formatChapter)
      .join(", ")}`
  );

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
      logger.info(`Chapter taranıyor: ${formatChapter(chap)}`);

      let result: ChapterSniffResult;

      try {
        result = await sniffChapter(page, params.sourceUrl, chap);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

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
        `CHAP ${formatChapter(chap)} | Bulunan manga sayfası: ${
          result.imageUrls.length
        }`
      );

      if (result.imageUrls.length === 0) {
        consecutiveMiss++;

        logger.warn(`Boş bölüm bulundu (${consecutiveMiss}/${missLimit})`);

        if (consecutiveMiss >= missLimit) {
          logger.warn(
            `${consecutiveMiss} bölüm üst üste boş geldi. Tarama durduruldu.`
          );
          break;
        }
      } else {
        consecutiveMiss = 0;
        results.push(result);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}