// SPDX-License-Identifier: MIT
//
// The Mailgun system-mail path: parsing the secret, choosing the sender, building the request.
// No AWS and no network - the secret read and the HTTP call are thin wrappers around these.

import {
  MAILGUN_SECRET_FIELDS,
  parseMailgunSecret,
} from "../lambdas/neotms/nodejs/neotms/mail/NeotmsMailgunSecret.js";
import { buildMailgunForm, senderAddress } from "../lambdas/neotms/nodejs/neotms/mail/NeotmsMailgunMail.js";

describe("parseMailgunSecret", () => {
  test("reads the key and the domain from one JSON document", () => {
    expect(parseMailgunSecret('{"apiKey":"key-1","domain":"lion-korea.com"}')).toEqual({
      apiKey: "key-1",
      domain: "lion-korea.com",
    });
    expect(MAILGUN_SECRET_FIELDS).toEqual({ apiKey: "apiKey", domain: "domain" });
  });

  test("a domain pasted as a URL is reduced to its host", () => {
    expect(parseMailgunSecret('{"apiKey":"k","domain":" https://Mail.Lion-Korea.com/ "}')?.domain).toBe(
      "mail.lion-korea.com",
    );
  });

  test("both fields are required; a bare key is refused rather than half-working", () => {
    expect(parseMailgunSecret('{"apiKey":"k"}')).toBeNull();
    expect(parseMailgunSecret('{"domain":"lion-korea.com"}')).toBeNull();
    expect(parseMailgunSecret('{"apiKey":"","domain":"lion-korea.com"}')).toBeNull();
    expect(parseMailgunSecret('{"apiKey":"k","domain":"  "}')).toBeNull();
    expect(parseMailgunSecret("key-without-json")).toBeNull();
    expect(parseMailgunSecret('"just a string"')).toBeNull();
    expect(parseMailgunSecret('{"apiKey":1,"domain":"lion-korea.com"}')).toBeNull();
  });
});

describe("sending", () => {
  test("the sender defaults to no-reply at the secret's domain", () => {
    // NEOTMS_MAIL_FROM_ADDRESS is blank in the test environment, as it is on both stages today.
    expect(senderAddress("lion-korea.com")).toBe("no-reply@lion-korea.com");
  });

  test("the form carries every recipient and omits empty optional fields", () => {
    const form = buildMailgunForm(
      { to: ["a@example.com", "b@example.com"], subject: "S", html: "<p>H</p>", bcc: ["c@example.com"] },
      "TMS <no-reply@lion-korea.com>",
    );
    expect(form.getAll("to")).toEqual(["a@example.com", "b@example.com"]);
    expect(form.getAll("bcc")).toEqual(["c@example.com"]);
    expect(form.has("cc")).toBe(false);
    expect(form.has("text")).toBe(false);
    expect(form.has("h:Reply-To")).toBe(false);
    expect(form.get("from")).toBe("TMS <no-reply@lion-korea.com>");
  });
});
