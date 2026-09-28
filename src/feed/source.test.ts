import assert from "node:assert/strict";
import test from "node:test";
import { getSourceConnector, SourceConnectorError, sourceConnectorRegistry } from "./source.js";
import type { FeedSource } from "../runtime/types.js";

const source: FeedSource = {
  id: "sample",
  name: "Sample",
  kind: "rss",
  connectorConfig: {},
  url: "https://example.com/feed.xml",
  enabled: true,
  priority: 0,
  tags: [],
  etag: "old",
  lastModified: null,
  baselineAt: null,
  lastCheckedAt: null,
  lastSuccessAt: null,
  errorCode: null,
  createdAt: 0,
  updatedAt: 0,
};

const lookup = async (_hostname: string, _options: { all: true; verbatim: true }) => [{ address: "93.184.216.34", family: 4 }];

test("registry resolves only explicitly registered source kinds", () => {
  assert.ok(sourceConnectorRegistry.has("rss"));
  assert.equal(getSourceConnector("rss").kind, "rss");
  assert.throws(() => getSourceConnector("github"), (error: unknown) => {
    assert.ok(error instanceof SourceConnectorError);
    assert.equal(error.code, "source_connector_unregistered");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("RSS connector returns the same normalized snapshot and conditional request behavior", async () => {
  const requests: Request[] = [];
  const connector = getSourceConnector("rss");
  const parsed = await connector.fetch(source, {
    fetchOptions: {
      lookup,
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(`<rss version="2.0"><channel><title>Sample</title><item><guid>one</guid><title>One</title><link>https://example.com/one</link></item></channel></rss>`, {
          headers: { "content-type": "application/rss+xml", etag: "next" },
        });
      },
    },
  });
  assert.equal(parsed.items[0]?.identityKey, "id:one");
  assert.equal(parsed.etag, "next");
  assert.equal(requests[0]?.headers.get("if-none-match"), "old");
});
