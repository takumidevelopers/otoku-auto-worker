import axios, { type AxiosResponse } from "axios";
import { logger } from "./logger";

export type NiveraCdnChapter = {
  chapter: number;
  sourceChapter: string;
  chapterSlug: string;
  imageUrls: string[];
};

export type NiveraCdnConfig = {
  cdnSeriesRoot: string;
  cdnSeriesId: string;
  seriesSlug: string;
  leadImageName: string;
};

const DEFAULT_CDN_HOST = "yedek.mangawow.com";
const DEFAULT_NIVERA_HOST = "niverafansub.one";
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "webp", "png"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/ÄŸ/g, "g")
    .replace(/Ã¼/g, "u")
    .replace(/ÅŸ/g, "s")
    .replace(/Ä±/g, "i")
    .replace(/Ã¶/g, "o")
    .replace(/Ã§/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeRoot(url: URL, cdnSeriesId: string): string {
  return `${url.protocol}//${url.host}/nivera/data/${cdnSeriesId}/`;
}

export function extractNiveraCdnConfig(params: {
  sourceUrl: string;
  sourceName?: string;
}): NiveraCdnConfig {
  const raw = String(params.sourceUrl || "").trim();

  if (!raw) {
    throw new Error(
      "Nivera CDN source_url boÅŸ. yedek.mangawow.com Ã¼zerindeki bir bÃ¶lÃ¼m gÃ¶rseli verilmelidir."
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Nivera CDN source_url geÃ§erli bir URL deÄŸil: ${raw}`);
  }

  if (parsed.hostname.toLowerCase() !== DEFAULT_CDN_HOST) {
    throw new Error(
      `Nivera CDN source_url hostu ${DEFAULT_CDN_HOST} olmalÄ±. Gelen: ${parsed.hostname}`
    );
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const niveraIndex = parts.findIndex((part) => part.toLowerCase() === "nivera");
  const dataIndex = parts.findIndex(
    (part, index) => index > niveraIndex && part.toLowerCase() === "data"
  );
  const cdnSeriesId = dataIndex >= 0 ? parts[dataIndex + 1] || "" : "";

  if (!/^manga_[a-z0-9]+$/i.test(cdnSeriesId)) {
    throw new Error(
      "Nivera CDN URL iÃ§inde manga_xxx seri klasÃ¶rÃ¼ bulunamadÄ±. Ã–rnek: /nivera/data/manga_62f38fb4701bd/..."
    );
  }

  const fileName = parts[parts.length - 1] || "";
  const leadMatch = fileName.match(/^0-(.+?)\.(?:jpe?g|png|webp)$/i);
  const nameFallback = slugify(String(params.sourceName || ""));
  const seriesSlug = slugify(leadMatch?.[1] || nameFallback);

  if (!seriesSlug) {
    throw new Error(
      "Seri slugÄ± Ã§Ä±karÄ±lamadÄ±. source_url iÃ§in mÃ¼mkÃ¼nse 0-seri-slug.jpg gÃ¶rselini kullan veya source_name alanÄ±nÄ± doldur."
    );
  }

  return {
    cdnSeriesRoot: normalizeRoot(parsed, cdnSeriesId),
    cdnSeriesId,
    seriesSlug,
    leadImageName: leadMatch ? fileName : `0-${seriesSlug}.jpg`,
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&#8211;/g, "-")
    .replace(/&#8212;/g, "-")
    .replace(/&#46;/g, ".")
    .replace(/&nbsp;/g, " ");
}

function chapterNumberFromSlug(slug: string): number | null {
  const clean = slug
    .toLowerCase()
    .replace(/-bolum\/?$/, "")
    .replace(/_/g, "-");

  const direct = clean.match(/^(\d+)(?:[-.,](\d+))?$/);

  if (direct) {
    return Number(direct[2] ? `${direct[1]}.${direct[2]}` : direct[1]);
  }

  const anyNumber = clean.match(/(\d+(?:[.,]\d+)?)/);
  return anyNumber ? Number(anyNumber[1].replace(",", ".")) : null;
}

function chapterSlugFromNumber(chapter: number): string {
  const normalized = Number.isInteger(chapter)
    ? String(chapter)
    : String(chapter).replace(".", "-");

  return `${normalized}-bolum`;
}

async function fetchChapterSlugs(seriesSlug: string): Promise<Array<{
  chapter: number;
  sourceChapter: string;
  chapterSlug: string;
}>> {
  const endpoint = `https://${DEFAULT_NIVERA_HOST}/manga/${seriesSlug}/ajax/chapters/`;

  const response = await axios.post<string>(endpoint, "", {
    timeout: 30000,
    maxRedirects: 2,
    responseType: "text",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36",
      Accept: "text/html, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `https://${DEFAULT_NIVERA_HOST}/manga/${seriesSlug}/`,
      Origin: `https://${DEFAULT_NIVERA_HOST}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Nivera chapter endpoint baÅŸarÄ±sÄ±z. HTTP ${response.status} | ${endpoint}`
    );
  }

  const html = String(response.data || "");
  const hrefRegex = /href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const unique = new Map<string, { chapter: number; sourceChapter: string; chapterSlug: string }>();
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html))) {
    const href = decodeHtml(match[1]);
    const pathMatch = href.match(
      new RegExp(`/manga/${seriesSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/?#]+)/?`, "i")
    );

    if (!pathMatch) {
      continue;
    }

    const chapterSlug = pathMatch[1];
    const label = decodeHtml(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const chapter = chapterNumberFromSlug(chapterSlug) ?? chapterNumberFromSlug(label);

    if (chapter === null || !Number.isFinite(chapter)) {
      continue;
    }

    unique.set(chapterSlug, {
      chapter,
      sourceChapter: label || String(chapter),
      chapterSlug,
    });
  }

  return Array.from(unique.values()).sort((a, b) => a.chapter - b.chapter);
}

function destroyStream(response: AxiosResponse): void {
  const stream = response.data as { destroy?: () => void } | undefined;
  stream?.destroy?.();
}

async function probeByGet(url: string): Promise<boolean> {
  try {
    const response = await axios.get(url, {
      responseType: "stream",
      timeout: 8000,
      maxRedirects: 3,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Range: "bytes=0-0",
        Referer: `https://${DEFAULT_NIVERA_HOST}/`,
      },
      validateStatus: () => true,
    });

    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    const ok =
      (response.status === 200 || response.status === 206) &&
      (contentType.startsWith("image/") || !contentType);

    destroyStream(response);
    return ok;
  } catch {
    return false;
  }
}

