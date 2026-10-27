// SPDX-License-Identifier: MIT
//
// Thin wrapper around AWS S3.
//
// Deliberately env-free: every function takes the bucket name as an argument, so this module can
// be reused across projects and the bucket is chosen by the caller (LDS reads it from AppEnv).

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadObjectCommand,
  HeadObjectOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client: S3Client | null = null;

export interface S3PresignedURLObject {
  /** The endpoint the client sends its PUT (upload) or GET (download) request to. */
  url: string;
  /** The S3 key the object lives at — the value to persist alongside the domain record. */
  fileKey: string;
}

/** Default validity for a presigned upload URL. Generous because files can be large and slow. */
const PRESIGN_UPLOAD_TTL_SEC = 900;
/**
 * Default validity for a presigned download URL. Short on purpose: the URL is handed straight to
 * the browser as a redirect and used immediately, and anyone holding it can read the object
 * without further authorisation.
 */
const PRESIGN_DOWNLOAD_TTL_SEC = 60;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client();
  }
  return client;
}

export async function createS3Object(prefix: string, content: string, bucketName : string): Promise<string> {
  const key = `${prefix}${randomUUID()}.txt`;
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: Buffer.from(content, "utf-8"),
      ContentType: "text/plain",
    }),
  );
  return key;
}

/**
 * Presign a PUT so the client can upload straight to S3, bypassing the Lambda entirely.
 *
 * `fileKey` should be supplied by the caller wherever the object belongs to a domain record —
 * LDS uses `documents/<companyId>/<docId>/<filename>`, which keeps keys immutable and makes an
 * orphaned object traceable back to its owner. When omitted, a random key under `uploads/` is
 * generated, which is only appropriate for staging.
 *
 * ⚠️ The client MUST send exactly the `contentType` signed here, or S3 rejects the upload with
 * SignatureDoesNotMatch — a mismatch here is the usual cause of "the presigned URL doesn't work".
 *
 * ⚠️ A presigned PUT carries no size limit. If an upload cap matters (the legacy app enforced
 * 15 MB), enforce it with a presigned POST policy carrying a content-length-range condition, or
 * verify the size with headS3Object before committing the domain record.
 */
export async function generateS3PresignedUploadURL(
  fileName : string,
  contentType : string,
  bucketName : string,
  fileKey? : string,
  expiresInSec : number = PRESIGN_UPLOAD_TTL_SEC,
): Promise<S3PresignedURLObject> {
  if (!bucketName) {
    throw new Error("generateS3PresignedUploadURL: bucketName is required.");
  }

  // A UUID in the key prevents duplicate filenames and unintentional overwrites
  // (e.g. uploads/<uuid>-report.pptx).
  const key = fileKey ?? `uploads/${randomUUID()}-${fileName}`;

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
  });

  return {
    url : await getSignedUrl(getClient(), command, { expiresIn: expiresInSec }),
    fileKey : key,
  };
}

/**
 * Presign a GET so the browser can download or preview the object directly.
 *
 * `fileName` and `disposition` matter more than they look. Without an explicit
 * ResponseContentDisposition the browser names the saved file after the S3 key, so a document
 * stored as `documents/<uuid>/<uuid>` downloads under that name instead of 국세완납증명서.pdf.
 * The filename is emitted in RFC 5987 form, which is what preserves Hangul — the same reason the
 * legacy FastAPI handlers built `filename*=UTF-8''` headers by hand.
 *
 * `disposition: "inline"` is what the in-page PDF/image preview needs; "attachment" forces a save.
 */
