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
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "webp", "png", "avif", "jfif", "gif"] as const;

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

// NIVERA_FILENAME_FAST_V4_6_2
type NiveraFilenameTierV462 =
  | "fast"
  | "extended";

type NiveraPageFormatV462 =
  | "raw"
  | "p2"
  | "p3"
  | "p4";

type NiveraFilenamePatternV462 = {
  id: string;
  tier: NiveraFilenameTierV462;
  sequentialOnly: boolean;
  build: (
    group: number,
    page: number
  ) => string;
};

type NiveraFilenameCandidateV462 = {
  pattern: NiveraFilenamePatternV462;
  base: string;
};

type NiveraFilenameMatchV462 = {
  url: string;
  pattern: NiveraFilenamePatternV462;
  extension: string;
};

type NiveraFilenameHintV462 = {
  patternId: string;
  extension: string;
  hits: number;
};

const NIVERA_FILENAME_HINTS_V462 =
  new Map<string, NiveraFilenameHintV462>();

const NIVERA_HINT_RECOVERY_USED_V462 =
  new Set<string>();

const NIVERA_EXTENDED_DISCOVERY_USED_V462 =
  new Set<string>();

function niveraPageTokenV462(
  page: number,
  format: NiveraPageFormatV462
): string {
  const raw = String(page);

  if (format === "p2") {
    return raw.padStart(2, "0");
  }

  if (format === "p3") {
    return raw.padStart(3, "0");
  }

  if (format === "p4") {
    return raw.padStart(4, "0");
  }

  return raw;
}

