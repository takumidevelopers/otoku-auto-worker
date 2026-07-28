import axios from "axios";
import probe from "probe-image-size";
import sharp from "sharp";
import { uploadBufferToB2 } from "./b2";
import { logger } from "./logger";
import { fetchNiveraBinary } from "./niveraTransport";

const STRICT_MANGA_FILTER = true;
const MAX_IMAGE_HEIGHT = 4096;
const JPEG_QUALITY = 95;

// LOW_MEMORY_IMAGE_PIPELINE_V6_1
// libvips cache ve paralel çalışan sharp işlerini sınırlar.
sharp.cache(false);
sharp.concurrency(1);

// 490px geniş manga sayfaları vardı; 500 olursa gerçek sayfayı çöpe atıyor.
const MIN_MANGA_WIDTH = 420;
const MIN_MANGA_HEIGHT = 700;

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

  if (source === "nivera" || source === "nivera_cdn") {
    return "https://niverafansub.one/";
  }

  return "https://mangtto.com/";
}

async function downloadImageBuffer(params: {
  url: string;
  source?: string;
}): Promise<Buffer> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    Referer: getReferer(params.source),
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  };

  if (params.source === "nivera" || params.source === "nivera_fansub") {
    const cookie = String(
      process.env.NIVERA_COOKIE || process.env.NIVERA_SESSION_COOKIE || ""
    ).trim();

    if (cookie) {
      headers.Cookie = cookie;
    }
  }

  try {
    const response = await axios.get<ArrayBuffer>(params.url, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxRedirects: 3,
      headers,
    });

    const contentType = String(response.headers?.["content-type"] || "").toLowerCase();

    if (
      (params.source === "nivera" || params.source === "nivera_fansub") &&
      !contentType.includes("image")
    ) {
      throw new Error(
        `Nivera görsel isteği image yerine ${contentType || "bilinmeyen içerik"} döndürdü.`
      );
    }

    return Buffer.from(response.data);
  } catch (error) {
    if (params.source !== "nivera" && params.source !== "nivera_fansub") {
      throw error;
    }

    logger.warn(
      `Nivera görseli Axios ile indirilemedi; TLS tarayıcı taklidi deneniyor | ${params.url}`
    );

    const result = await fetchNiveraBinary({
      url: params.url,
      referer: getReferer(params.source),
    });

    if (result.status < 200 || result.status >= 300 || result.buffer.length === 0) {
      throw new Error(
        `Nivera TLS görsel indirme başarısız | HTTP ${result.status} | ${params.url}`
      );
    }

    logger.info(
      `Nivera TLS görsel indirildi | Target: ${result.impersonate} | Bytes: ${result.buffer.length} | ${params.url}`
    );

    return result.buffer;
  }
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

    const isTooSmall =
      info.width < MIN_MANGA_WIDTH || info.height < MIN_MANGA_HEIGHT;

    const isSquareLike =
      info.width > 700 &&
      info.height > 700 &&
      Math.abs(info.width - info.height) < 120;

    if (isTooSmall || isSquareLike) {
      logger.warn(
        `SKIP_NON_MANGA_IMAGE | ${info.width}x${info.height} | min=${MIN_MANGA_WIDTH}x${MIN_MANGA_HEIGHT} | ${imageUrl}`
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

function formatMemoryUsageV610(): string {
  const usage = process.memoryUsage();

  const toMb = (bytes: number): string =>
    (bytes / 1024 / 1024).toFixed(1);

  return [
    `rss=${toMb(usage.rss)}MB`,
    `heap=${toMb(usage.heapUsed)}MB`,
    `external=${toMb(usage.external)}MB`,
    `arrayBuffers=${toMb(usage.arrayBuffers)}MB`,
  ].join(" | ");
}

async function yieldForNativeCleanupV610(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function uploadPageBufferV610(params: {
  seriesSlug: string;
  chapter: number;
  buffer: Buffer;
  pageUrls: string[];
}): Promise<void> {
  const pageNumber =
    params.pageUrls.length + 1;

  const key =
    `${params.seriesSlug}/${params.chapter}/${pageNumber}.jpg`;

  logger.info(
    `Yükleniyor | Chapter ${params.chapter} | Page ${pageNumber} | ${key}`
  );

  const publicUrl = await withRetry(
    () =>
      uploadBufferToB2({
        key,
        buffer: params.buffer,
        contentType: "image/jpeg",
      }),
    5,
    1500
  );

  params.pageUrls.push(publicUrl);
}

async function processAndUploadImageBufferV610(params: {
  buffer: Buffer;
  imageUrl: string;
  seriesSlug: string;
  chapter: number;
  pageUrls: string[];
}): Promise<void> {
  let metadata:
    sharp.Metadata | null = null;

  try {
    metadata = await sharp(
      params.buffer,
      {
        limitInputPixels: false,
        sequentialRead: true,
      }
    ).metadata();
  } catch (error) {
    logger.warn(
      `SPLIT_METADATA_FAILED | ${params.imageUrl} | ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }

  if (
    !metadata?.width ||
    !metadata?.height
  ) {
    logger.warn(
      `SPLIT_FALLBACK_ORIGINAL | Metadata yok | ${params.imageUrl}`
    );

    await uploadPageBufferV610({
      seriesSlug:
        params.seriesSlug,
      chapter:
        params.chapter,
      buffer:
        params.buffer,
      pageUrls:
        params.pageUrls,
    });

    return;
  }

  if (
    metadata.height <=
    MAX_IMAGE_HEIGHT
  ) {
    let normalized:
      Buffer;

    try {
      normalized =
        await sharp(
          params.buffer,
          {
            limitInputPixels:
              false,
            sequentialRead:
              true,
          }
        )
          .jpeg({
            quality:
              JPEG_QUALITY,
            /*
             * mozjpeg uzun görsellerde daha fazla CPU/native bellek
             * kullanabildiği için düşük bellek modunda kapalıdır.
             */
            mozjpeg:
              false,
          })
          .toBuffer();
    } catch (error) {
      logger.warn(
        `NORMALIZE_FAILED_USING_ORIGINAL | ${params.imageUrl} | ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );

      normalized =
        params.buffer;
    }

    logger.info(
      `SPLIT_NOT_NEEDED | ${metadata.width}x${metadata.height} | ${params.imageUrl}`
    );

    await uploadPageBufferV610({
      seriesSlug:
        params.seriesSlug,
      chapter:
        params.chapter,
      buffer:
        normalized,
      pageUrls:
        params.pageUrls,
    });

    await yieldForNativeCleanupV610();

    return;
  }

  const partCount =
    Math.ceil(
      metadata.height /
        MAX_IMAGE_HEIGHT
    );

  logger.info(
    `SPLIT_STREAM_START | ${metadata.width}x${metadata.height} -> ${partCount} parça | ${params.imageUrl}`
  );

  for (
    let top = 0;
    top < metadata.height;
    top += MAX_IMAGE_HEIGHT
  ) {
    const sliceHeight =
      Math.min(
        MAX_IMAGE_HEIGHT,
        metadata.height - top
      );

    /*
     * Yalnız tek parça bellekte tutulur.
     * B2 yüklemesi bitmeden sonraki parça oluşturulmaz.
     */
    const partBuffer =
      await sharp(
        params.buffer,
        {
          limitInputPixels:
            false,
          sequentialRead:
            true,
        }
      )
        .extract({
          left:
            0,
          top,
          width:
            metadata.width,
          height:
            sliceHeight,
        })
        .jpeg({
          quality:
            JPEG_QUALITY,
          mozjpeg:
            false,
        })
        .toBuffer();

    logger.info(
      `SPLIT_PART | ${metadata.width}x${metadata.height} | top=${top} | height=${sliceHeight} | ${params.imageUrl}`
    );

    await uploadPageBufferV610({
      seriesSlug:
        params.seriesSlug,
      chapter:
        params.chapter,
      buffer:
        partBuffer,
      pageUrls:
        params.pageUrls,
    });

    logger.info(
      `MEMORY_AFTER_PART | Chapter ${params.chapter} | ${formatMemoryUsageV610()}`
    );

    await yieldForNativeCleanupV610();
  }

  logger.info(
    `SPLIT_STREAM_DONE | ${metadata.width}x${metadata.height} -> ${partCount} parça | ${params.imageUrl}`
  );
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

    // ECONNRESET_UPLOAD_RETRY_V5_1
    const buffer = await withRetry(
      () =>
        downloadImageBuffer({
          url: imageUrl,
          source: params.source,
        }),
      5,
      1000
    );

    if (shouldSkipImage(buffer, imageUrl)) {
      await sleep(300);
      continue;
    }

    await processAndUploadImageBufferV610({
      buffer,
      imageUrl,
      seriesSlug:
        params.seriesSlug,
      chapter:
        params.chapter,
      pageUrls,
    });

    logger.info(
      `MEMORY_AFTER_SOURCE_IMAGE | Chapter ${params.chapter} | Source Index ${
        i + 1
      } | ${formatMemoryUsageV610()}`
    );

    /*
     * 300ms yerine kısa bir nefes verilir.
     * Native sharp belleğinin serbest kalmasına fırsat verirken
     * toplam yüklemeyi gereksiz yere yavaşlatmaz.
     */
    await sleep(100);
  }

  return {
    chapter: params.chapter,
    pageCount: pageUrls.length,
    baseUrl: getPageBaseUrl(params.seriesSlug, params.chapter),
    pageUrls,
  };
}
