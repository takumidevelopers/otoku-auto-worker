import "dotenv/config";
import fs from "fs";
import sharp from "sharp";
import {
  S3Client,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const DRY_RUN = false; // önce true, sonra false
const MAX_SLICE_HEIGHT = 4096;
const JPEG_QUALITY = 95;
const REPORT = "b2-long-image-repair-report.txt";
const CHAPTER_CONCURRENCY = 2;

const PREFIXES = [
  "geu-angnyeoreul-josimhaseyo/",
];

const s3 = new S3Client({
  region: process.env.B2_REGION!,
  endpoint: process.env.B2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.B2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.B2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.B2_BUCKET!;

function log(s = "") {
  console.log(s);
  fs.appendFileSync(REPORT, s + "\n", "utf8");
}

function pageNo(key: string) {
  return Number((key.split("/").pop() || "").replace(/\.(jpg|jpeg|png|webp)$/i, "")) || 999999;
}

function chapterPrefixFromKey(key: string) {
  const parts = key.split("/");
  return `${parts[0]}/${parts[1]}/`;
}

async function streamToBuffer(body: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

async function listLatestObjects(prefix: string) {
  let token: string | undefined;
  const out: { key: string; size: number }[] = [];

  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));

    for (const o of res.Contents || []) {
      if (!o.Key) continue;
      if (!/\.(jpg|jpeg|png|webp)$/i.test(o.Key)) continue;
      out.push({ key: o.Key, size: o.Size || 0 });
    }

    token = res.NextContinuationToken;
  } while (token);

  return out;
}

async function download(key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return streamToBuffer(res.Body);
}

async function deleteChapterAllVersions(prefix: string) {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  let total = 0;

  do {
    const res = await s3.send(new ListObjectVersionsCommand({
      Bucket: BUCKET,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    }));

    const targets = [...(res.Versions || []), ...(res.DeleteMarkers || [])]
      .filter(x => x.Key && x.VersionId)
      .map(x => ({ Key: x.Key!, VersionId: x.VersionId! }));

    for (let i = 0; i < targets.length; i += 1000) {
      const batch = targets.slice(i, i + 1000);
      if (!DRY_RUN) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: batch, Quiet: true },
        }));
      }
      total += batch.length;
    }

    keyMarker = res.NextKeyMarker;
    versionIdMarker = res.NextVersionIdMarker;
  } while (keyMarker || versionIdMarker);

  return total;
}

async function uploadJpg(key: string, buffer: Buffer) {
  if (DRY_RUN) return;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "image/jpeg",
  }));
}

async function repairChapter(prefix: string, keys: string[]) {
  keys.sort((a, b) => pageNo(a) - pageNo(b));

  const inputs: { key: string; buffer: Buffer; width: number; height: number }[] = [];
  let needsRepair = false;

  for (const key of keys) {
    const buffer = await download(key);
    const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;

    if (!width || !height) {
      log(`[SKIP_BAD_META] ${key}`);
      continue;
    }

    if (height > MAX_SLICE_HEIGHT) needsRepair = true;
    inputs.push({ key, buffer, width, height });
  }

  if (!needsRepair) {
    log(`[OK_SKIP] ${prefix}`);
    return;
  }

  log(`[REPAIR] ${prefix} | oldFiles=${inputs.length}`);

  const output: Buffer[] = [];

  for (const img of inputs) {
    if (img.height <= MAX_SLICE_HEIGHT) {
      const out = await sharp(img.buffer, { limitInputPixels: false })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      output.push(out);
      continue;
    }

    for (let top = 0; top < img.height; top += MAX_SLICE_HEIGHT) {
      const h = Math.min(MAX_SLICE_HEIGHT, img.height - top);

      const out = await sharp(img.buffer, { limitInputPixels: false })
        .extract({ left: 0, top, width: img.width, height: h })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();

      output.push(out);
    }
  }

  log(`[REPAIR_READY] ${prefix} | newFiles=${output.length}`);

  const deleted = await deleteChapterAllVersions(prefix);
  log(`[DELETE_VERSIONS] ${prefix} | count=${deleted}`);

  for (let i = 0; i < output.length; i++) {
    const key = `${prefix}${i + 1}.jpg`;
    await uploadJpg(key, output[i]);
  }

  log(`[DONE] ${prefix} | uploaded=${output.length}`);
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function main() {
  fs.writeFileSync(REPORT, "", "utf8");
  log(`DRY_RUN=${DRY_RUN}`);
  log(`MAX_SLICE_HEIGHT=${MAX_SLICE_HEIGHT}`);

  for (const seriesPrefix of PREFIXES) {
    log(`\n===== SERIES ${seriesPrefix} =====`);

    const objects = await listLatestObjects(seriesPrefix);
    const chapterMap = new Map<string, string[]>();

    for (const o of objects) {
      const cp = chapterPrefixFromKey(o.key);
      chapterMap.set(cp, [...(chapterMap.get(cp) || []), o.key]);
    }

    const chapters = [...chapterMap.keys()].sort((a, b) => {
      const ca = Number(a.split("/")[1]) || 0;
      const cb = Number(b.split("/")[1]) || 0;
      return ca - cb;
    });

    log(`chapterCount=${chapters.length}`);

    // Şüpheli duplicate/boş kontrolü
    const sigs = new Map<string, string>();
    for (const cp of chapters) {
      const ks = chapterMap.get(cp) || [];
      const sig = ks.sort((a, b) => pageNo(a) - pageNo(b)).join("|");
      if (sigs.has(sig)) log(`[POSSIBLE_DUPLICATE] ${sigs.get(sig)} == ${cp}`);
      sigs.set(sig, cp);
      if (ks.length <= 1) log(`[SUSPICIOUS_FEW_FILES] ${cp} | count=${ks.length}`);
    }

    await runLimited(chapters, CHAPTER_CONCURRENCY, async (cp) => {
      try {
        await repairChapter(cp, chapterMap.get(cp) || []);
      } catch (e) {
        log(`[ERROR] ${cp} | ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  log("\nTamamlandı.");
}

main().catch((e) => {
  log(e?.stack || String(e));
  process.exit(1);
});