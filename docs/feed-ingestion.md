# RSS / Atom ingestion

Feed ingestion is an optional part of the long running `serve-feishu` process. It reads a local YAML file at startup, polls public RSS 2.0 and Atom URLs, and stores bounded item metadata in the same SQLite state database used by Feishu conversations.

## Configuration

Set `KNOWLEDGE_RADAR_FEEDS_CONFIG` to a YAML file. The file is read only once at startup; restart the service after editing it.

```yaml
timezone: Asia/Shanghai
pollIntervalMinutes: 30
digest:
  enabled: true
  time: "09:00"
  maxItems: 20
feeds:
  - id: example-blog
    name: Example blog
    url: https://example.com/feed.xml
    enabled: true
    priority: 0
    tags: [engineering]
    itemLimit: 100
```

`id` values must be unique. URLs must use `http` or `https` and cannot contain credentials. Feed URLs that resolve to loopback, private, link local, carrier grade NAT, or cloud metadata addresses are rejected. Authentication, cookies, and protected feeds are intentionally outside this change.

For Compose, set `KNOWLEDGE_RADAR_FEEDS_CONFIG_HOST` in `.env` and add the read only overlay:

```powershell
docker compose -f compose.feishu.yaml -f compose.feishu.capture.yaml -f compose.feeds.yaml up -d --build
```

Omit `compose.feeds.yaml` to keep the existing Feishu only service behavior.

## Polling behavior

The first successful response creates a baseline. Existing entries are stored as `baseline`; entries discovered in later successful polls are stored as `candidate`. Feed IDs, GUIDs, normalized URLs, and a bounded fallback hash provide stable identity. Repeated polls update display metadata without changing `first_seen_at` or inserting duplicates.

Polling creates durable `feed_poll` jobs. Jobs have an idempotency key, lease, retry limit, and token fencing. Network, HTTP, redirect, size, timeout, and parse failures update only that source and are retried when safe. Scheduler callbacks only enqueue jobs; network access runs in the feed worker. A restart recovers expired leases and schedules overdue sources.

When `digest.enabled` is true, the same service creates one daily `feed_digest` Job after the configured local time. It selects unnotified candidates, deduplicates the same canonical URL across feeds, and sends a bounded plain-text message to `FEISHU_ALLOWED_OPEN_ID`. The first successful poll remains the baseline and is never sent. Feed summaries are used as-is; this stage does not fetch article bodies or call a model.

The bot needs the Feishu permission `im:message:send_as_bot`. Digest jobs use the existing SQLite lease, retry and token fencing rules. A successful send marks the selected candidates as notified; a temporary send failure keeps them pending for retry.

## State and rollback

Opening the state database migrates schema v4 to v5 in one transaction. The migration adds candidate notification state and indexes while preserving conversations, turns, jobs, feed polls and outbox rows. Back up the SQLite database before deployment. To roll back, stop the service, restore the v4 database and the previous application image together. An older application must not open a v5 database.

## Verification

```powershell
npm test
npm run check
npm run build
openspec validate add-feed-ingestion --strict
```
