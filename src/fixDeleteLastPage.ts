import "dotenv/config";
import mysql from "mysql2/promise";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const DRY_RUN = false; // önce true yapıp test edebilirsin

const EXCLUDED_SERIES_NAMES = ["Choujin X", "Angel Densetsu"];

const s3 = new S3Client({
  region: process.env.B2_REGION || "us-east-005",
  endpoint: process.env.B2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.B2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.B2_SECRET_ACCESS_KEY || "",
  },
});

const BUCKET = process.env.B2_BUCKET || "otokumobileapp";

function pageNumberFromKey(key: string): number {
  const file = key.split("/").pop() || "";
  const match = file.match(/^(\d+)\.(jpg|jpeg|png|webp)$/i);
  return match ? Number(match[1]) : -1;
}

async function deleteLastPageInChapter(prefix: string) {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
    })
  );

  const objects = (res.Contents || [])
    .map((item) => item.Key)
    .filter((key): key is string => !!key)
    .filter((key) => /\.(jpg|jpeg|png|webp)$/i.test(key));

  if (objects.length === 0) return;

  const sorted = objects.sort((a, b) => pageNumberFromKey(a) - pageNumberFromKey(b));
  const lastKey = sorted[sorted.length - 1];

  console.log(`[SON GÖRSEL] ${lastKey}`);

  if (!DRY_RUN) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: lastKey,
      })
    );

    console.log(`[SİLİNDİ] ${lastKey}`);
  }
}

async function main() {
  const db = await mysql.createConnection({
    host: "localhost",
    user: "gecegaze_adminuser",
    password: process.env.DB_PASSWORD || "",
    database: "gecegaze_otokumobile",
  });

  const [rows] = await db.execute<any[]>(`
    SELECT DISTINCT ij.series_id, ij.series_name
    FROM import_jobs ij
    WHERE ij.status = 'completed'
      AND ij.series_id IS NOT NULL
      AND ij.series_id <> ''
  `);

  for (const row of rows) {
    const seriesId = String(row.series_id || "").trim();
    const seriesName = String(row.series_name || "").trim();

    if (!seriesId) continue;

    if (EXCLUDED_SERIES_NAMES.includes(seriesName)) {
      console.log(`[ATLANDI] ${seriesName} / ${seriesId}`);
      continue;
    }

    console.log(`\n[SERİ] ${seriesName} / ${seriesId}`);

    const [chapters] = await db.execute<any[]>(
      `
      SELECT eps
      FROM chapters
      WHERE series_id = ?
      ORDER BY CAST(eps AS UNSIGNED) ASC
      `,
      [seriesId]
    );

    for (const chapter of chapters) {
      const eps = String(chapter.eps).trim();
      const prefix = `${seriesId}/${eps}/`;

      await deleteLastPageInChapter(prefix);
    }
  }

  await db.end();
  console.log("\n[TAMAMLANDI]");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});