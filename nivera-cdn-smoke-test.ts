import "dotenv/config";
import { scanNiveraCdnChapters } from "./src/niveraCdn";

async function main() {
  const sourceUrl =
    process.argv[2] ||
    "https://yedek.mangawow.com/nivera/data/manga_62f38fb4701bd/1-bolum/0-be-my-villain.jpg";
  const startChap = Number(process.argv[3] || 1);
  const endChap = Number(process.argv[4] || startChap);
  const sourceName = process.argv[5] || "Be My Villain";

  const chapters = await scanNiveraCdnChapters({
    sourceUrl,
    sourceName,
    startChap,
    endChap,
    maxGroups: 40,
    pageMax: 300,
    groupMissLimit: 3,
    pageMissLimit: 3,
    requestDelayMs: 0,
  });

  if (chapters.length === 0) {
    throw new Error("No chapter was found in the smoke test.");
  }

  console.log("");
  console.log("========== NIVERA CDN V4.0.2 TEST ==========");

  for (const chapter of chapters) {
    console.log(`Chapter      : ${chapter.chapter}`);
    console.log(`Folder       : ${chapter.chapterSlug}`);
    console.log(`Image count  : ${chapter.imageUrls.length}`);
    console.log(`First image  : ${chapter.imageUrls[0]}`);
    console.log(`Last image   : ${chapter.imageUrls[chapter.imageUrls.length - 1]}`);
  }
}

main().catch((error) => {
  console.error("NIVERA CDN V4.0.2 TEST FAILED:");
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