export async function generateS3PresignedGetURL(
  fileKey : string,
  bucketName : string,
  options? : {
    fileName? : string;
    disposition? : "inline" | "attachment";
    contentType? : string;
    expiresInSec? : number;
  },
): Promise<S3PresignedURLObject> {
  if (!bucketName) {
    throw new Error("generateS3PresignedGetURL: bucketName is required.");
  }

  const disposition = options?.disposition ?? "attachment";
  const responseContentDisposition = options?.fileName
    ? `${disposition}; filename*=UTF-8''${encodeURIComponent(options.fileName)}`
    : disposition;

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: fileKey,
    ResponseContentDisposition: responseContentDisposition,
    ...(options?.contentType && { ResponseContentType: options.contentType }),
  });

  return {
    url : await getSignedUrl(getClient(), command, {
      expiresIn: options?.expiresInSec ?? PRESIGN_DOWNLOAD_TTL_SEC,
    }),
    fileKey : fileKey,
  };
}

/**
 * Copy an object to a new key and delete the original.
 *
 * S3 has no native move. The copy is confirmed before the delete, so a failure leaves the
 * original intact rather than losing the object.
 *
 * LDS should rarely need this — object keys are immutable there, and re-issuing a document
 * writes a new key rather than moving the old one.
 */
export async function moveS3Object(sourceKey: string, destinationKey: string, bucketName : string): Promise<void> {
  await getClient().send(
    new CopyObjectCommand({
      Bucket: bucketName,
      // CopySource is "<bucket>/<key>" and must be URI-encoded, or any key containing a space or
      // a Hangul character fails — which is most of this dataset.
      CopySource: encodeURI(`${bucketName}/${sourceKey}`),
      Key: destinationKey,
    }),
  );
  await getClient().send(new DeleteObjectCommand({ Bucket: bucketName, Key: sourceKey }));
}

export async function getS3TextObject(key: string, bucketName : string): Promise<string> {
  try {
    const response = await getClient().send(
      new GetObjectCommand({ Bucket: bucketName, Key: key }),
    );
    if (!response.Body) return "";
    return await response.Body.transformToString("utf-8");
  } catch (error: any) {
    if (error?.name === "NoSuchKey") return "";
    throw error;
  }
}

export async function getS3ObjectAsFile(key: string, bucketName : string): Promise<File | null> {
  try {
    const response = await getClient().send(
      new GetObjectCommand({ Bucket: bucketName, Key: key }),
    );
    if (!response.Body) return null;
    const bytes = await response.Body.transformToByteArray();
    const type = response.ContentType ?? "application/octet-stream";
    return new File([bytes] as BlobPart[], key, { type });
  } catch (error: any) {
    if (error?.name === "NoSuchKey") return null;
    throw error;
  }
}

export async function getS3Object(key: string, bucketName : string): Promise<GetObjectCommandOutput | null> {
  try {
    // GetObject already returns ContentLength, ContentType and ETag on the response, so there is
    // no need for a second GetObjectAttributes round trip (which would also require the extra
    // s3:GetObjectAttributes permission).
    return await getClient().send(
      new GetObjectCommand({ Bucket: bucketName, Key: key }),
    );
  } catch (error: any) {
    if (error?.name === "NoSuchKey") return null;
    throw error;
  }
}

/**
 * Metadata for an object, or null when it does not exist.
 *
 * ⚠️ HeadObject signals a missing key as `NotFound`, NOT `NoSuchKey` — S3 answers HEAD with a
 * bare 404 and no error body, so the SDK cannot read the richer code that GetObject returns.
 * Catching only NoSuchKey here would make a missing object throw instead of returning null, which
 * matters because this is the "did the upload actually land?" check before committing a record.
 */
export async function headS3Object(key: string, bucketName : string): Promise<HeadObjectOutput | null> {
  try {
    return await getClient().send(new HeadObjectCommand({ Bucket : bucketName, Key : key }));
  } catch (error: any) {
    if (error?.name === "NotFound" || error?.name === "NoSuchKey"
      || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

export async function deleteS3Object(key: string, bucketName : string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

/** Test-only: drop the cached client. Mirrors DynamoDBUtils._resetClient. */
export function _resetClient(): void {
  client = null;
}
