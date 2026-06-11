import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import { config } from "./config";

export const b2 = new S3Client({
  region: config.b2.region,
  endpoint: config.b2.endpoint,
  credentials: {
    accessKeyId: config.b2.accessKeyId,
    secretAccessKey: config.b2.secretAccessKey,
  },
});

export async function testB2Connection() {
  return b2.send(
    new ListObjectsV2Command({
      Bucket: config.b2.bucket,
      MaxKeys: 5,
    })
  );
}

export async function uploadBufferToB2(params: {
  key: string;
  buffer: Buffer;
  contentType: string;
}) {
  await b2.send(
    new PutObjectCommand({
      Bucket: config.b2.bucket,
      Key: params.key,
      Body: params.buffer,
      ContentType: params.contentType,
    })
  );

  return `${config.b2.downloadBase}/${params.key}`;
}