function createNiveraFilenamePatternsV462():
  NiveraFilenamePatternV462[] {
  const patterns:
    NiveraFilenamePatternV462[] = [];

  const add = (
    id: string,
    tier: NiveraFilenameTierV462,
    sequentialOnly: boolean,
    build: (
      group: number,
      page: number
    ) => string
  ): void => {
    patterns.push({
      id,
      tier,
      sequentialOnly,
      build,
    });
  };

  /*
   * En sık karşılaşılan aileler en başta.
   * 62. bölümün 1-kopya.jpg biçimi ilk sıradadır.
   */
  add(
    "seq-raw-kopya",
    "fast",
    true,
    (_group, page) =>
      `${page}-kopya`
  );

  add(
    "legacy-s-group-p3",
    "fast",
    false,
    (group, page) =>
      `s${group}_${String(page).padStart(3, "0")}`
  );

  add(
    "legacy-s-group-kopya-p3",
    "fast",
    false,
    (group, page) =>
      `s${group}-kopya_${String(page).padStart(3, "0")}`
  );

  add(
    "legacy-group-p3",
    "fast",
    false,
    (group, page) =>
      `${group}_${String(page).padStart(3, "0")}`
  );

  add(
    "legacy-group-kopya-p3",
    "fast",
    false,
    (group, page) =>
      `${group}-kopya_${String(page).padStart(3, "0")}`
  );

  add(
    "seq-raw",
    "fast",
    true,
    (_group, page) =>
      String(page)
  );

  add(
    "seq-p3-kopya",
    "fast",
    true,
    (_group, page) =>
      `${String(page).padStart(3, "0")}-kopya`
  );

  add(
    "seq-p3",
    "fast",
    true,
    (_group, page) =>
      String(page).padStart(3, "0")
  );

  add(
    "seq-s-raw-kopya",
    "fast",
    true,
    (_group, page) =>
      `s${page}-kopya`
  );

  add(
    "seq-s-raw",
    "fast",
    true,
    (_group, page) =>
      `s${page}`
  );

  const formats:
    NiveraPageFormatV462[] = [
      "raw",
      "p2",
      "p3",
      "p4",
    ];

  for (const format of formats) {
    const token = (
      page: number
    ): string =>
      niveraPageTokenV462(
        page,
        format
      );

    /*
     * Grup + sayfa:
     * s1_001, s1-001, s1.001,
     * 1_001, 1-001, 1.001
     */
    add(
      `group-s-underscore-${format}`,
      "extended",
      false,
      (group, page) =>
        `s${group}_${token(page)}`
    );

    add(
      `group-s-dash-${format}`,
      "extended",
      false,
      (group, page) =>
        `s${group}-${token(page)}`
    );

    add(
      `group-s-dot-${format}`,
      "extended",
      false,
      (group, page) =>
        `s${group}.${token(page)}`
    );

    add(
      `group-underscore-${format}`,
      "extended",
      false,
      (group, page) =>
        `${group}_${token(page)}`
    );

    add(
      `group-dash-${format}`,
      "extended",
      false,
      (group, page) =>
        `${group}-${token(page)}`
    );

    add(
      `group-dot-${format}`,
      "extended",
      false,
      (group, page) =>
        `${group}.${token(page)}`
    );

    /*
     * Grup + kopya/copy + sayfa.
     */
    for (
      const word of
      ["kopya", "copy"] as const
    ) {
      add(
        `group-s-${word}-dash-underscore-${format}`,
        "extended",
        false,
        (group, page) =>
          `s${group}-${word}_${token(page)}`
      );

      add(
        `group-s-${word}-dash-dash-${format}`,
        "extended",
        false,
        (group, page) =>
          `s${group}-${word}-${token(page)}`
      );

      add(
        `group-s-${word}-underscore-${format}`,
        "extended",
        false,
        (group, page) =>
          `s${group}_${word}_${token(page)}`
      );

      add(
        `group-s-page-${word}-underscore-${format}`,
        "extended",
        false,
        (group, page) =>
          `s${group}_${token(page)}-${word}`
      );

      add(
        `group-s-page-${word}-dash-${format}`,
        "extended",
        false,
        (group, page) =>
          `s${group}-${token(page)}-${word}`
      );

      add(
        `group-${word}-dash-underscore-${format}`,
        "extended",
        false,
        (group, page) =>
          `${group}-${word}_${token(page)}`
      );

      add(
        `group-${word}-dash-dash-${format}`,
        "extended",
        false,
        (group, page) =>
          `${group}-${word}-${token(page)}`
      );

      add(
        `group-${word}-underscore-${format}`,
        "extended",
        false,
        (group, page) =>
          `${group}_${word}_${token(page)}`
      );

      add(
        `group-page-${word}-underscore-${format}`,
        "extended",
        false,
        (group, page) =>
          `${group}_${token(page)}-${word}`
      );

      add(
        `group-page-${word}-dash-${format}`,
        "extended",
        false,
        (group, page) =>
          `${group}-${token(page)}-${word}`
      );

      /*
       * Grup içermeyen sıralı biçimler.
       */
      add(
        `seq-${word}-dash-${format}`,
        "extended",
        true,
        (_group, page) =>
          `${token(page)}-${word}`
      );

      add(
        `seq-${word}-underscore-${format}`,
        "extended",
        true,
        (_group, page) =>
          `${token(page)}_${word}`
      );

      add(
        `seq-s-${word}-dash-${format}`,
        "extended",
        true,
        (_group, page) =>
          `s${token(page)}-${word}`
      );

      add(
        `seq-s-${word}-underscore-${format}`,
        "extended",
        true,
        (_group, page) =>
          `s${token(page)}_${word}`
      );
    }

    /*
     * page/sayfa/img/image önekleri.
     */
    for (
      const prefix of
      ["page", "sayfa", "img", "image"] as const
    ) {
      add(
        `seq-${prefix}-dash-${format}`,
        "extended",
        true,
        (_group, page) =>
          `${prefix}-${token(page)}`
      );

      add(
        `seq-${prefix}-underscore-${format}`,
        "extended",
        true,
        (_group, page) =>
          `${prefix}_${token(page)}`
      );

      add(
        `seq-${prefix}-plain-${format}`,
        "extended",
        true,
        (_group, page) =>
          `${prefix}${token(page)}`
      );
    }

    /*
     * p/page/sayfa işaretli grup biçimleri.
     */
    add(
      `group-s-p-${format}`,
      "extended",
      false,
      (group, page) =>
        `s${group}p${token(page)}`
    );

    add(
      `group-p-${format}`,
      "extended",
      false,
      (group, page) =>
        `${group}p${token(page)}`
    );

    add(
      `group-s-page-${format}`,
      "extended",
      false,
      (group, page) =>
        `s${group}-page-${token(page)}`
    );

    add(
      `group-page-${format}`,
      "extended",
      false,
      (group, page) =>
        `${group}-page-${token(page)}`
    );

    add(
      `group-s-sayfa-${format}`,
      "extended",
      false,
      (group, page) =>
        `s${group}-sayfa-${token(page)}`
    );

    add(
      `group-sayfa-${format}`,
      "extended",
      false,
      (group, page) =>
        `${group}-sayfa-${token(page)}`
    );

    /*
     * Bitişik grup-sayfa biçimleri.
     */
    add(
      `group-s-joined-${format}`,
      "extended",
      false,
      (group, page) =>
        `s${group}${token(page)}`
    );

    add(
      `group-joined-${format}`,
      "extended",
      false,
      (group, page) =>
        `${group}${token(page)}`
    );
  }

  /*
   * WordPress kopya numarası ekleri:
   * 1-kopya-1, 1-copy-2, s1-kopya-3 vb.
   */
  for (
    let copyIndex = 1;
    copyIndex <= 5;
    copyIndex++
  ) {
    add(
      `seq-raw-kopya-${copyIndex}`,
      "extended",
      true,
      (_group, page) =>
        `${page}-kopya-${copyIndex}`
    );

    add(
      `seq-raw-copy-${copyIndex}`,
      "extended",
      true,
      (_group, page) =>
        `${page}-copy-${copyIndex}`
    );

    add(
      `seq-s-raw-kopya-${copyIndex}`,
      "extended",
      true,
      (_group, page) =>
        `s${page}-kopya-${copyIndex}`
    );

    add(
      `seq-s-raw-copy-${copyIndex}`,
      "extended",
      true,
      (_group, page) =>
        `s${page}-copy-${copyIndex}`
    );

    add(
      `seq-raw-duplicate-${copyIndex}`,
      "extended",
      true,
      (_group, page) =>
        `${page}-${copyIndex}`
    );
  }

  return patterns;
}

