# Source ingestion

Source ingestion is an optional part of the long running `serve-feishu` process. It reads a local YAML file at startup, selects a connector from the explicit source registry, polls public RSS 2.0, Atom and GitHub Trending pages, and stores bounded item metadata in the same SQLite state database used by Feishu conversations. The registry currently contains `rss` and `github_trending`; WeChat, Newsletter and arXiv connectors remain planned follow-up changes.

## Configuration

Set `KNOWLEDGE_RADAR_FEEDS_CONFIG` to a YAML file. The file is read only once at startup; restart the service after editing it.

```yaml
timezone: Asia/Shanghai
pollIntervalMinutes: 30
digest:
  enabled: true
  time: "09:00"
  maxItems: 20
sources:
  - id: example-blog
    name: Example blog
    kind: rss
    url: https://example.com/feed.xml
    enabled: true
    priority: 0
    tags: [engineering]
    itemLimit: 100
  - id: github-weekly
    name: GitHub Trending weekly
    kind: github_trending
    url: https://github.com/trending
    connectorConfig:
      period: weekly
      language: all
    enabled: true
    priority: 10
    tags: [github, trends]
    itemLimit: 20
```

Digest delivery cadence is configured separately from the connector's trend window. The following schedules keep blog articles daily, send the GitHub snapshot every Monday, and aggregate the preceding four weeks every fourth Monday:

```yaml
digest:
  enabled: true
  schedules:
    - id: blogs-daily
      mode: new_items
      frequency: daily
      time: "09:00"
      maxItems: 20
      sourceIds: [example-blog]
    - id: github-weekly
      mode: trend_snapshot
      frequency: weekly
      weekday: 1 # ISO Monday
      time: "09:00"
      maxItems: 20
      sourceIds: [github-weekly]
    - id: github-four-week
      mode: period_summary
      frequency: every_n_weeks
      anchorDate: "2026-09-28"
      intervalWeeks: 4
      time: "09:30"
      maxItems: 50
      sourceScheduleId: github-weekly
      sourceIds: []
```

`connectorConfig.period: weekly` controls which GitHub Trending page is polled. `frequency: weekly` controls when the Feishu snapshot is sent. The four-week schedule reads successful frozen weekly snapshots, so it can include repositories that were already sent in a weekly card. The first successful poll is still a baseline and is never sent as a new-item digest.

`id` values must be unique. URLs must use `http` or `https` and cannot contain credentials. Feed URLs that resolve to loopback, private, link local, carrier grade NAT, or cloud metadata addresses are rejected. Authentication, cookies, and protected feeds are intentionally outside this change.

`sources` is the canonical configuration entry. Each source has a stable ID, display name, `kind`, enabled state, priority, tags and an item limit. Connector specific options live in `connectorConfig`. RSS accepts an empty object. `github_trending` only accepts the public HTTPS URL `https://github.com/trending`, `period` (`daily`, `weekly` or `monthly`, default `weekly`) and one `language` slug or `all`. It does not use GitHub credentials or private repositories. Do not put tokens in URLs or source configuration.

Existing files may keep the `feeds` entry. It is normalized to `kind: rss` with an empty connector configuration. A file must use either `sources` or `feeds`, never both. Unknown kinds fail startup instead of falling back to RSS.

GitHub Trending uses the public HTML page and does not authenticate. A `feed_http_error`, `feed_unavailable` or `feed_timeout` entry means the public request was unavailable and will follow the normal retry policy. A `feed_parse_failed` entry means the checked page no longer contains the expected repository rows; inspect the fixture parser tests before changing selectors. A `feed_redirect_limit` entry means the final host was not GitHub Trending. The connector never logs response HTML, credentials or response bodies.

For Compose, set `KNOWLEDGE_RADAR_FEEDS_CONFIG_HOST` in `.env` and add the read only overlay:

```powershell
docker compose -f compose.feishu.yaml -f compose.feishu.capture.yaml -f compose.feeds.yaml up -d --build
```

Omit `compose.feeds.yaml` to keep the existing Feishu only service behavior.

## Polling behavior

The first successful response creates a baseline. Existing entries are stored as `baseline`; entries discovered in later successful polls are stored as `candidate`. Feed IDs, GUIDs, normalized URLs, and a bounded fallback hash provide stable identity. Repeated polls update display metadata without changing `first_seen_at` or inserting duplicates.

Polling creates durable `feed_poll` jobs. Jobs have an idempotency key, lease, retry limit, and token fencing. Network, HTTP, redirect, size, timeout, and parse failures update only that source and are retried when safe. Scheduler callbacks only enqueue jobs; network access runs in the feed worker. A restart recovers expired leases and schedules overdue sources.

