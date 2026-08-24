import { describe, expect, it } from "vitest";

import {
  flameRepresentationHeaders,
  mimeTypeForPath,
  selectJsonRepresentation,
} from "./http-delivery.js";

const identity = Buffer.from('{"people":[]}');
const gzip = Buffer.from("compressed timeline");
const representations = { identity, gzip };

describe("timeline representation negotiation", () => {
  it.each([
    ["gzip", "gzip"],
    ["GZip", "gzip"],
    ["br, gzip", "gzip"],
    ["gzip;q=1, identity;q=0.2", "gzip"],
    ["identity;q=0, *;q=0.5", "gzip"],
    ["*", "gzip"],
    ["gzip;q=0.5", "gzip"],
    ["gzip;q=0", null],
    ["gzip;q=0, *;q=1", null],
    ["gzip;q=0.5, identity;q=0.8", null],
    ["br", null],
    ["", null],
    [undefined, null],
  ])("selects %s as %s", (acceptEncoding, expectedEncoding) => {
    const selected = selectJsonRepresentation(representations, acceptEncoding);

    expect(selected.encoding).toBe(expectedEncoding);
    expect(selected.bytes).toBe(expectedEncoding === "gzip" ? gzip : identity);
  });

  it.each([
    "identity;q=0, *;q=0",
    "gzip;q=0, identity;q=0",
    "gzip;q=0, identity;q=0, *;q=1",
    "gzip;q=0, *;q=0",
    "*;q=0",
  ])("rejects all supported representations for %s", (acceptEncoding) => {
    expect(selectJsonRepresentation(representations, acceptEncoding)).toBeNull();
  });

  it("keeps an explicit gzip rejection authoritative over a wildcard", () => {
    expect(selectJsonRepresentation(
      representations,
      "gzip;q=0, *;q=1",
    )).toEqual({ bytes: identity, encoding: null });
  });

  it("describes the exact encoded byte representation sent by the route", () => {
    const selected = selectJsonRepresentation(representations, "gzip");

    expect(flameRepresentationHeaders(selected, "stale")).toEqual({
      "Content-Encoding": "gzip",
      "Content-Length": gzip.byteLength,
      "Content-Type": "application/json; charset=utf-8",
      Vary: "Accept-Encoding",
      "X-Sherlock-Timeline-Cache": "stale",
    });
  });

  it("omits Content-Encoding for identity while retaining content negotiation headers", () => {
    const selected = selectJsonRepresentation(representations, "gzip;q=0");

    expect(flameRepresentationHeaders(selected, "hit")).toEqual({
      "Content-Length": identity.byteLength,
      "Content-Type": "application/json; charset=utf-8",
      Vary: "Accept-Encoding",
      "X-Sherlock-Timeline-Cache": "hit",
    });
  });
});

describe("static asset MIME types", () => {
  it("serves PNG assets as image/png", () => {
    expect(mimeTypeForPath("/assets/bonaparte-logo.ABC123.PNG")).toBe("image/png");
  });

  it("keeps unknown static assets binary", () => {
    expect(mimeTypeForPath("/assets/data.bin")).toBe("application/octet-stream");
  });
});