const NIVERA_FILENAME_PATTERNS_V462 =
  createNiveraFilenamePatternsV462();

function buildNiveraFilenameCandidatesV462(params: {
  group: number;
  page: number;
  tier?: NiveraFilenameTierV462;
}): NiveraFilenameCandidateV462[] {
  const candidates:
    NiveraFilenameCandidateV462[] = [];

  const seen =
    new Set<string>();

  for (
    const pattern of
    NIVERA_FILENAME_PATTERNS_V462
  ) {
    if (
      params.tier &&
      pattern.tier !== params.tier
    ) {
      continue;
    }

    if (
      pattern.sequentialOnly &&
      params.group !== 1
    ) {
      continue;
    }

    const base =
      pattern.build(
        params.group,
        params.page
      );

    if (
      !base ||
      seen.has(base)
    ) {
      continue;
    }

    seen.add(base);

    candidates.push({
      pattern,
      base,
    });
  }

  return candidates;
}

function findNiveraPatternV462(
  patternId: string
): NiveraFilenamePatternV462 | null {
  return (
    NIVERA_FILENAME_PATTERNS_V462.find(
      (pattern) =>
        pattern.id === patternId
    ) ||
    null
  );
}

async function probeNiveraImageQuickV462(
  url: string,
  mode:
    | "standard"
    | "extended"
): Promise<boolean> {
  const headTimeout =
    mode === "extended"
      ? 1200
      : 2500;

  const getTimeout =
    mode === "extended"
      ? 1800
      : 3500;

  try {
    const response =
      await axios.head(url, {
        timeout: headTimeout,
        maxRedirects: 2,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36",
          Accept:
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          Referer:
            `https://${DEFAULT_NIVERA_HOST}/`,
        },
        validateStatus: () => true,
      });

    const contentType =
      String(
        response.headers[
          "content-type"
        ] || ""
      ).toLowerCase();

    if (
      (
        response.status === 200 ||
        response.status === 206
      ) &&
      (
        contentType.startsWith(
          "image/"
        ) ||
        !contentType
      )
    ) {
      return true;
    }

    if (
      ![400, 403, 405, 501].includes(
        response.status
      )
    ) {
      return false;
    }
  } catch {
    /*
     * HEAD bağlantısı koptuysa aşağıdaki küçük Range GET denenir.
     */
  }

  try {
    const response =
      await axios.get(url, {
        responseType: "stream",
        timeout: getTimeout,
        maxRedirects: 2,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36",
          Accept:
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          Range: "bytes=0-0",
          Referer:
            `https://${DEFAULT_NIVERA_HOST}/`,
        },
        validateStatus: () => true,
      });

    const contentType =
      String(
        response.headers[
          "content-type"
        ] || ""
      ).toLowerCase();

    const ok =
      (
        response.status === 200 ||
        response.status === 206
      ) &&
      (
        contentType.startsWith(
          "image/"
        ) ||
        !contentType
      );

    destroyStream(response);

    return ok;
  } catch {
    return false;
  }
}