async function imageExists(url: string): Promise<boolean> {
  try {
    const response = await axios.head(url, {
      timeout: 5000,
      maxRedirects: 3,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: `https://${DEFAULT_NIVERA_HOST}/`,
      },
      validateStatus: () => true,
    });

    const contentType = String(response.headers["content-type"] || "").toLowerCase();

    if (
      (response.status === 200 || response.status === 206) &&
      (contentType.startsWith("image/") || !contentType)
    ) {
      return true;
    }

    if ([400, 403, 405, 501].includes(response.status)) {
      return probeByGet(url);
    }

    return false;
  } catch {
    return probeByGet(url);
  }
}

async function findImageVariant(baseWithoutExtension: string): Promise<string | null> {
  for (const extension of IMAGE_EXTENSIONS) {
    const url = `${baseWithoutExtension}.${extension}`;

    if (await imageExists(url)) {
      return url;
    }
  }

  return null;
}

// NIVERA_DUAL_ROOT_V4_3_START
// NIVERA_FAST_PROBE_V4_4_1
async function findFirstExistingUrlV441(
  urls: string[]
): Promise<string | null> {
  const results = await Promise.all(
    urls.map(async (url) =>
      (await imageExists(url)) ? url : null
    )
  );

  return results.find(
    (url): url is string => Boolean(url)
  ) || null;
}

