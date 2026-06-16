import { logger } from "./logger";
import {
  ImportJob,
  getNextImportJob,
  updateImportJobStatus,
  upsertSeries,
  upsertChapter,
  upsertSeriesCategory,
  getAvailableSeriesSlug,
} from "./otokuApi";
import { scanMangttoChapters, ChapterSniffResult } from "./mangtto";
import { uploadChapterImages } from "./imagePipeline";
import { searchAniListByTitle } from "./anilist";
import {
  scanSiyahMelekApiChapters,
  SiyahMelekStorageType,
} from "./siyahmelekApi";

export type ImportRunResult = {
  hasJob: boolean;
  completed: boolean;
  chapterCount: number;
  jobId?: number;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractSlugFromMangttoUrl(url: string): string {
  const clean = url.split("#")[0].replace(/\/$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || "unknown-series";
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapAniListStatus(status: string | null): string {
  switch (status) {
    case "FINISHED":
      return "Final";
    case "RELEASING":
      return "Devam Ediyor";
    case "HIATUS":
      return "Ara Verildi";
    case "CANCELLED":
      return "İptal";
    default:
      return "Devam Ediyor";
  }
}

function buildSearchName(params: {
  titleRomaji?: string | null;
  titleEnglish?: string | null;
  titleNative?: string | null;
  synonyms?: string[];
  fallbackTitle: string;
}): string {
  return [
    params.titleRomaji,
    params.titleEnglish,
    params.titleNative,
    params.fallbackTitle,
    ...(params.synonyms || []),
  ]
    .filter(Boolean)
    .map((item) => String(item).trim())
    .filter((item, index, arr) => item && arr.indexOf(item) === index)
    .join(" | ");
}

function chapterFingerprint(chapter: ChapterSniffResult): string {
  const first = chapter.imageUrls[0] || "";
  const last = chapter.imageUrls[chapter.imageUrls.length - 1] || "";
  return `${chapter.imageUrls.length}|${first}|${last}`;
}

function dedupeChapters(chapters: ChapterSniffResult[]): ChapterSniffResult[] {
  const seen = new Set<string>();
  const clean: ChapterSniffResult[] = [];

  for (const chapter of chapters) {
    const fingerprint = chapterFingerprint(chapter);

    if (seen.has(fingerprint)) {
      logger.warn(
        `Duplicate bölüm atlandı | Kaynak Chapter: ${chapter.chapter} | Sayfa: ${chapter.imageUrls.length}`
      );
      continue;
    }

    seen.add(fingerprint);
    clean.push(chapter);
  }

  return clean;
}

const CATEGORY_MAP: Record<string, { categoryId: string; categoryName: string }> = {
  Action: {
    categoryId: "4d02fb80-bf13-1f1c-a625-db67f5960e05",
    categoryName: "Aksiyon",
  },
  Adventure: {
    categoryId: "2233b700-c07b-1f1c-a852-136456248b23",
    categoryName: "Macera",
  },
  Comedy: {
    categoryId: "8f067100-aa05-1fa9-9541-cb135500a5f1",
    categoryName: "Komedi",
  },
  Drama: {
    categoryId: "a4ef4000-bfaf-1f1c-a852-136456248b23",
    categoryName: "Dram",
  },
  Fantasy: {
    categoryId: "05579f00-bffb-1f1c-a852-136456248b23",
    categoryName: "Fantastik",
  },
  Romance: {
    categoryId: "8cffe500-c0b1-1f1c-a852-136456248b23",
    categoryName: "Romantizm",
  },
  Mystery: {
    categoryId: "0e74b400-b2c4-1f89-a762-f713b723b19b",
    categoryName: "Gizem",
  },
  Horror: {
    categoryId: "f2f33600-b8bf-1f61-88f9-1713f1432f02",
    categoryName: "Korku",
  },
  Psychological: {
    categoryId: "1ac6f000-bb85-1f61-88f9-1713f1432f02",
    categoryName: "Psikolojik",
  },
  "Sci-Fi": {
    categoryId: "f7f02980-0525-1fe9-9867-5d2a24dc4a60",
    categoryName: "Bilim kurgu",
  },
  "Slice of Life": {
    categoryId: "3301c2c0-1d3d-11f1-aa1c-9724818e3aa0",
    categoryName: "Slice of Life",
  },
  Sports: {
    categoryId: "29163d90-1d3d-11f1-aa1c-9724818e3aa0",
    categoryName: "Spor",
  },
  Supernatural: {
    categoryId: "56f03180-bfdb-1f1c-a852-136456248b23",
    categoryName: "Doğaüstü",
  },
  Thriller: {
    categoryId: "90fccd80-b39c-1f93-a586-e5430daa0084",
    categoryName: "Gerilim",
  },
  Adult: {
    categoryId: "1eb95b00-9907-1f87-9f0f-3bf7876439e9",
    categoryName: "+18",
  },
};

async function applyCategories(params: {
  seriesId: string;
  genres: string[];
  forceAdult?: boolean;
}) {
  for (const genre of params.genres) {
    const mapped = CATEGORY_MAP[genre];

    if (!mapped) {
      logger.warn(`Kategori eşleşmedi, atlandı: ${genre}`);
      continue;
    }

    await upsertSeriesCategory({
      seriesId: params.seriesId,
      categoryId: mapped.categoryId,
      categoryName: mapped.categoryName,
    });

    logger.info(`Kategori eklendi | ${mapped.categoryName}`);
  }

  await upsertSeriesCategory({
    seriesId: params.seriesId,
    categoryId: "eceaae80-c1cb-1f1c-a852-136456248b23",
    categoryName: "Manga",
  });

  logger.info("Varsayılan kategori eklendi | Manga");

  if (params.forceAdult) {
    await upsertSeriesCategory({
      seriesId: params.seriesId,
      categoryId: CATEGORY_MAP.Adult.categoryId,
      categoryName: CATEGORY_MAP.Adult.categoryName,
    });

    logger.info("Zorunlu kategori eklendi | +18");
  }
}

function normalizeStorageType(value: unknown): SiyahMelekStorageType {
  const clean = String(value || "auto").trim().toLowerCase();

  if (clean === "amazon" || clean === "uploads" || clean === "auto") {
    return clean;
  }

  return "auto";
}

function normalizeSource(job: ImportJob): string {
  return String(job.source || "mangtto").trim().toLowerCase();
}

function getSiyahMelekSeriesName(job: ImportJob): string {
  const nameFromForm = String(job.source_name || "").trim();

  if (!nameFromForm || nameFromForm === "siyahmelek_api") {
    throw new Error("SiyahMelek API job için formdan gelen seri adı boş olamaz.");
  }

  return nameFromForm;
}

async function runSiyahMelekApiJob(job: ImportJob): Promise<number> {
  const externalSeriesId = String(job.external_series_id || "").trim();

  if (!externalSeriesId) {
    throw new Error("SiyahMelek API job için external_series_id boş olamaz.");
  }

  const seriesName = getSiyahMelekSeriesName(job);

  const baseSlug = slugify(seriesName);
  let seriesSlug = baseSlug || `siyahmelek-${externalSeriesId}`;

  seriesSlug = await getAvailableSeriesSlug(seriesSlug);

  logger.info(
    `SiyahMelek seri slug seçildi | Form Seri Adı: ${seriesName} | Slug: ${seriesSlug}`
  );

  const chapters = await scanSiyahMelekApiChapters({
    externalSeriesId,
    startChap: Number(job.start_chap),
    endChap: Number(job.end_chap),
    storageType: normalizeStorageType(job.storage_type),
    pageStart: Number(job.page_start || 1),
    pageMax: Number(job.page_max || 160),
    missingLimit: 5,
  });

  if (chapters.length === 0) {
    throw new Error("SiyahMelek API üzerinden hiç bölüm bulunamadı.");
  }

  const series = await upsertSeries({
    name: seriesName,
    seriesuid: seriesSlug,
    coverImageUrl: "",
    des: "Henüz açıklama eklenmedi.",
    kaynak: "SiyahMelek",
    final: "Devam Ediyor",
    searchName: seriesName,
  });

  logger.info(
    `SiyahMelek seri oluşturuldu/güncellendi | ID: ${series.series_id} | UID: ${series.seriesuid} | Name: ${seriesName}`
  );

  await applyCategories({
    seriesId: series.seriesuid,
    genres: [],
    forceAdult: true,
  });

  let displayChapterNumber = 1;

  for (const chapter of chapters) {
    const uploadResult = await uploadChapterImages({
      seriesSlug: series.seriesuid,
      chapter: displayChapterNumber,
      imageUrls: chapter.imageUrls,
      source: "siyahmelek_api",
    });

    logger.info(
      `SiyahMelek bölüm yüklendi | Kaynak Chapter: ${chapter.chapter} | Otoku Chapter: ${displayChapterNumber} | Page Count: ${uploadResult.pageCount}`
    );

    const eps = String(displayChapterNumber);
    const epsuid = `${series.seriesuid}-${displayChapterNumber}`;

    await upsertChapter({
      eps,
      epsuid,
      seriesId: series.seriesuid,
      chapterurl: uploadResult.baseUrl,
    });

    logger.info(
      `SiyahMelek bölüm DB kaydı tamamlandı | Kaynak Chapter: ${chapter.chapter} | Otoku Chapter: ${displayChapterNumber}`
    );

    displayChapterNumber++;
  }

  await updateImportJobStatus({
    jobId: job.id,
    status: "completed",
    seriesId: series.seriesuid,
    seriesName,
  });

  logger.info(`SiyahMelek API job tamamlandı: #${job.id}`);

  return displayChapterNumber - 1;
}

async function runMangttoJob(job: ImportJob): Promise<number> {
  logger.info(`Kaynak URL: ${job.source_url}`);

  const baseSeriesSlug = extractSlugFromMangttoUrl(job.source_url);
  let seriesSlug = baseSeriesSlug;
  const fallbackTitle = titleFromSlug(baseSeriesSlug);

  seriesSlug = await getAvailableSeriesSlug(baseSeriesSlug);

  logger.info(
    `Series slug seçildi | Base: ${baseSeriesSlug} | Kullanılan: ${seriesSlug}`
  );

  logger.info(`AniList metadata aranıyor: ${fallbackTitle}`);
  const metadata = await searchAniListByTitle(fallbackTitle);

  logger.info("Bölümler taranıyor...");
  const scannedChapters = await scanMangttoChapters({
    sourceUrl: job.source_url,
    startChap: Number(job.start_chap),
    endChap: Number(job.end_chap),
    missLimit: 5,
  });

  const chapters = dedupeChapters(scannedChapters);

  logger.info(
    `Toplam bulunan bölüm: ${scannedChapters.length} | Duplicate sonrası: ${chapters.length}`
  );

  if (chapters.length === 0) {
    throw new Error(
      "Hiç bölüm bulunamadı. Seri DB'ye eklenmedi. Kaynak URL, bölüm aralığı veya scraper filtresi kontrol edilmeli."
    );
  }

  const seriesName = metadata?.titleRomaji || fallbackTitle;

  const searchName = buildSearchName({
    titleRomaji: metadata?.titleRomaji,
    titleEnglish: metadata?.titleEnglish,
    titleNative: metadata?.titleNative,
    synonyms: metadata?.synonyms || [],
    fallbackTitle,
  });

  const series = await upsertSeries({
    name: seriesName,
    seriesuid: seriesSlug,
    coverImageUrl: metadata?.coverImage || "",
    des: "Açıklama henüz eklenmemiş görünüyor...",
    kaynak: "",
    final: mapAniListStatus(metadata?.status || null),
    searchName,
  });

  logger.info(
    `Seri oluşturuldu/güncellendi | ID: ${series.series_id} | UID: ${series.seriesuid}`
  );

  await applyCategories({
    seriesId: series.seriesuid,
    genres: metadata?.genres || [],
  });

  let displayChapterNumber = 1;

  for (const chapter of chapters) {
    const uploadResult = await uploadChapterImages({
      seriesSlug: series.seriesuid,
      chapter: displayChapterNumber,
      imageUrls: chapter.imageUrls,
      source: "mangtto",
    });

    logger.info(
      `Bölüm yüklendi | Kaynak Chapter: ${chapter.chapter} | Otoku Chapter: ${displayChapterNumber} | Page Count: ${uploadResult.pageCount}`
    );

    logger.info(`Chapter Base URL: ${uploadResult.baseUrl}`);

    const eps = String(displayChapterNumber);
    const epsuid = `${series.seriesuid}-${displayChapterNumber}`;

    await upsertChapter({
      eps,
      epsuid,
      seriesId: series.seriesuid,
      chapterurl: uploadResult.baseUrl,
    });

    logger.info(
      `Bölüm DB kaydı tamamlandı | Kaynak Chapter: ${chapter.chapter} | Otoku Chapter: ${displayChapterNumber} | SeriesUID: ${series.seriesuid}`
    );

    displayChapterNumber++;
  }

  await updateImportJobStatus({
    jobId: job.id,
    status: "completed",
    seriesId: series.seriesuid,
    seriesName,
  });

  logger.info(`Mangtto job tamamlandı: #${job.id}`);

  return displayChapterNumber - 1;
}

export async function runImportWorker(): Promise<ImportRunResult> {
  const job = await getNextImportJob();

  if (!job) {
    logger.info("Bekleyen import job yok.");

    return {
      hasJob: false,
      completed: true,
      chapterCount: 0,
    };
  }

  const rawSource = normalizeSource(job);

  logger.info(`Job alındı: #${job.id}`);
  logger.info(`Raw source: ${rawSource}`);
  logger.info(`Job payload: ${JSON.stringify(job)}`);

  try {
    let chapterCount = 0;

    if (rawSource === "siyahmelek_api") {
      logger.info("SiyahMelek API branch seçildi.");
      chapterCount = await runSiyahMelekApiJob(job);
    } else {
      logger.info("Mangtto branch seçildi.");
      chapterCount = await runMangttoJob(job);
    }

    return {
      hasJob: true,
      completed: true,
      chapterCount,
      jobId: job.id,
    };
  } catch (err) {
    const anyErr = err as any;

    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : JSON.stringify(err);

    const failedUrl = anyErr?.config?.url ? String(anyErr.config.url) : "";
    const status = anyErr?.response?.status
      ? String(anyErr.response.status)
      : "";
    const responseData = anyErr?.response?.data
      ? typeof anyErr.response.data === "string"
        ? anyErr.response.data
        : JSON.stringify(anyErr.response.data)
      : "";

    const fullErrorMessage = [
      message,
      failedUrl ? `URL: ${failedUrl}` : "",
      status ? `STATUS: ${status}` : "",
      responseData ? `RESPONSE: ${responseData}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    logger.error(`Job failed: ${fullErrorMessage}`);

    await updateImportJobStatus({
      jobId: job.id,
      status: "failed",
      seriesId: job.series_id || null,
      seriesName: job.series_name || job.source_name || null,
      errorMessage: fullErrorMessage,
    });

    throw err;
  }
}