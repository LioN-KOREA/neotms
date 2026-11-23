// SPDX-License-Identifier: MIT
//
// Uploading a file for a PO request mail, and serving it back to the translator 21 days later.
//
// ## Two endpoints, two completely different audiences
//
// `createUpload` is called by a signed-in PM composing a mail. `resolveDownload` is called by a
// translator - somebody with no account here, clicking a link in their inbox - and is therefore
// the only route in this API that is not behind the guard at all. That asymmetry is the whole
// security design of this module, so it is stated in one place:
//
//   * The upload endpoint is permissioned, scoped to a PO the caller can already see, and the key
//     it hands out is chosen by the server. The browser never names a key.
//   * The download endpoint takes a token and nothing else. It cannot be enumerated (the token is
//     256 bits of randomness), it cannot be widened (the row names exactly one object key), and it
//     cannot outlive its row. What it does NOT do is prove who is asking, because nothing about a
//     translator is known to this system.
//
// ## Why the bytes never pass through this function
//
// The browser PUTs straight to S3 with a presigned URL, and the translator GETs straight from S3
// after a redirect. A 100MB file through Lambda would hit the 6MB response payload limit on the
// way out and bill for the transfer in both directions. The bucket's CORS rule exists for exactly
// this, and the attachment bucket was built this way before anything used it (NeotmsStorage.ts).

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { NeotmsEnv } from "../../env/NeotmsEnv.js";
import { dynamoDBGet, dynamoDBPut } from "../../utils/DynamoDBUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { badRequest, notFound, ok } from "../NeotmsResult.js";
import type { AttachmentUploadInput } from "../neotms.schemas.js";
import {
  ATTACHMENT_TTL_DAYS,
  AttachmentGetOps,
  AttachmentPutOps,
} from "./NeotmsAttachment.dbops.js";

/**
 * How long the browser has to finish the upload. Minutes, not days: this URL is handed to the
 * person who asked for it and used immediately, and it writes rather than reads.
 */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * How long the redirect target is good for. Seconds, because the browser follows it at once.
 *
 * Short on purpose: this is the only URL in the system that points directly at the object, and it
 * is handed to somebody outside the company. If it leaks - a referrer header, a shared screenshot,
 * a proxy log - it is already useless. The link the translator keeps is ours, and it is revocable.
 */
const DOWNLOAD_URL_TTL_SECONDS = 60;

/** 100MB, the ceiling the bucket was sized for. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

let client: S3Client | null = null;
const s3 = (): S3Client => (client ??= new S3Client({}));

/** Test seam, matching `_resetClient` in DynamoDBUtils. */
export function _resetS3Client(): void {
  client = null;
}

export type AttachmentUpload = {
  /** PUT the bytes here, with the same content type. Expires in fifteen minutes. */
  uploadUrl: string;
  /** What the send endpoint is given once the upload succeeds. */
  token: string;
  fileName: string;
};

/**
 * A file name that is safe to put in an S3 key and in a `Content-Disposition` header.
 *
 * The original is kept in DynamoDB untouched - it is what the translator should see - and this is
 * only for the key. Stripping the path separators is the part that matters: a name of
 * `../../etc/passwd` would otherwise choose where in the bucket the object lands, and the key is
 * supposed to be the server's decision.
 */
const safeKeyPart = (fileName: string): string =>
  fileName
    .replace(/[\\/]/g, "_")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .slice(0, 120);

/**
 * Hand the browser a presigned PUT and record nothing yet.
 *
 * The row is written HERE rather than after the upload, and that is the opposite of the `tmp/`
 * staging pattern the bucket's lifecycle rule describes. The reason is that the token has to exist
 * before the mail is composed, and the mail is composed after the upload in one dialog - so a
 * two-step confirm would be a second round trip for no gain. The cost is a row that may point at an
 * object that was never written; the lifecycle rule sweeps the object, the TTL sweeps the row, and
 * a link to a missing object answers 404 rather than anything worse.
 */
