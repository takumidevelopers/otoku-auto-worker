import axios from "axios";
import { uploadBufferToB2 } from "./b2";
import { logger } from "./logger";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPageBaseUrl(seriesSlug: string, chapter: number): string {
  return `${process.env.B2_DOWNLOAD_BASE}/${seriesSlug}/${chapter}`;
}

async function downloadImageBuffer(url: string): Promise<Buffer> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Referer: "https://mangtto.com/",
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
}): Promise<UploadedChapterResult> {
  const pageUrls: string[] = [];

  for (let i = 0; i < params.imageUrls.length; i++) {
    const imageUrl = params.imageUrls[i];

    const pageNumber = i + 1;

    const key = `${params.seriesSlug}/${params.chapter}/${pageNumber}.jpg`;

    logger.info(
      `İndiriliyor ve yükleniyor | Chapter ${params.chapter} | Page ${pageNumber}`
    );

    const publicUrl = await withRetry(async () => {
      const buffer = await downloadImageBuffer(imageUrl);

      return uploadBufferToB2({
        key,
        buffer,
        contentType: "image/jpeg",
      });
    });

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