import { logger } from "./logger";
import { runImportWorker } from "./importRunner";

const SHORT_IDLE_MS = 5 * 60 * 1000;
const LONG_REST_MS = 60 * 60 * 1000;
const BIG_JOB_CHAPTER_LIMIT = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  logger.info("OtokuVerse Import Worker başlatıldı");

  while (true) {
    const result = await runImportWorker();

    if (!result.hasJob) {
      logger.info("Bekleyen job yok. 5 dakika sonra tekrar kontrol edilecek.");
      await sleep(SHORT_IDLE_MS);
      continue;
    }

    logger.info(
      `Job işlendi | Job ID: ${result.jobId} | Bölüm sayısı: ${result.chapterCount}`
    );

    if (result.chapterCount >= BIG_JOB_CHAPTER_LIMIT) {
      logger.info(
        `${result.chapterCount} bölüm işlendi. Büyük job sonrası 1 saat dinlenilecek.`
      );

      await sleep(LONG_REST_MS);
      continue;
    }

    logger.info("Küçük job tamamlandı. 5 dakika sonra tekrar kontrol edilecek.");
    await sleep(SHORT_IDLE_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});