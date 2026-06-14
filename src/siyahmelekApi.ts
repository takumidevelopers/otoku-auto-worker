import axios from "axios";
import { logger } from "./logger";

export type SiyahMelekStorageType = "auto" | "amazon" | "uploads";

export type SiyahMelekChapterResult = {
  chapter: number;
  imageUrls: string[];
  storageBase: string;
};

const BASE_URLS: Record<Exclude<SiyahMelekStorageType, "auto">, string> = {
  amazon: "https://s3.melek.lol/api/amazon",
  uploads: "https://s3.melek.lol/api/uploads",
};

const EXTENSIONS = ["jpg", "webp", "png", "jpeg"];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildImageUrl(params: {
  baseUrl: string;
  externalSeriesId: string;
  chapter: number;
  page: number;
  ext: string;
}) {
  return `${params.baseUrl}/${params.externalSeriesId}/${params.chapter}/${String(
    params.page
  ).padStart(4, "0")}.${params.ext}`;
}

async function imageExists(url: string): Promise<boolean> {
  try {
    const response = await axios.head(url, {
      timeout: 12000,
      validateStatus: () => true,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://siyahmelek.site/",
      },
    });

    if (response.status >= 200 && response.status < 300) {
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      return contentType.includes("image");
    }

    return false;
  } catch {
    return false;
  }
}

async function findPageUrl(params: {
  externalSeriesId: string;
  chapter: number;
  page: number;
  storageType: SiyahMelekStorageType;
  preferredBase?: string | null;
}): Promise<{ url: string; baseUrl: string } | null> {
  const bases =
    params.storageType === "auto"
      ? [
          params.preferredBase,
          BASE_URLS.amazon,
          BASE_URLS.uploads,
        ].filter(Boolean) as string[]
      : [BASE_URLS[params.storageType]];

  const uniqueBases = Array.from(new Set(bases));

  for (const baseUrl of uniqueBases) {
    for (const ext of EXTENSIONS) {
      const url = buildImageUrl({
        baseUrl,
        externalSeriesId: params.externalSeriesId,
        chapter: params.chapter,
        page: params.page,
        ext,
      });

      const ok = await imageExists(url);

      if (ok) {
        return { url, baseUrl };
      }
    }
  }

  return null;
}

export async function scanSiyahMelekApiChapters(params: {
  externalSeriesId: string;
  startChap: number;
  endChap: number;
  storageType: SiyahMelekStorageType;
  pageStart?: number;
  pageMax?: number;
  missingLimit?: number;
}): Promise<SiyahMelekChapterResult[]> {
  const pageStart = params.pageStart || 1;
  const pageMax = params.pageMax || 160;
  const missingLimit = params.missingLimit || 5;

  const chapters: SiyahMelekChapterResult[] = [];

  for (let chapter = params.startChap; chapter <= params.endChap; chapter++) {
    logger.info(`SiyahMelek API bölüm taranıyor | Chapter: ${chapter}`);

    const imageUrls: string[] = [];
    let missingCount = 0;
    let selectedBase: string | null = null;

    for (let page = pageStart; page <= pageMax; page++) {
      const found = await findPageUrl({
        externalSeriesId: params.externalSeriesId,
        chapter,
        page,
        storageType: params.storageType,
        preferredBase: selectedBase,
      });

      if (!found) {
        missingCount++;

        logger.info(
          `SiyahMelek API sayfa yok | Chapter: ${chapter} | Page: ${page} | Missing: ${missingCount}/${missingLimit}`
        );

        if (missingCount >= missingLimit) {
          break;
        }

        await sleep(150);
        continue;
      }

      selectedBase = found.baseUrl;
      missingCount = 0;
      imageUrls.push(found.url);

      logger.info(
        `SiyahMelek API panel bulundu | Chapter: ${chapter} | Page: ${page} | URL: ${found.url}`
      );

      await sleep(150);
    }

    if (imageUrls.length === 0) {
      logger.warn(`SiyahMelek API bölüm boş geçti | Chapter: ${chapter}`);
      continue;
    }

    chapters.push({
      chapter,
      imageUrls,
      storageBase: selectedBase || "unknown",
    });

    logger.info(
      `SiyahMelek API bölüm tamam | Chapter: ${chapter} | Page Count: ${imageUrls.length}`
    );
  }

  return chapters;
}