When `digest.enabled` is true, the same service creates one `feed_digest` Job for each due schedule after the configured local time. `new_items` schedules select unnotified candidates; `trend_snapshot` schedules select the latest successful source snapshot even when an item was already notified; `period_summary` schedules aggregate the referenced schedule's successful snapshots. Each schedule has its own period key and idempotency key, so independent schedules can run on the same day. The first successful poll remains the baseline and is never sent as a new-item digest. Feed summaries are used as-is; this stage does not fetch article bodies or call a model. Jobs created by an older version that contain only `text` continue to send text.

The bot needs the Feishu permission `im:message:send_as_bot`. Digest jobs use the existing SQLite lease, retry and token fencing rules. A successful send marks the selected candidates as notified; a temporary send failure keeps them pending for retry.

Each sent Card 2.0 is stored with its message ID and item IDs. The star button writes a scoped interest state for the article. A repeated delivery of the same `event_id` is ignored; a later event sets the requested target state, so two clicks toggle the star. The callback requires the Card Callback setting in the Feishu Developer Console; the WS dispatcher receives `card.action.trigger` after that setting is enabled. See [飞书接入与故障排查](feishu.md#摘要卡片交互). The stored card is bounded to the Feishu 20,000-byte limit and is used to return the updated card without rebuilding article content.

## Card themes

Digest cards resolve a visual theme from `sourceKind`, with the legacy connector provider used as a fallback for older rows. The theme is presentation-only; it does not change digest ordering, source filtering, callback payloads or notification state.

| Source kind | Header color | Section label |
| --- | --- | --- |
| `rss` | turquoise | `📰 博客` |
| `github_trending` | indigo | `◈ GitHub 热点` |
| `github_release` | purple | `◈ GitHub Releases` |
| `arxiv` | violet | `⌁ arXiv` |
| `newsletter` | orange | `✉ Newsletter` |
| `wechat` | green | `◎ 公众号` |
| unknown or missing | grey | `• 其他来源` |

When a card contains more than one source theme, the header uses the neutral blue template and each article group keeps its own light background. Connector authors should add a `SourceCardTheme` entry and a focused resolver test before introducing a new `sourceKind`; existing `digest_interest` behavior must remain unchanged.

## Manual preview

Preview the current unnotified candidates without creating a `feed_digest` Job or changing `notified_at` or feed poll state:

```powershell
node --env-file=.env --import tsx src/cli.ts preview-feed-digest
```

The command prints `{"outcome":"sent","messageId":"..."}` after the Card 2.0 message is accepted, or `{"outcome":"empty"}` when there are no candidates. It uses `FEISHU_ALLOWED_OPEN_ID` and therefore requires the bot's proactive message permission. A send failure prints a safe error code and leaves the candidates available for the next preview or daily job.

## State and rollback

Opening the state database migrates schema v7 to v8 in one transaction. The migration adds bounded `feed_items.metadata_json` with `{}` as the value for existing RSS rows; existing conversations, turns, jobs, feed polls, outbox rows, feedback records and feed items remain intact. Back up the SQLite database before deployment. To roll back, stop the service, restore the v7 database and the previous application image together. An older application must not open a v8 database. Keep the backup outside the state volume until the new image has passed polling, digest and card callback checks.

## Verification

```powershell
npm test
npm run check
npm run build
openspec validate add-github-trending-source --strict
node --env-file=.env --import tsx src/cli.ts preview-feed-digest
```

The focused callback test is deterministic and does not contact Feishu:

```powershell
npx tsx --test src/runtime/feishu-service.test.ts src/channels/feishu/adapter.test.ts
```

The GitHub connector tests use checked-in daily, weekly and monthly HTML fixtures and never contact GitHub:

```powershell
npx tsx --test src/feed/github-trending.test.ts src/feed/source-e2e.test.ts
```

It covers the real SDK WebSocket ACK path, scoped message lookup, same-event replay, two-event star toggling, invalid actions, and safe logs. For a manual check, send the preview, click one star twice, restart the service, and click it again. The first click should show a filled star, the second an outlined star, and the restarted service should preserve the current state. Before trying a rollback, stop the service and copy the SQLite file; restore that backup together with the previous image because the v8 schema is rejected by older code.

Validate the Compose feed overlay without injecting credentials or starting a container:

```powershell
$env:RADAR_ENV_FILE = '.env.example'
$env:KNOWLEDGE_RADAR_FEEDS_CONFIG_HOST = 'feeds.yaml'
docker compose -f compose.feishu.yaml -f compose.feeds.yaml config --quiet
```
