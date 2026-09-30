## Purpose

为不同来源提供可预测、可恢复且互不阻塞的摘要通知周期，并保存足够的历史快照来生成四周汇总，避免把榜单窗口误当成发送频率。

## ADDED Requirements

### Requirement: Digest schedules SHALL define an explicit cadence and source scope

The feed configuration SHALL accept `digest.schedules`. Each schedule SHALL have a stable `id`, a `mode`, a `frequency`, a local `time`, a positive `maxItems`, and a non-empty list of configured source IDs unless it references another schedule for a period summary. `frequency` SHALL support `daily`, `weekly`, and `every_n_weeks`. A weekly schedule SHALL declare an ISO weekday from 1 to 7. An every-n-weeks schedule SHALL declare an ISO `anchorDate` and a positive `intervalWeeks`; the four-week GitHub schedule SHALL use `intervalWeeks: 4`. A schedule ID SHALL be unique within one configuration.

#### Scenario: GitHub weekly and four-week schedules are accepted

- **WHEN** the configuration declares a weekly GitHub trend schedule and an every-four-weeks summary schedule anchored on that schedule
- **THEN** the configuration SHALL load successfully, and the connector's `connectorConfig.period` SHALL remain independent from the notification frequency

#### Scenario: Invalid schedule references are rejected

- **WHEN** a schedule references an unknown source, duplicates another schedule ID, uses an invalid weekday, or omits the anchor required by `every_n_weeks`
- **THEN** startup configuration validation SHALL fail with a safe configuration error before any poll or send job is created

#### Scenario: Existing daily configuration remains compatible

- **WHEN** `digest.schedules` is absent and the existing `digest.enabled`, `digest.time`, and `digest.maxItems` fields are present
- **THEN** the system SHALL normalize them to one `default-daily` new-item schedule covering all enabled sources

### Requirement: Schedule due checks SHALL be timezone-aware and independently idempotent

The scheduler SHALL calculate the current local date and time using the global feed timezone. A due schedule SHALL create at most one job for its schedule and period key. The idempotency key SHALL include the Feishu scope, schedule ID, and period key. A pending or running job for one schedule SHALL NOT prevent a different schedule from being created on the same day. If the service starts after a schedule's send time, it SHALL create the current due period once; it SHALL NOT create an unbounded backlog of missed periods.

#### Scenario: Weekly GitHub report is created once

- **WHEN** the service reaches or passes the configured Monday send time during a new weekly period
- **THEN** exactly one GitHub weekly job SHALL be created for that period, and repeated scheduler passes or restarts SHALL not create another job

#### Scenario: Daily RSS and weekly GitHub schedules coexist

- **WHEN** both schedules are due on the same local date
- **THEN** each schedule SHALL have its own job and one schedule's pending, running, or failed state SHALL not suppress the other schedule

#### Scenario: A temporary send failure is retried safely

- **WHEN** a scheduled job fails with a retryable Feishu error
- **THEN** the same job and idempotency key SHALL be retried, and a second message SHALL not be created for the same successful attempt

### Requirement: Trend snapshot schedules SHALL report the current ranked source snapshot

A schedule with `mode: trend_snapshot` SHALL select the latest successfully polled items for its configured GitHub Trending sources by rank, regardless of whether those items were previously marked `notified`. The scheduled job SHALL freeze the bounded item data, source metadata, period key, and item IDs before sending. The same repository MAY appear in multiple weekly snapshots.

#### Scenario: Weekly GitHub report repeats a continuing repository

- **WHEN** a repository remains in the latest GitHub weekly snapshot after it was included in an earlier weekly report
- **THEN** the new weekly report SHALL be allowed to include it again with its latest rank and trend metadata

#### Scenario: No successful snapshot is available

- **WHEN** a trend snapshot schedule is due but none of its sources has a successful snapshot
- **THEN** the scheduler SHALL leave the period without a send job and SHALL log a safe empty outcome

### Requirement: Period summary schedules SHALL aggregate successful snapshots from their source schedule

A schedule with `mode: period_summary` SHALL reference a trend snapshot schedule and SHALL aggregate successful frozen snapshots whose period ends fall inside the immediately preceding `intervalWeeks` window anchored by the configured schedule. It SHALL deduplicate repositories by canonical URL, retain the most recent bounded metadata for each repository, and MAY include items already sent by the weekly schedule. The summary SHALL have its own period key and idempotency key.

#### Scenario: Four-week summary includes weekly history

- **WHEN** the four-week schedule becomes due after four completed weekly periods
- **THEN** it SHALL produce one summary from those successful weekly snapshots, deduplicated by canonical repository URL, even when every repository was already sent in a weekly report

#### Scenario: Incomplete history is available

- **WHEN** fewer than four successful weekly snapshots exist in the four-week window
- **THEN** the summary SHALL use the available snapshots, mark its period in the job payload, and SHALL not fabricate missing weeks

#### Scenario: Repeated summary scheduling is idempotent

- **WHEN** the service restarts during or after a four-week summary send
- **THEN** the same period SHALL resolve to the existing job or succeeded result and SHALL not send a duplicate summary

### Requirement: Scheduled cards SHALL identify their report period without changing feedback semantics

The digest text fallback and Feishu Card 2.0 header SHALL identify the schedule mode and period. Existing `digest_interest` buttons SHALL continue to use the frozen item IDs in the scheduled payload, and their toggle behavior SHALL remain unchanged for weekly and four-week cards.

#### Scenario: User receives distinct weekly and four-week cards

- **WHEN** a weekly GitHub job and a four-week summary job are sent
- **THEN** their card headers and text fallbacks SHALL distinguish the two periods while retaining article links and interest buttons
