import axios from "axios";

export type AniListMetadata = {
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  description: string | null;
  coverImage: string | null;
  bannerImage: string | null;
  genres: string[];
  synonyms: string[];
  status: string | null;
  chapters: number | null;
};

function cleanHtml(text: string | null): string | null {
  if (!text) return null;

  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function searchAniListByTitle(
  title: string
): Promise<AniListMetadata | null> {
  const query = `
    query ($search: String) {
      Media(search: $search, type: MANGA) {
        title {
          romaji
          english
          native
        }
        description(asHtml: false)
        coverImage {
          large
          extraLarge
        }
        bannerImage
        genres
        synonyms
        status
        chapters
      }
    }
  `;

  const response = await axios.post(
    "https://graphql.anilist.co",
    {
      query,
      variables: {
        search: title,
      },
    },
    {
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  const media = response.data?.data?.Media;

  if (!media) return null;

  return {
    titleRomaji: media.title?.romaji || title,
    titleEnglish: media.title?.english || null,
    titleNative: media.title?.native || null,
    description: cleanHtml(media.description || null),
    coverImage: media.coverImage?.extraLarge || media.coverImage?.large || null,
    bannerImage: media.bannerImage || null,
    genres: media.genres || [],
    synonyms: media.synonyms || [],
    status: media.status || null,
    chapters: media.chapters || null,
  };
}