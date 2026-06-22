import { logger } from "./logger";
import { runImportWorker } from "./importRunner";

const SHORT_IDLE_MS = 5 * 60 * 1000;
const NEXT_JOB_DELAY_MS = 3000;

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

    logger.info("Sıradaki job kontrol ediliyor.");
    await sleep(NEXT_JOB_DELAY_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});