export async function createUpload(
  caller: NeotmsCaller,
  input: AttachmentUploadInput,
): Promise<ResponseData<AttachmentUpload | string>> {
  const bucket = NeotmsEnv.NEOTMS_ATTACHMENT_BUCKET_NAME;
  if (!bucket) {
    console.error("NEOTMS_ATTACHMENT_BUCKET_NAME is not set; cannot accept uploads.");
    return { status: 500, body: "Attachment storage is not configured on this deployment." };
  }
  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    return badRequest(
      `That file is ${String(Math.round(input.sizeBytes / 1024 / 1024))}MB, over the 100MB ` +
        `limit for one attachment. Split it or compress it before uploading.`,
    );
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + ATTACHMENT_TTL_DAYS * 24 * 60 * 60 * 1000;
  /*
   * The key carries the PO and the token, and the token is what makes it unique. The PO id is in
   * there for the benefit of whoever is looking at the bucket a year from now trying to work out
   * what a file was - the application never reads it back out of the key.
   */
  const objectKey = `po-request/${input.poId}/${token}/${safeKeyPart(input.fileName)}`;

  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: input.contentType,
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );

  const written = await dynamoDBPut(
    AttachmentPutOps(token, {
      objectKey,
      fileName: input.fileName,
      contentType: input.contentType,
      createdBy: caller.mgrId,
      poId: input.poId,
      expiresAt,
    }),
  );
  if (written.status >= 400) {
    console.error(`Could not record the attachment token: ${written.message}`);
    return { status: 500, body: "The upload could not be registered. Please try again." };
  }

  return ok({ uploadUrl, token, fileName: input.fileName });
}

/** What the public download route answers with. A redirect, not bytes. */
export type AttachmentRedirect = { location: string };

/**
 * Turn a token from a mail into a short-lived presigned URL.
 *
 * ## This is the unauthenticated one
 *
 * There is no caller. The translator has no account, and inventing one for them would mean asking
 * somebody outside the company to sign in to a system they have never heard of in order to read a
 * file that was mailed to them. The token is the authorisation, which is why it is 256 bits from
 * `randomBytes` rather than anything derived, sequential or guessable.
 *
 * Everything it can do is bounded by the row: one object key, chosen by the server at upload time,
 * for as long as the row lives. It cannot list, cannot traverse and cannot be widened by anything
 * in the request.
 *
 * ## Expiry is checked here as well as swept by TTL
 *
 * DynamoDB deletes a TTL row within about 48 hours of its timestamp, not at it. Trusting absence
 * would mean a link quietly working for up to two days past the 21 the translator was promised.
 */
export async function resolveDownload(
  token: string,
): Promise<ResponseData<AttachmentRedirect | string>> {
  const bucket = NeotmsEnv.NEOTMS_ATTACHMENT_BUCKET_NAME;
  if (!bucket) {
    console.error("NEOTMS_ATTACHMENT_BUCKET_NAME is not set; cannot serve downloads.");
    return { status: 500, body: "Attachment storage is not configured on this deployment." };
  }

  const found = await dynamoDBGet(AttachmentGetOps(token));
  const record = found.data;
  /*
   * The same answer for "no such token" and "expired", deliberately. Telling the two apart would
   * let somebody holding an old link learn that it was once valid, and would turn this endpoint
   * into an oracle for whether a guessed token ever existed.
   */
  if (!record || record.expiresAt <= Date.now()) {
    return notFound("file");
  }

  const location = await getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: record.objectKey,
      /*
       * The name the translator uploaded it as, not the key. Without this the browser saves the
       * file under the last path segment, which carries the sanitised name - so a Korean file name
       * would arrive as a row of underscores.
       */
      ResponseContentDisposition: contentDisposition(record.fileName),
      ResponseContentType: record.contentType,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );

  return ok({ location });
}

/**
 * `attachment; filename*=UTF-8''...`, which is how a non-ASCII file name survives the header.
 *
 * The plain `filename=` form is latin-1 only, so a Korean name in it is mojibake or a dropped
 * header depending on the client. RFC 5987's `filename*` is understood by every browser in use and
 * is the only form that carries 번역본.docx intact.
 */
const contentDisposition = (fileName: string): string =>
  `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