async function probeNiveraCandidateSetV462(params: {
  chapterRoot: string;
  candidates:
    NiveraFilenameCandidateV462[];
  extensions: readonly string[];
  mode:
    | "standard"
    | "extended";
  batchSize: number;
}): Promise<NiveraFilenameMatchV462 | null> {
  for (
    const extension of
    params.extensions
  ) {
    for (
      let start = 0;
      start < params.candidates.length;
      start += params.batchSize
    ) {
      const batch =
        params.candidates.slice(
          start,
          start + params.batchSize
        );

      const results =
        await Promise.all(
          batch.map(
            async (
              candidate
            ) => {
              const url =
                `${params.chapterRoot}` +
                `${candidate.base}.` +
                `${extension}`;

              const exists =
                await probeNiveraImageQuickV462(
                  url,
                  params.mode
                );

              return exists
                ? {
                    url,
                    pattern:
                      candidate.pattern,
                    extension,
                  }
                : null;
            }
          )
        );

      const found =
        results.find(
          (
            result
          ): result is
            NiveraFilenameMatchV462 =>
            Boolean(result)
        );

      if (found) {
        return found;
      }
    }
  }

  return null;
}

function rememberNiveraFilenameMatchV462(
  chapterRoot: string,
  match: NiveraFilenameMatchV462
): void {
  const previous =
    NIVERA_FILENAME_HINTS_V462.get(
      chapterRoot
    );

  const hits =
    previous &&
    previous.patternId ===
      match.pattern.id &&
    previous.extension ===
      match.extension
      ? previous.hits + 1
      : 1;

  NIVERA_FILENAME_HINTS_V462.set(
    chapterRoot,
    {
      patternId:
        match.pattern.id,
      extension:
        match.extension,
      hits,
    }
  );

  if (
    !previous ||
    previous.patternId !==
      match.pattern.id ||
    previous.extension !==
      match.extension
  ) {
    logger.info(
      [
        "Nivera dosya kalıbı seçildi",
        `Pattern: ${match.pattern.id}`,
        `Extension: ${match.extension}`,
        `Root: ${chapterRoot}`,
      ].join(" | ")
    );
  }
}

