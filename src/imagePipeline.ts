import axios from "axios";
import probe from "probe-image-size";
import { uploadBufferToB2 } from "./b2";
import { logger } from "./logger";

const STRICT_MANGA_FILTER = true;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPageBaseUrl(seriesSlug: string, chapter: number): string {
  return `${process.env.B2_DOWNLOAD_BASE}/${seriesSlug}/${chapter}`;
}

function getReferer(source?: string): string {
  if (source === "siyahmelek_api") {
    return "https://siyahmelek.site/";
  }

  return "https://mangtto.com/";
}

async function downloadImageBuffer(params: {
  url: string;
  source?: string;
}): Promise<Buffer> {
  const response = await axios.get<ArrayBuffer>(params.url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Referer: getReferer(params.source),
    },
  });

  return Buffer.from(response.data);
}

async function withRetry<T>(
  task: () => Promise<T>,
  retries = 5,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);

      logger.warn(
        `Deneme başarısız ${attempt}/${retries}. Bekleme: ${delay}ms`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function shouldSkipImage(buffer: Buffer, imageUrl: string): boolean {
  if (!STRICT_MANGA_FILTER) return false;

  try {
    const info = probe.sync(buffer);

    if (!info?.width || !info?.height) {
      logger.warn(`SKIP_INVALID_IMAGE | ${imageUrl}`);
      return true;
    }

    const isTooSmall = info.width < 500 || info.height < 700;

    const isSquareLike =
      info.width > 700 &&
      info.height > 700 &&
      Math.abs(info.width - info.height) < 120;

    if (isTooSmall || isSquareLike) {
      logger.warn(
        `SKIP_NON_MANGA_IMAGE | ${info.width}x${info.height} | ${imageUrl}`
      );
      return true;
    }

    logger.info(`IMAGE_OK | ${info.width}x${info.height} | ${imageUrl}`);
    return false;
  } catch (err) {
    logger.warn(
      `IMAGE_SIZE_CHECK_FAILED | ${imageUrl} | ${
        err instanceof Error ? err.message : String(err)
      }`
    );

    return true;
  }
}

export type UploadedChapterResult = {
  chapter: number;
  pageCount: number;
  baseUrl: string;
  pageUrls: string[];
};

export async function uploadChapterImages(params: {
  seriesSlug: string;
  chapter: number;
  imageUrls: string[];
  source?: string;
}): Promise<UploadedChapterResult> {
  const pageUrls: string[] = [];

  for (let i = 0; i < params.imageUrls.length; i++) {
    const imageUrl = params.imageUrls[i];

    logger.info(
      `İndiriliyor ve kontrol ediliyor | Chapter ${params.chapter} | Source Index ${
        i + 1
      } | ${imageUrl}`
    );

    const publicUrl = await withRetry(async () => {
      const buffer = await downloadImageBuffer({
        url: imageUrl,
        source: params.source,
      });

      if (shouldSkipImage(buffer, imageUrl)) {
        return "";
      }

      const pageNumber = pageUrls.length + 1;
      const key = `${params.seriesSlug}/${params.chapter}/${pageNumber}.jpg`;

      logger.info(
        `Yükleniyor | Chapter ${params.chapter} | Page ${pageNumber} | ${key}`
      );

      return uploadBufferToB2({
        key,
        buffer,
        contentType: "image/jpeg",
      });
    });

    if (!publicUrl) {
      continue;
    }

    pageUrls.push(publicUrl);

    await sleep(500);
  }

  return {
    chapter: params.chapter,
    pageCount: pageUrls.length,
    baseUrl: getPageBaseUrl(params.seriesSlug, params.chapter),
    pageUrls,
  };
}