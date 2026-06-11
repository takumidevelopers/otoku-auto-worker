import { logger } from "./logger";
import {
  getNextImportJob,
  updateImportJobStatus,
  upsertSeries,
  upsertChapter,
  upsertSeriesCategory,
} from "./otokuApi";
import { scanMangttoChapters } from "./mangtto";
import { uploadChapterImages } from "./imagePipeline";
import { searchAniListByTitle } from "./anilist";

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
};

async function applyCategories(params: {
  seriesId: string;
  genres: string[];
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
}

export async function runImportWorker() {
  const job = await getNextImportJob();

  if (!job) {
    logger.info("Bekleyen import job yok.");
    return;
  }

  logger.info(`Job alındı: #${job.id}`);
  logger.info(`Kaynak URL: ${job.source_url}`);

  const seriesSlug = extractSlugFromMangttoUrl(job.source_url);
  const fallbackTitle = titleFromSlug(seriesSlug);

  try {
    logger.info(`AniList metadata aranıyor: ${fallbackTitle}`);
    const metadata = await searchAniListByTitle(fallbackTitle);

    logger.info("Bölümler taranıyor...");
    const chapters = await scanMangttoChapters({
      sourceUrl: job.source_url,
      startChap: Number(job.start_chap),
      endChap: Number(job.end_chap),
      missLimit: 5,
    });

    logger.info(`Toplam bulunan bölüm: ${chapters.length}`);

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

    for (const chapter of chapters) {
      const uploadResult = await uploadChapterImages({
        seriesSlug,
        chapter: chapter.chapter,
        imageUrls: chapter.imageUrls,
      });

      logger.info(
        `Bölüm yüklendi | Chapter: ${chapter.chapter} | Page Count: ${uploadResult.pageCount}`
      );

      logger.info(`Chapter Base URL: ${uploadResult.baseUrl}`);

      const eps = String(chapter.chapter);
      const epsuid = `${seriesSlug}-${chapter.chapter}`;

      await upsertChapter({
        eps,
        epsuid,
        seriesId: series.seriesuid,
        chapterurl: uploadResult.baseUrl,
      });

      logger.info(
        `Bölüm DB kaydı tamamlandı | Chapter: ${chapter.chapter} | SeriesUID: ${series.seriesuid}`
      );
    }

    await updateImportJobStatus({
      jobId: job.id,
      status: "completed",
      seriesId: series.seriesuid,
      seriesName,
    });

    logger.info(`Job tamamlandı: #${job.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    logger.error(`Job failed: ${message}`);

    await updateImportJobStatus({
      jobId: job.id,
      status: "failed",
      seriesId: seriesSlug,
      seriesName: fallbackTitle,
      errorMessage: message,
    });

    throw err;
  }
}