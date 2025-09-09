// - Auth via API-Key header equals process.env.UPLOAD_KEY
// - Max zip size 100 MB
// - Multipart "file" expected; unzip into S3 prefix "<uuid>/"
// - Return https://{uuid}.{BASE_DOMAIN}/
// Notes:
// - API Gateway must pass the body as base64 for multipart; we handle decoding.
// - We stream the zip entries straight to S3 to avoid large /tmp writes.
// - Directory entries in the zip are ignored; file entries are uploaded preserving paths.

import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import mime from "mime-types";
import Busboy from "busboy";
import unzipper from "unzipper";
import { randomUUID } from "crypto"; // Node 20 native
import { Buffer } from "buffer";

// ----- Config (injected via Terraform) -----
const {
  UPLOAD_KEY, // same as your .env UPLOAD_KEY
  BASE_DOMAIN, // e.g., autograder-artifacts-sp25.160.tja.io
  BUCKET_NAME, // S3 bucket storing extracted files
  MAX_CONTENT_LENGTH_MB, // "100"
} = process.env;

const MAX_BYTES = Number(MAX_CONTENT_LENGTH_MB || "100") * 1024 * 1024;
const s3 = new S3Client({});

function contentTypeFor(key) {
  const guess = mime.lookup(key) || "application/octet-stream";
  // mime.contentType() returns e.g. "text/html; charset=utf-8"
  return mime.contentType(guess) || "application/octet-stream";
}

// Small helper: stream zip entry to S3 under a given key
async function putS3Stream(key, stream) {
  // Use managed multipart upload so we don’t need ContentLength on streams.
  const up = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentTypeFor(key),
      Body: stream,
      StorageClass: "INTELLIGENT_TIERING",
    },
    // conservative defaults for Lambda memory/IO
    queueSize: 3, // parallel parts
    partSize: 8 * 1024 * 1024, // 8 MiB
  });
  await up.done();
}

// Parse multipart/form-data body using Busboy.
// Returns a Buffer of the uploaded file (we'll pipe to unzipper) and original filename.
// NOTE: For big zips you could stream directly to unzipper; we keep it simple & safe within 100 MB.
function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];
    if (!contentType || !contentType.includes("multipart/form-data")) {
      return reject(
        Object.assign(new Error("No multipart/form-data"), { statusCode: 400 })
      );
    }

    const bb = Busboy({ headers: { "content-type": contentType } });
    const chunks = [];
    let total = 0;
    let gotFile = false;
    let filename = "";

    bb.on("file", (fieldname, file, info) => {
      // Expect the field to be "file", but accept any single file field to keep parity with your Flask handler.
      gotFile = true;
      filename = info.filename || "upload.zip";
      file.on("data", (d) => {
        total += d.length;
        if (total > MAX_BYTES) {
          file.unpipe();
          bb.emit(
            "error",
            Object.assign(new Error("Payload too large"), { statusCode: 413 })
          );
          return;
        }
        chunks.push(d);
      });
    });

    bb.on("field", () => {
      /* ignored */
    });

    bb.on("finish", () => {
      if (!gotFile)
        return reject(
          Object.assign(new Error("No file part"), { statusCode: 400 })
        );
      resolve({ buffer: Buffer.concat(chunks), filename });
    });

    bb.on("error", (err) => reject(err));

    // Body comes base64-encoded from API Gateway for binary types
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : Buffer.from(event.body || "");
    bb.end(body);
  });
}

// Extract the zip buffer and stream files into S3 under prefix "<folderId>/"
async function extractZipBufferToS3(folderId, buffer) {
  // unzipper supports Buffer source
  const directory = await unzipper.Open.buffer(buffer);
  const uploads = directory.files
    .filter((f) => !f.path.endsWith("/")) // ignore folders
    .map(async (f) => {
      const stream = await f.stream();
      const key = `${folderId}/${f.path}`;
      await putS3Stream(key, stream);
    });
  await Promise.all(uploads);
}

export const handler = async (event) => {
  try {
    // --- Auth ---
    const headerKey =
      event.headers["api-key"] ||
      event.headers["API-Key"] ||
      event.headers["Api-Key"];
    if (!UPLOAD_KEY || headerKey !== UPLOAD_KEY) {
      return {
        statusCode: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    if (!event.body) {
      return {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "No file part" }),
      };
    }

    // --- Parse multipart & enforce size ---
    const { buffer } = await parseMultipart(event);

    // --- Create folder ID and extract to S3 ---
    const folderId = randomUUID();
    await extractZipBufferToS3(folderId, buffer);

    // --- Return URL matching your pattern ---
    const url = `https://${folderId}.${BASE_DOMAIN}/`;
    return {
      statusCode: 201,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return {
      statusCode,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: statusCode === 500 ? "Internal Server Error" : err.message,
      }),
    };
  }
};