async function findImageFromBasesV441(
  basesWithoutExtension: string[]
): Promise<string | null> {
  for (const extension of IMAGE_EXTENSIONS) {
    const urls = basesWithoutExtension.map(
      (base) => `${base}.${extension}`
    );

    const found =
      await findFirstExistingUrlV441(urls);

    if (found) {
      return found;
    }
  }

  return null;
}

async function findChapterPageVariantV430(params: {
  chapterRoot: string;
  group: number;
  page: number;
}): Promise<string | null> {
  const pageNumber =
    String(params.page).padStart(3, "0");

  const candidates = [
    `s${params.group}_${pageNumber}`,
    `s${params.group}-kopya_${pageNumber}`,
    `${params.group}_${pageNumber}`,
    `${params.group}-kopya_${pageNumber}`,
  ];

  return findImageFromBasesV441(
    candidates.map(
      (candidate) =>
        `${params.chapterRoot}${candidate}`
    )
  );
}
// NIVERA_THIRD_ROOT_V4_5_1
function buildNiveraSeriesRootsV430(
  primaryRoot: string
): string[] {
  const roots = [
    primaryRoot,
    primaryRoot.replace(
      "/nivera/data/",
      "/nivera/data2/"
    ),
    primaryRoot.replace(
      "/nivera/data/",
      "/nivera/data2/data/"
    ),
  ];

  return Array.from(
    new Set(
      roots
        .map((root) => root.trim())
        .filter(Boolean)
    )
  );
}

async function scanChapterImagesAtRootV430(params: {
  config: NiveraCdnConfig;
  chapterRoot: string;
  maxGroups: number;
  pageMax: number;
  groupMissLimit: number;
  pageMissLimit: number;
}): Promise<string[]> {
  const images: string[] = [];

  const preferredLeadUrl =
    `${params.chapterRoot}${params.config.leadImageName}`;

  if (await imageExists(preferredLeadUrl)) {
    images.push(preferredLeadUrl);
  } else {
    const lead = await findImageFromBasesV441([
      `${params.chapterRoot}0-${params.config.seriesSlug}`,
      `${params.chapterRoot}0-${params.config.seriesSlug}-kopya`,
    ]);

    if (lead) {
      images.push(lead);
    }
  }

  let consecutiveEmptyGroups = 0;
  let foundSection = false;

  for (
    let group = 1;
    group <= params.maxGroups;
    group++
  ) {
    const groupImages: string[] = [];
    let consecutiveMissingPages = 0;

    for (
      let page = 1;
      page <= params.pageMax;
      page++
    ) {
      const found =
        await findChapterPageVariantV430({
          chapterRoot: params.chapterRoot,
          group,
          page,
        });

      if (found) {
        groupImages.push(found);
        consecutiveMissingPages = 0;
      } else {
        consecutiveMissingPages++;

        if (
          consecutiveMissingPages >=
          params.pageMissLimit
        ) {
          break;
        }
      }
    }

    if (groupImages.length === 0) {
      consecutiveEmptyGroups++;

      if (
        (
          foundSection &&
          consecutiveEmptyGroups >=
            params.groupMissLimit
        ) ||
        (
          !foundSection &&
          group >= params.groupMissLimit
        )
      ) {
        break;
      }
    } else {
      foundSection = true;
      consecutiveEmptyGroups = 0;
      images.push(...groupImages);
    }
  }

  return Array.from(new Set(images));
}

async function scanChapterImages(params: {
  config: NiveraCdnConfig;
  chapterSlug: string;
  maxGroups: number;
  pageMax: number;
  groupMissLimit: number;
  pageMissLimit: number;
}): Promise<string[]> {
  const seriesRoots = buildNiveraSeriesRootsV430(
    params.config.cdnSeriesRoot
  );

  for (const seriesRoot of seriesRoots) {
    const chapterRoot =
      `${seriesRoot}${params.chapterSlug}/`;

    const images =
      await scanChapterImagesAtRootV430({
        config: params.config,
        chapterRoot,
        maxGroups: params.maxGroups,
        pageMax: params.pageMax,
        groupMissLimit: params.groupMissLimit,
        pageMissLimit: params.pageMissLimit,
      });

    if (images.length > 0) {
      logger.info(
        `Nivera CDN kökü seçildi | Folder: ${params.chapterSlug} | Root: ${seriesRoot} | Görsel: ${images.length}`
      );

      return images;
    }
  }

  return [];
}
// NIVERA_DUAL_ROOT_V4_3_END

