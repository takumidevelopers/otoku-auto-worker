import dotenv from "dotenv";

dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",

  b2: {
    endpoint: process.env.B2_ENDPOINT || "",
    bucket: process.env.B2_BUCKET || "",
    region: process.env.B2_REGION || "",
    accessKeyId: process.env.B2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.B2_SECRET_ACCESS_KEY || "",
    downloadBase: process.env.B2_DOWNLOAD_BASE || "",
  },

  api: {
    baseUrl: process.env.OTOKU_API_BASE_URL || "",
    token: process.env.OTOKU_API_TOKEN || "",
  },

  worker: {
    concurrency: Number(process.env.WORKER_CONCURRENCY || 5),
    retryCount: Number(process.env.WORKER_RETRY_COUNT || 5),
    retryDelay: Number(process.env.WORKER_RETRY_DELAY || 1000),
  },
};