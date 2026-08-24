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

  it.each([
    ["gzip", "stale", gzip, { "Content-Encoding": "gzip" }],
    ["gzip;q=0", "hit", identity, {}],
  ])("describes exact %s bytes and negotiation headers", (acceptEncoding, cache, bytes, encoding) => {
    const selected = selectJsonRepresentation(representations, acceptEncoding);
    expect(flameRepresentationHeaders(selected, cache)).toEqual({
      ...encoding,
      "Content-Length": bytes.byteLength,
      "Content-Type": "application/json; charset=utf-8",
      Vary: "Accept-Encoding",
      "X-Sherlock-Timeline-Cache": cache,
    });
  });
});

describe("static asset MIME types", () => {
  it.each([
    ["/assets/bonaparte-logo.ABC123.PNG", "image/png"],
    ["/assets/data.bin", "application/octet-stream"],
  ])("serves %s as %s", (path, mime) => {
    expect(mimeTypeForPath(path)).toBe(mime);
  });
});