function buildFallbackChapterIndex(startChap: number, endChap: number) {
  const chapters: Array<{ chapter: number; sourceChapter: string; chapterSlug: string }> = [];

  for (let chapter = Math.ceil(startChap); chapter <= Math.floor(endChap); chapter++) {
    chapters.push({
      chapter,
      sourceChapter: String(chapter),
      chapterSlug: chapterSlugFromNumber(chapter),
    });
  }

  return chapters;
}

export async function scanNiveraCdnChapters(params: {
  sourceUrl: string;
  sourceName?: string;
  startChap: number;
  endChap: number;
  maxGroups?: number;
  pageMax?: number;
  groupMissLimit?: number;
  pageMissLimit?: number;
  requestDelayMs?: number;
}): Promise<NiveraCdnChapter[]> {
  const config = extractNiveraCdnConfig({
    sourceUrl: params.sourceUrl,
    sourceName: params.sourceName,
  });

  const startChap = Number(params.startChap);
  const endChap = Number(params.endChap);

  if (!Number.isFinite(startChap) || !Number.isFinite(endChap) || startChap > endChap) {
    throw new Error(`Nivera bÃ¶lÃ¼m aralÄ±ÄŸÄ± geÃ§ersiz: ${params.startChap}-${params.endChap}`);
  }

  logger.info(
    `Nivera CDN tarama baÅŸladÄ± | Seri: ${config.seriesSlug} | CDN: ${config.cdnSeriesId} | Range: ${startChap}-${endChap}`
  );

  let chapterIndex: Array<{ chapter: number; sourceChapter: string; chapterSlug: string }> = [];

  try {
    chapterIndex = await fetchChapterSlugs(config.seriesSlug);
    logger.info(`Nivera chapter endpoint sonucu | Toplam: ${chapterIndex.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Nivera chapter endpoint kullanÄ±lamadÄ±; sayÄ±sal CDN taramasÄ±na geÃ§iliyor. ${message}`);
  }

  const selected = (chapterIndex.length > 0
    ? chapterIndex
    : buildFallbackChapterIndex(startChap, endChap)
  ).filter((item) => item.chapter >= startChap && item.chapter <= endChap);

  if (selected.length === 0) {
    throw new Error(
      `Nivera bÃ¶lÃ¼m listesinde ${startChap}-${endChap} aralÄ±ÄŸÄ±nda bÃ¶lÃ¼m bulunamadÄ±.`
    );
  }

  const results: NiveraCdnChapter[] = [];

  for (const item of selected) {
    logger.info(
      `Nivera CDN bÃ¶lÃ¼m taranÄ±yor | Chapter: ${item.chapter} | Folder: ${item.chapterSlug}`
    );

    const imageUrls = await scanChapterImages({
      config,
      chapterSlug: item.chapterSlug,
      maxGroups: Number(params.maxGroups || 40),
      pageMax: Number(params.pageMax || 300),
      groupMissLimit: Number(params.groupMissLimit || 3),
      pageMissLimit: Number(params.pageMissLimit || 3),
    });

    if (imageUrls.length === 0) {
      throw new Error(
        `Nivera CDN bölüm görselleri üç kökte de bulunamadı. Chapter: ${item.chapter} | Folder: ${item.chapterSlug} | Roots: /nivera/data/, /nivera/data2/ ve /nivera/data2/data/`
      );
    }

    logger.info(
      `Nivera CDN bÃ¶lÃ¼m bulundu | Chapter: ${item.chapter} | GÃ¶rsel: ${imageUrls.length}`
    );

    results.push({
      chapter: item.chapter,
      sourceChapter: item.sourceChapter,
      chapterSlug: item.chapterSlug,
      imageUrls,
    });

    await sleep(Number(params.requestDelayMs || 250));
  }

  return results;
}



