import axios, { AxiosResponse } from "axios";
import { logger } from "./logger";
import { fetchNiveraText } from "./niveraTransport";

const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_DELAY_MS = 250;

const NIVERA_HOSTS = new Set([
  "niverafansub.one",
  "www.niverafansub.one",
  "niverafansub.net",
  "www.niverafansub.net",
]);

const BASE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
};

const AJAX_HEADERS: Record<string, string> = {
  ...BASE_HEADERS,
  Accept: "*/*",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
};

export type NiveraChapterResult = {
  chapter: number;
  chapterLabel: string;
  chapterUrl: string;
  imageUrls: string[];
};

export type NiveraScanResult = {
  seriesSlug: string;
  seriesTitle: string;
  coverImageUrl: string;
  description: string;
  chapters: NiveraChapterResult[];
};

type ChapterCandidate = {
  chapter: number;
  chapterLabel: string;
  chapterUrl: string;
  chapterSlug: string;
};

type TextResponse = {
  status: number;
  body: string;
  finalUrl: string;
  location: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_m, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getAttribute(tag: string, name: string): string | null {
  const re = new RegExp(
    `\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i"
  );
  const match = tag.match(re);
  return match
    ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "").trim()
    : null;
}

function normalizeUrl(raw: string, baseUrl: string): string | null {
  const clean = decodeHtmlEntities(raw).trim();
  if (!clean || clean.startsWith("data:") || clean.startsWith("blob:")) {
    return null;
  }

  try {
    return new URL(clean, baseUrl).href;
  } catch {
    return null;
  }
}

function isNiveraUrl(value: string): boolean {
  try {
    return NIVERA_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function extractNiveraSeriesSlug(sourceUrl: string): string {
  try {
    const parts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    const mangaIndex = parts.findIndex(
      (part) => part.toLowerCase() === "manga"
    );

    if (mangaIndex >= 0 && parts[mangaIndex + 1]) {
      return decodeURIComponent(parts[mangaIndex + 1]).trim();
    }
  } catch {
    // Fallback aşağıda.
  }

  return "unknown-nivera-series";
}

function buildSeriesUrl(sourceUrl: string, seriesSlug: string): string {
  const origin = new URL(sourceUrl).origin;
  return `${origin}/manga/${encodeURIComponent(seriesSlug)}/`;
}

function extractChapterSlug(chapterUrl: string): string {
  try {
    const parts = new URL(chapterUrl).pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || "");
  } catch {
    return "";
  }
}

function parseChapterNumber(label: string, chapterUrl: string): number | null {
  const cleanLabel = stripTags(label).replace(/,/g, ".");
  const labelMatch = cleanLabel.match(
    /(\d+(?:\.\d+)?)\s*\.?\s*(?:bölüm|bolum)/i
  );

  if (labelMatch?.[1]) {
    const parsed = Number(labelMatch[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  const slug = extractChapterSlug(chapterUrl);
  const slugMatch = slug.match(/^(\d+)(?:[-_.](\d+))?-bolum(?:-|$)/i);

  if (slugMatch?.[1]) {
    const parsed = Number(
      slugMatch[2] ? `${slugMatch[1]}.${slugMatch[2]}` : slugMatch[1]
    );
    if (Number.isFinite(parsed)) return parsed;
  }

  const loose = slug.match(/(\d+(?:[-_.]\d+)?)/);
  if (loose?.[1]) {
    const parsed = Number(loose[1].replace(/[-_]/g, "."));
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

async function responseBody(response: AxiosResponse<unknown>): Promise<string> {
  if (typeof response.data === "string") return response.data;
  if (response.data === null || response.data === undefined) return "";

  try {
    return JSON.stringify(response.data);
  } catch {
    return String(response.data);
  }
}

async function postChapterList(
  url: string,
  referer: string
): Promise<TextResponse> {
  const response = await axios.post<unknown>(url, "", {
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { ...AJAX_HEADERS, Referer: referer },
  });

  const finalUrl =
    String(
      (response.request as { res?: { responseUrl?: string } } | undefined)?.res
        ?.responseUrl || ""
    ) || url;

  return {
    status: response.status,
    body: await responseBody(response),
    finalUrl,
    location: String(response.headers.location || ""),
  };
}

function parseChapterCandidates(params: {
  html: string;
  baseUrl: string;
  startChap: number;
  endChap: number;
}): ChapterCandidate[] {
  const output: ChapterCandidate[] = [];
  const seen = new Set<string>();

  const liMatches = [
    ...params.html.matchAll(
      /<li\b[^>]*\bwp-manga-chapter\b[^>]*>([\s\S]*?)<\/li>/gi
    ),
  ];

  for (const match of liMatches) {
    const block = match[1] || "";
    const anchor = block.match(/<a\b[^>]*>[\s\S]*?<\/a>/i)?.[0];
    if (!anchor) continue;

    const rawUrl =
      getAttribute(anchor, "href") || getAttribute(anchor, "data-redirect");
    if (!rawUrl) continue;

    const chapterUrl = normalizeUrl(rawUrl, params.baseUrl);
    if (!chapterUrl || !isNiveraUrl(chapterUrl)) continue;

    const chapterLabel = stripTags(anchor);
    const chapter = parseChapterNumber(chapterLabel, chapterUrl);
    if (
      chapter === null ||
      chapter < params.startChap ||
      chapter > params.endChap
    ) {
      continue;
    }

    const key = `${chapter}|${chapterUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);

    output.push({
      chapter,
      chapterLabel: chapterLabel || `${chapter}. Bölüm`,
      chapterUrl,
      chapterSlug: extractChapterSlug(chapterUrl),
    });
  }

  const options =
    params.html.match(/<option\b[^>]*>[\s\S]*?<\/option>/gi) || [];

  for (const option of options) {
    const rawUrl =
      getAttribute(option, "data-redirect") || getAttribute(option, "value");
    if (!rawUrl || !/bolum/i.test(rawUrl)) continue;

    const chapterUrl = normalizeUrl(rawUrl, params.baseUrl);
    if (!chapterUrl || !isNiveraUrl(chapterUrl)) continue;

    const chapterLabel = stripTags(option);
    const chapter = parseChapterNumber(chapterLabel, chapterUrl);
    if (
      chapter === null ||
      chapter < params.startChap ||
      chapter > params.endChap
    ) {
      continue;
    }

    const key = `${chapter}|${chapterUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);

    output.push({
      chapter,
      chapterLabel: chapterLabel || `${chapter}. Bölüm`,
      chapterUrl,
      chapterSlug: extractChapterSlug(chapterUrl),
    });
  }

  return output.sort((a, b) => a.chapter - b.chapter);
}

function isHttpUrl(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /^https?:$/.test(parsed.protocol) &&
      /\.(?:jpe?g|png|webp|avif|gif)(?:$|\?)/i.test(parsed.href)
    );
  } catch {
    return false;
  }
}

function addImageUrl(
  output: string[],
  seen: Set<string>,
  raw: string,
  baseUrl: string,
  trustedChapterImage = false
): boolean {
  const normalized = normalizeUrl(raw, baseUrl);
  if (!normalized) return false;

  // Madara/Nivera bazen gerçek panel URL'sini uzantısız bir CDN/proxy adresiyle
  // verir. Etiket zaten wp-manga-chapter-img veya image-N ise uzantı şartı
  // aramayız; imagePipeline gerçek içeriği daha sonra doğrular.
  if (trustedChapterImage ? !isHttpUrl(normalized) : !isImageUrl(normalized)) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (
    lower.includes("placeholder") ||
    lower.includes("loading.gif") ||
    lower.includes("lazy-loader") ||
    lower.includes("no-image")
  ) {
    return false;
  }

  if (seen.has(normalized)) return false;
  seen.add(normalized);
  output.push(normalized);
  return true;
}

export function parseNiveraChapterImages(
  html: string,
  chapterUrl: string
): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  const readingMatch = html.match(
    /<div[^>]*\breading-content\b[^>]*>([\s\S]*?)(?:<div[^>]*\bentry-header\b|<\/div>\s*<\/div>\s*<\/div>)/i
  );
  const scope = readingMatch?.[1] || html;
  const tags = scope.match(/<img\b[^>]*>/gi) || [];
  const preferred = tags.filter((tag) => {
    const className = getAttribute(tag, "class") || "";
    const id = getAttribute(tag, "id") || "";
    return (
      className.split(/\s+/).includes("wp-manga-chapter-img") ||
      /^image-\d+$/i.test(id)
    );
  });

  for (const tag of preferred.length > 0 ? preferred : tags) {
    const className = getAttribute(tag, "class") || "";
    const id = getAttribute(tag, "id") || "";
    const trustedChapterImage =
      className.split(/\s+/).includes("wp-manga-chapter-img") ||
      /^image-\d+$/i.test(id);

    // Nivera'nın canlı HTML'sinde src gerçek paneli taşırken data-src alanı
    // boş/placeholder olabiliyor. Tek bir alanı seçip bırakmak yerine bütün
    // olası alanları sırayla deniyoruz.
    const attributes = [
      "src",
      "data-src",
      "data-lazy-src",
      "data-original",
      "data-cfsrc",
    ];

    let added = false;
    for (const attribute of attributes) {
      const raw = getAttribute(tag, attribute);
      if (!raw) continue;
      if (
        addImageUrl(
          output,
          seen,
          raw,
          chapterUrl,
          trustedChapterImage
        )
      ) {
        added = true;
        break;
      }
    }

    if (!added) {
      const srcset =
        getAttribute(tag, "srcset") ||
        getAttribute(tag, "data-srcset") ||
        getAttribute(tag, "data-lazy-srcset");

      if (srcset) {
        for (const candidate of srcset.split(",")) {
          const raw = candidate.trim().split(/\s+/)[0];
          if (!raw) continue;
          if (
            addImageUrl(
              output,
              seen,
              raw,
              chapterUrl,
              trustedChapterImage
            )
          ) {
            break;
          }
        }
      }
    }
  }

  const preload = html.match(
    /chapter_preloaded_images\s*=\s*(\[[\s\S]*?\])/i
  )?.[1];

  if (preload) {
    try {
      const values = JSON.parse(preload) as unknown[];
      for (const value of values) {
        if (typeof value === "string") {
          addImageUrl(output, seen, value, chapterUrl);
        }
      }
    } catch {
      // Statik image etiketleri birincil kaynaktır.
    }
  }

  return output;
}

function extractTitle(html: string, fallback: string): string {
  const heading = html.match(
    /<h1[^>]*id=["']chapter-heading["'][^>]*>([\s\S]*?)<\/h1>/i
  )?.[1];
  const headingText = heading ? stripTags(heading) : "";
  const clean = headingText
    .replace(
      /\s*[-–|]\s*\d+(?:[.,]\d+)?\.?\s*(?:Bölüm|Bolum).*$/i,
      ""
    )
    .trim();

  if (clean) return clean;

  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
  const titleText = title ? stripTags(title) : "";
  const first = titleText.split(/\s+[-|]\s+/)[0]?.trim();
  return first || fallback;
}

function extractMetaContent(
  html: string,
  key: string,
  attribute = "property"
): string {
  const escaped = escapeRegExp(key);
  const first = html.match(
    new RegExp(
      `<meta\\s+[^>]*${attribute}=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`,
      "i"
    )
  );
  if (first?.[1]) return decodeHtmlEntities(first[1]).trim();

  const reverse = html.match(
    new RegExp(
      `<meta\\s+[^>]*content=["']([^"']*)["'][^>]*${attribute}=["']${escaped}["'][^>]*>`,
      "i"
    )
  );

  return reverse?.[1] ? decodeHtmlEntities(reverse[1]).trim() : "";
}

function isBlockedOrInformationPage(response: TextResponse): boolean {
  const target = `${response.location} ${response.finalUrl}`.toLowerCase();
  if (target.includes("/bilgilendirme")) return true;
  if (
    /\bBilgilendirme\b/i.test(response.body) &&
    !/wp-manga-chapter-img/i.test(response.body)
  ) {
    return true;
  }
  if (/wp-login\.php/i.test(target)) return true;
  return false;
}

export async function scanNiveraChapters(params: {
  sourceUrl: string;
  startChap: number;
  endChap: number;
  externalSeriesId?: string;
  sourceName?: string;
  requestDelayMs?: number;
}): Promise<NiveraScanResult> {
  if (!isNiveraUrl(params.sourceUrl)) {
    throw new Error(`Geçersiz Nivera URL'si: ${params.sourceUrl}`);
  }

  if (!Number.isFinite(params.startChap) || !Number.isFinite(params.endChap)) {
    throw new Error("Nivera başlangıç ve bitiş bölümleri sayı olmalıdır.");
  }

  if (params.endChap < params.startChap) {
    throw new Error("Nivera bitiş bölümü başlangıç bölümünden küçük olamaz.");
  }

  const source = new URL(params.sourceUrl);
  const origin = source.origin;
  const seriesSlug = extractNiveraSeriesSlug(params.sourceUrl);
  const seriesUrl = buildSeriesUrl(params.sourceUrl, seriesSlug);
  const fallbackTitle =
    String(params.sourceName || "").trim() || titleFromSlug(seriesSlug);
  const delay = Math.max(100, params.requestDelayMs || DEFAULT_DELAY_MS);

  logger.info(
    `Nivera TLS tarama başladı | Seri: ${seriesSlug} | Range: ${params.startChap}-${params.endChap}`
  );

  const chapterList = await postChapterList(
    `${origin}/manga/${encodeURIComponent(seriesSlug)}/ajax/chapters/`,
    seriesUrl
  );

  if (chapterList.status < 200 || chapterList.status >= 300) {
    throw new Error(
      `Nivera bölüm listesi alınamadı. HTTP ${chapterList.status} | Body=${chapterList.body.slice(0, 180)}`
    );
  }

  const candidates = parseChapterCandidates({
    html: chapterList.body,
    baseUrl: seriesUrl,
    startChap: params.startChap,
    endChap: params.endChap,
  });

  logger.info(
    `Nivera modern chapter endpoint | Status: ${chapterList.status} | Body: ${chapterList.body.length} | Chapters: ${candidates.length}`
  );

  if (candidates.length === 0) {
    throw new Error(
      "Nivera bölüm endpoint'i istenen aralıkta bölüm döndürmedi."
    );
  }

  const chapters: NiveraChapterResult[] = [];
  let seriesTitle = fallbackTitle;
  let coverImageUrl = "";
  let description = "";

  for (const candidate of candidates) {
    logger.info(
      `Nivera TLS bölüm isteği | Chapter: ${candidate.chapter} | ${candidate.chapterUrl}`
    );

    const transport = await fetchNiveraText({
      url: candidate.chapterUrl,
      referer: seriesUrl,
      warmUrls: [`${origin}/`, seriesUrl],
    });

    const response: TextResponse = {
      status: transport.status,
      body: transport.body,
      finalUrl: transport.finalUrl,
      location: transport.location,
    };

    logger.info(
      `Nivera TLS sonucu | Chapter: ${candidate.chapter} | Target: ${transport.impersonate} | Status: ${transport.status} | Body: ${transport.body.length} | Location: ${transport.location || "YOK"}`
    );

    if (
      isBlockedOrInformationPage(response) ||
      [301, 302, 303, 307, 308, 401, 403].includes(response.status)
    ) {
      throw new Error(
        `Nivera TLS tarayıcı taklidi yönlendirildi. Chapter ${candidate.chapter} | HTTP ${response.status} | Location=${response.location || "YOK"} | Diagnostics=${transport.diagnostics.join(" || ")}`
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Nivera bölüm sayfası alınamadı. Chapter ${candidate.chapter} | HTTP ${response.status} | Diagnostics=${transport.diagnostics.join(" || ")}`
      );
    }

    const imageUrls = parseNiveraChapterImages(
      response.body,
      candidate.chapterUrl
    );

    if (imageUrls.length === 0) {
      throw new Error(
        `Nivera bölüm HTML'si geldi fakat görsel bulunamadı. Chapter ${candidate.chapter} | Body=${response.body.length}`
      );
    }

    if (chapters.length === 0) {
      seriesTitle = extractTitle(response.body, fallbackTitle);
      coverImageUrl = extractMetaContent(response.body, "og:image");
      description =
        extractMetaContent(response.body, "description", "name") ||
        extractMetaContent(response.body, "og:description");
    }

    chapters.push({
      chapter: candidate.chapter,
      chapterLabel: candidate.chapterLabel,
      chapterUrl: candidate.chapterUrl,
      imageUrls,
    });

    logger.info(
      `Nivera bölüm bulundu | Chapter: ${candidate.chapter} | Page Count: ${imageUrls.length} | TLS: ${transport.impersonate}`
    );

    await sleep(delay);
  }

  return {
    seriesSlug,
    seriesTitle,
    coverImageUrl,
    description,
    chapters,
  };
}
