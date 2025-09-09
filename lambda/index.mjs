// index.mjs (add these imports)
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import unzipper from "unzipper";
import mime from "mime-types";
import { randomUUID } from "crypto";

const s3 = new S3Client({});
const {
  UPLOAD_KEY,
  BASE_DOMAIN,
  BUCKET_NAME,
  MAX_CONTENT_LENGTH_MB = "100",
} = process.env;

const MAX_BYTES = Number(MAX_CONTENT_LENGTH_MB) * 1024 * 1024;
const STAGING_PREFIX = "incoming/";

function contentTypeFor(key) {
  const guess = mime.lookup(key) || "application/octet-stream";
  return mime.contentType(guess) || "application/octet-stream";
}

async function putS3Stream(key, stream) {
  const up = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: stream,
      StorageClass: "INTELLIGENT_TIERING",
      ContentType: contentTypeFor(key),
    },
    queueSize: 3,
    partSize: 8 * 1024 * 1024,
  });
  await up.done();
}

// robustly collect a Node stream into a Buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

// ---- handler ----
export const handler = async (event) => {
  try {
    const keyHdr =
      event?.headers?.["api-key"] ||
      event?.headers?.["API-Key"] ||
      event?.headers?.["Api-Key"];
    if (!UPLOAD_KEY || keyHdr !== UPLOAD_KEY) {
      return {
        statusCode: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const method = event?.requestContext?.http?.method || "GET";
    const path = (event?.rawPath || "/").replace(/\/+$/, ""); // strip trailing slash

    // --- 1) INIT: get a presigned PUT URL to S3 for the zip ---
    if (method === "POST" && path === "/upload/init") {
      const uuid = randomUUID();
      const key = `${STAGING_PREFIX}${uuid}.zip`;
      const putUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
          ContentType: "application/zip", // client must send this
        }),
        { expiresIn: 900 } // 15 minutes
      );
      const completeUrl = `/upload/complete?uuid=${uuid}`;
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uuid, putUrl, completeUrl }),
      };
    }

    // --- 2) COMPLETE: unzip the staged object and return final URL ---
    if (method === "POST" && path === "/upload/complete") {
      const qs = new URLSearchParams(event.rawQueryString || "");
      const uuid = qs.get("uuid");
      if (!uuid) {
        return {
          statusCode: 400,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "missing uuid" }),
        };
      }

      const stagingKey = `${STAGING_PREFIX}${uuid}.zip`;

      // 1) download staged zip from S3
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: stagingKey })
      );

      // 2) buffer it (avoids fragile stream piping issues)
      const zipBuf = await streamToBuffer(obj.Body);

      // guard against giant files (parity with your MAX_CONTENT_LENGTH_MB)
      if (zipBuf.length > MAX_BYTES) {
        return {
          statusCode: 413,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "Payload too large" }),
        };
      }

      // 3) unzip from buffer and stream each entry to S3 under <uuid>/
      const directory = await unzipper.Open.buffer(zipBuf);
      await Promise.all(
        directory.files
          .filter((f) => !f.path.endsWith("/")) // ignore folders
          .map(async (f) => {
            const stream = await f.stream(); // uncompressed file stream
            const key = `${uuid}/${f.path}`;
            await putS3Stream(key, stream); // sets ContentType, uses multipart
          })
      );

      // optional: clean up the staged zip
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: stagingKey }));

      const url = `https://${uuid}.${BASE_DOMAIN}/`;
      return {
        statusCode: 201,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      };
    }
    return {
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Not Found" }),
    };
  } catch (err) {
    console.error("UPLOAD_ERROR", err && (err.stack || err.message || err));
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Internal Server Error" }),
    };
  }
};
