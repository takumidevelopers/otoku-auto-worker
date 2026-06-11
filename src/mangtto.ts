import { chromium, Page, Response } from "playwright";
import { logger } from "./logger";

const IMG_RE =
  /https?:\/\/[^\s"']+?\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?[^\s"']*)?/gi;

export type ChapterSniffResult = {
  chapter: number;
  url: string;
  imageUrls: string[];
};

export function buildChapterUrl(sourceUrl: string, chapter: number): string {
  const clean = sourceUrl.split("#")[0].replace(/\/$/, "");

  if (/\/\d+$/.test(clean)) {
    return clean.replace(/\/\d+$/, `/${chapter}#0`);
  }

  return `${clean}/${chapter}#0`;
}

function isValidMangaPageImage(url: string): boolean {
  return (
    url.includes("cdn.zukrein.com") &&
    !url.includes("anilistcdn") &&
    !url.includes("/cover/") &&
    !url.includes("/banner/")
  );
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
      const ct = (resp.headers()["content-type"] || "").toLowerCase();

      if (
        ct.includes("application/json") ||
        ct.includes("text/html") ||
        ct.includes("application/javascript") ||
        ct.includes("text/plain")
      ) {
        const text = await resp.text();
        const matches = text.match(IMG_RE) || [];

        for (const img of matches) {
          if (isValidMangaPageImage(img)) {
            hits.add(img);
          }
        }
      }

      if (ct.startsWith("image/")) {
        const imageUrl = resp.url();

        if (isValidMangaPageImage(imageUrl)) {
          imageEndpoints.add(imageUrl);
        }
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

    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(2000);
  } finally {
    page.off("response", onResponse);
  }

  const imageUrls = Array.from(new Set([...hits, ...imageEndpoints]))
    .filter(isValidMangaPageImage)
    .sort((a, b) => {
      const pageA = Number(a.match(/\/(\d+)-/)?.[1] || 0);
      const pageB = Number(b.match(/\/(\d+)-/)?.[1] || 0);
      return pageA - pageB;
    });

  return {
    chapter,
    url,
    imageUrls,
  };
}

export async function scanMangttoChapters(params: {
  sourceUrl: string;
  startChap: number;
  endChap: number;
  missLimit?: number;
}): Promise<ChapterSniffResult[]> {
  const results: ChapterSniffResult[] = [];
  let consecutiveMiss = 0;

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    for (let chap = params.startChap; chap <= params.endChap; chap++) {
      logger.info(`Chapter taranıyor: ${chap}`);

      let result: ChapterSniffResult;

      try {
        result = await sniffChapter(page, params.sourceUrl, chap);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        consecutiveMiss++;

        logger.warn(
          `CHAP ${chap} okunamadı, boş sayıldı. Üst üste boş/hatalı: ${consecutiveMiss}/${
            params.missLimit || 5
          }`
        );

        logger.warn(message);

        if (consecutiveMiss >= (params.missLimit || 5)) {
          logger.warn(
            `${consecutiveMiss} bölüm üst üste boş/hatalı geldi. Tarama durduruldu.`
          );
          break;
        }

        continue;
      }

      logger.info(
        `CHAP ${chap} | Bulunan manga sayfası: ${result.imageUrls.length}`
      );

      if (result.imageUrls.length === 0) {
        consecutiveMiss++;

        logger.warn(
          `Boş bölüm bulundu (${consecutiveMiss}/${params.missLimit || 5})`
        );

        if (consecutiveMiss >= (params.missLimit || 5)) {
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