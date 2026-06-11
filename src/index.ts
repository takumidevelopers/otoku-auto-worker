import { logger } from "./logger";
import { runImportWorker } from "./importRunner";

async function main() {
  logger.info("OtokuVerse Import Worker başlatıldı");
  await runImportWorker();
  logger.info("OtokuVerse Import Worker işi bitti");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});