async function findChapterPageVariantV430(params: {
  chapterRoot: string;
  group: number;
  page: number;
}): Promise<string | null> {
  const hint =
    NIVERA_FILENAME_HINTS_V462.get(
      params.chapterRoot
    );

  if (hint) {
    const pattern =
      findNiveraPatternV462(
        hint.patternId
      );

    /*
     * Grup içermeyen sıralı aile seçildiyse group=2 ve sonrası
     * aynı görselleri tekrar aramaz.
     */
    if (
      pattern?.sequentialOnly &&
      params.group !== 1
    ) {
      return null;
    }

    if (pattern) {
      const base =
        pattern.build(
          params.group,
          params.page
        );

      const url =
        `${params.chapterRoot}` +
        `${base}.` +
        `${hint.extension}`;

      if (
        await probeNiveraImageQuickV462(
          url,
          "standard"
        )
      ) {
        rememberNiveraFilenameMatchV462(
          params.chapterRoot,
          {
            url,
            pattern,
            extension:
              hint.extension,
          }
        );

        return url;
      }
    }

    /*
     * Aynı kalıp en az iki sayfada doğrulandıktan sonra bir sayfa
     * kaybolursa devasa matrisi yeniden taramayız. Yalnız bir kez
     * yaygın biçimlerle kurtarma aranır.
     */
    if (hint.hits >= 2) {
      if (
        NIVERA_HINT_RECOVERY_USED_V462.has(
          params.chapterRoot
        )
      ) {
        return null;
      }

      NIVERA_HINT_RECOVERY_USED_V462.add(
        params.chapterRoot
      );

      const recovery =
        await probeNiveraCandidateSetV462({
          chapterRoot:
            params.chapterRoot,
          candidates:
            buildNiveraFilenameCandidatesV462({
              group:
                params.group,
              page:
                params.page,
              tier:
                "fast",
            }),
          extensions: [
            "jpg",
            "jpeg",
            "webp",
            "png",
          ],
          mode:
            "standard",
          batchSize:
            10,
        });

      if (recovery) {
        rememberNiveraFilenameMatchV462(
          params.chapterRoot,
          recovery
        );

        return recovery.url;
      }

      return null;
    }
  }

  const fastCandidates =
    buildNiveraFilenameCandidatesV462({
      group: params.group,
      page: params.page,
      tier: "fast",
    });

  /*
   * Bilinen 1-kopya.jpg biçimini tek istekle önce kontrol et.
   * Böylece geniş matrise girmeden 62. bölüm hızla çözülür.
   */
  const firstFast =
    fastCandidates[0];

  if (firstFast) {
    const directUrl =
      `${params.chapterRoot}` +
      `${firstFast.base}.jpg`;

    if (
      await probeNiveraImageQuickV462(
        directUrl,
        "standard"
      )
    ) {
      const match = {
        url: directUrl,
        pattern:
          firstFast.pattern,
        extension:
          "jpg",
      };

      rememberNiveraFilenameMatchV462(
        params.chapterRoot,
        match
      );

      return directUrl;
    }
  }

  const fastMatch =
    await probeNiveraCandidateSetV462({
      chapterRoot:
        params.chapterRoot,
      candidates:
        fastCandidates,
      extensions: [
        "jpg",
        "jpeg",
        "webp",
        "png",
      ],
      mode:
        "standard",
      batchSize:
        10,
    });

  if (fastMatch) {
    rememberNiveraFilenameMatchV462(
      params.chapterRoot,
      fastMatch
    );

    return fastMatch.url;
  }

  /*
   * Geniş güvenlik matrisi yalnız ilk sayfada ve chapter root başına
   * bir kez çalışır. Sonraki boş sayfalarda yüzlerce URL denenmez.
   */
  if (
    params.page !== 1 ||
    NIVERA_EXTENDED_DISCOVERY_USED_V462.has(
      params.chapterRoot
    )
  ) {
    return null;
  }

  NIVERA_EXTENDED_DISCOVERY_USED_V462.add(
    params.chapterRoot
  );

  const extendedMatch =
    await probeNiveraCandidateSetV462({
      chapterRoot:
        params.chapterRoot,
      candidates:
        buildNiveraFilenameCandidatesV462({
          group:
            params.group,
          page:
            params.page,
          tier:
            "extended",
        }),
      extensions: [
        "jpg",
        "jpeg",
        "webp",
        "png",
        "avif",
        "jfif",
        "gif",
      ],
      mode:
        "extended",
      batchSize:
        16,
    });

  if (extendedMatch) {
    rememberNiveraFilenameMatchV462(
      params.chapterRoot,
      extendedMatch
    );

    return extendedMatch.url;
  }

  return null;
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

// NIVERA_STREAMING_V6_0_1
export type NiveraCdnChapterRefV600 = {
  chapter: number;
  sourceChapter: string;
  chapterSlug: string;
};

export type PreparedNiveraCdnScanV600 = {
  config: NiveraCdnConfig;
  chapters: NiveraCdnChapterRefV600[];
};

export async function prepareNiveraCdnScanV600(params: {
  sourceUrl: string;
  sourceName?: string;
  startChap: number;
  endChap: number;
}): Promise<PreparedNiveraCdnScanV600> {
  const config = extractNiveraCdnConfig({
    sourceUrl: params.sourceUrl,
    sourceName: params.sourceName,
  });

  const startChap = Number(params.startChap);
  const endChap = Number(params.endChap);

  if (
    !Number.isFinite(startChap) ||
    !Number.isFinite(endChap) ||
    startChap > endChap
  ) {
    throw new Error(
      `Nivera bölüm aralığı geçersiz: ${params.startChap}-${params.endChap}`
    );
  }

  logger.info(
    `Nivera streaming hazırlığı başladı | Seri: ${config.seriesSlug} | Range: ${startChap}-${endChap}`
  );

  let chapterIndex: NiveraCdnChapterRefV600[] = [];

  try {
    chapterIndex = await fetchChapterSlugs(config.seriesSlug);

    logger.info(
      `Nivera chapter endpoint sonucu | Toplam: ${chapterIndex.length}`
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    logger.warn(
      `Nivera chapter endpoint kullanılamadı; sayısal CDN indeksine geçiliyor. ${message}`
    );
  }

  const chapters =
    (
      chapterIndex.length > 0
        ? chapterIndex
        : buildFallbackChapterIndex(startChap, endChap)
    )
      .filter(
        (item) =>
          item.chapter >= startChap &&
          item.chapter <= endChap
      )
      .sort((a, b) => a.chapter - b.chapter);

  if (chapters.length === 0) {
    throw new Error(
      `Nivera bölüm listesinde ${startChap}-${endChap} aralığında bölüm bulunamadı.`
    );
  }

  logger.info(
    `Nivera streaming bölüm listesi hazır | Seçilen: ${chapters.length}`
  );

  return {
    config,
    chapters,
  };
}

export async function scanPreparedNiveraChapterV600(params: {
  prepared: PreparedNiveraCdnScanV600;
  chapter: NiveraCdnChapterRefV600;
  maxGroups?: number;
  pageMax?: number;
  groupMissLimit?: number;
  pageMissLimit?: number;
}): Promise<NiveraCdnChapter> {
  const startedAt = Date.now();

  logger.info(
    `Nivera tek bölüm keşfi başladı | Chapter: ${params.chapter.chapter} | Folder: ${params.chapter.chapterSlug}`
  );

  const imageUrls = await scanChapterImages({
    config: params.prepared.config,
    chapterSlug: params.chapter.chapterSlug,
    maxGroups: Number(params.maxGroups || 40),
    pageMax: Number(params.pageMax || 300),
    groupMissLimit: Number(params.groupMissLimit || 3),
    pageMissLimit: Number(params.pageMissLimit || 3),
  });

  if (imageUrls.length === 0) {
    throw new Error(
      `Nivera CDN bölüm görselleri üç kökte de bulunamadı. Chapter: ${params.chapter.chapter} | Folder: ${params.chapter.chapterSlug}`
    );
  }

  logger.info(
    `Nivera tek bölüm keşfi tamamlandı | Chapter: ${params.chapter.chapter} | Görsel: ${imageUrls.length} | Süre: ${Math.round((Date.now() - startedAt) / 1000)}s`
  );

  return {
    chapter: params.chapter.chapter,
    sourceChapter: params.chapter.sourceChapter,
    chapterSlug: params.chapter.chapterSlug,
    imageUrls,
  };
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



