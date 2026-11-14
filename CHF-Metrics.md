# CHF Metrics Reference

Every Prometheus metric the CHF exposes: what it counts, its labels and their
values, and how to use them. There are 26 families from the CHF, plus one from the
WebUI. The definitions are in `src/chf/metrics.c`, and the provisioning one is in
`webui/server/metrics.js`.

## Scraping

**CHF:** set in `chf.yaml`, and served at `/metrics`. The shipped config uses:

```yaml
chf:
  metrics:
    server:
      - address: 127.0.0.30
        port: 9090
```

**WebUI:** `GET /metrics` on the WebUI server, without authentication. It needs the
optional `prom-client` package (`npm install prom-client` in `webui/`). Without it,
`/metrics` returns a hint and nothing is counted. With it, the WebUI also exposes
Node's standard process metrics, prefixed `chf_webui_`.

## Conventions

- **Durations are in milliseconds and volumes in kilobytes.** `ogs_metrics` takes an
  `int` per call, so smaller units would overflow on multi-GB grants. A threshold on
  a duration is written `> 250`, not `> 0.25`.
- **Histograms** all use the buckets 1, 4, 16, 64, 256, 1024, 4096 and 16384 ms.
- **Labeled series appear on first use.** `chf_cdr_written_total{result="error"}`
  does not exist until a write has failed, so alert with `increase()` and expect the
  series to be absent when things are healthy.
- **Labels are bounded by design.** Nothing is labeled by SUPI, `chargingDataRef` or
  rating group. Per-subscriber accounting lives in MongoDB.
- **Series cap:** at most 1,024 labeled series (`CHF_METR_MAX_LABELED_INSTANCES`), the
  figure upstream's `OGS_METRICS_MAX_SERIES_PER_HASH` also uses, though here it covers
  all families together rather than one table.
  Beyond that, new label combinations are not recorded and the CHF logs one warning,
  which usually means an unbounded `dnn` or `smf` value. Label values are cut to 63
  characters.
- **Counters restart from zero** when the CHF restarts.

## Metrics

### Requests

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `chf_sbi_requests_total` | Counter | `operation`, `result` | Nchf requests handled |
| `chf_sbi_request_duration_milliseconds` | Histogram | `operation` | Handling time per request |
| `chf_sbi_inflight` | Gauge | | Requests being processed now |

`operation` is `create`, `update` or `release`. `result` is `success` or `failure`:
whether the handler succeeded, not an HTTP status class.

### Sessions

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `chf_sessions_active` | Gauge | | Sessions held in memory |
| `chf_session_create_total` | Counter | `result`, `dnn`, `smf` | Create outcomes: `success` or `reject` |
| `chf_session_update_total` | Counter | `result` | Update outcomes: `success`, or `reject` for a body that did not parse |
| `chf_session_release_total` | Counter | `cause` | Releases: `normal`, or `volume_limit` once a final unit was issued |

The `smf` label is the SMF's `nFFqdn`, else `nFIPv4Address`, else `nFIPv6Address`,
else `nFName`, and is empty if the SMF sends none of them. Under Kubernetes a pod IP
can change on reschedule, so give the SMF an FQDN there.

### Quota

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `chf_quota_lookup_total` | Counter | `source` | Where a Create's quota came from: `db`, `default`, or `exempt` for a well-known DNN |
| `chf_quota_bucket_selected_total` | Counter | `kind`, `slice` | Which allowance a session was charged to |
| `chf_quota_granted_kilobytes_total` | Counter | | Volume granted |
| `chf_quota_used_kilobytes_total` | Counter | | Usage reported on quota-managed sessions, uplink and downlink together |
| `chf_quota_exhausted_total` | Counter | `scope`, `dnn` | Exhaustion events: `per_session` or `aggregate` |
| `chf_quota_final_unit_total` | Counter | `action` | Final units issued: `terminate`, `redirect` or `restrict` |
| `chf_quota_auto_renew_total` | Counter | | Rollovers when a billing period ended |

`kind` is `scoped`, `catchall` or `default`. `slice` is `<sst>/<sd>` such as
`1/000001`, just `<sst>` when there is no SD, or `none`. A refused establishment is
counted too, so with a UE retrying against an empty bucket this rises well above
the number of sessions that came up.

**Well-known DNNs** (`ims`, `sos`, `mcptt`) are outside quota management, so a session on
one counts as `source="exempt"` and appears in no other quota metric: not bucket selection,
volumes, exhaustion or final units. It still counts in the session and request metrics
(`chf_session_create_total{dnn="ims"}`), and in the CDR metrics unless
`charging.well_known_dnn.cdr` is off.

### ChargingNotify

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `chf_charging_notify_sent_total` | Counter | | Requests handed to the HTTP client for an SMF |
| `chf_charging_notify_failed_total` | Counter | | Ones that could not be sent, or that the SMF refused or did not answer |

These answer "I topped up and nothing happened": did the notification go out, and
was it taken? A request the SMF refuses counts in both, so `sent` alone does not mean
delivered. They are deliberately unlabeled, because the `notifyUri` comes from
the peer and is unbounded. Look in the CHF log for which session it was. A subscriber
with nothing live needs no notification and is not counted as a failure.

### CDRs

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `chf_cdr_written_total` | Counter | `result` | One per record, whatever the encodings: `success` only if every selected encoding wrote it, else `error` |
| `chf_cdr_encoded_total` | Counter | `format`, `result` | One per record per encoding |
| `chf_cdr_file_rolled_total` | Counter | `format`, `reason` | Aggregated files rolled, by `records`, `size` or `day` |
| `chf_cdr_bytes_total` | Counter | | Bytes written, summed across encodings |
| `chf_cdr_write_duration_milliseconds` | Histogram | | Time to write a record (this is synchronous disk I/O) |

`format` is `json` or `asn1`.

### Database

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `chf_db_ops_total` | Counter | `collection`, `op`, `result` | MongoDB calls: `ok` or `error` |
| `chf_db_op_duration_milliseconds` | Histogram | `collection`, `op` | Call latency |
| `chf_db_unavailable_total` | Counter | | Lookups made with no MongoDB collection available |

| `collection` | `op` |
|---|---|
| `subscribers` | `find`, `inc_usage`, `open_usage`, `reset_usage` |
| `sessions` | `insert`, `update`, `delete` |
| `cdrs` | `insert` |
| `notifications` | `find`; `mark`, which records that this CHF has read the rows; `skip`, the same for the rows queued before it started; `delete`, of rows read five minutes ago |

### Provisioning

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `chf_provisioned_subscribers` | Gauge | | Documents in `chf.subscribers`, so buckets rather than people. Refreshed at most every 30 s, and only by Create traffic |
| `chf_provisioning_ops_total` | Counter | `op`, `result` | **From the WebUI.** Changes through `/api/db/ChfSubscriber`: `create`, `update` or `delete`, with `success` or `error` |

### Errors

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `chf_errors_total` | Counter | `kind` | Errors by kind |

| `kind` | Meaning |
|---|---|
| `parse` | A request's ChargingDataRequest did not parse |
| `no_supi` | A Create that parsed but named no subscriber |
| `bad_supi` | A Create whose SUPI is malformed: `ogs_supi_is_valid()`, the check every NF uses |
| `bad_psi` | A Create whose `pduSessionID` is outside 1..255 |
| `bad_sst` | A Create whose `sst` is outside 0..255 |
| `session_add` | A session could not be allocated: the session pool (`max.ue` × 4) is full, and the Create got 500 `INSUFFICIENT_RESOURCES` |
| `cdr` | A record was not written in every selected encoding |

## Alerts and dashboards

| Question | Query |
|---|---|
| Are requests failing? | `rate(chf_sbi_requests_total{result="failure"}[5m])` |
| Is MongoDB stalling the event loop? | `histogram_quantile(0.99, rate(chf_db_op_duration_milliseconds_bucket[5m])) > 250` |
| Are CDRs being lost? | `increase(chf_cdr_written_total{result="error"}[15m]) > 0` |
| Is one encoding failing while the other works? | `increase(chf_cdr_encoded_total{result="error"}[15m]) > 0` |
| Are top-ups reaching sessions? | `increase(chf_charging_notify_failed_total[15m]) > 0` |
| Is per-slice charging happening? | `sum by (kind) (increase(chf_quota_bucket_selected_total[1h]))` |
| Are aggregation thresholds tuned? | `sum by (reason) (increase(chf_cdr_file_rolled_total[1h]))` |
| Is anything unusual going on? | `sum by (kind) (increase(chf_errors_total[15m]))` |

How to read a few of those:

- **Encodings:** with `format: both`, `chf_cdr_encoded_total` should be exactly twice
  `chf_cdr_written_total`. If the ratio drifts, one encoding is failing.
- **Slices:** if you provisioned scoped buckets but `catchall` dominates, a bucket's
  scope probably names something the charging request does not carry.
- **Aggregation:** rolls almost entirely under one `reason` mean the other threshold
  never fires.
- **Refusals:** a refused UE that keeps retrying raises the
  `chf_quota_bucket_selected_total` rate without any traffic. This is enforcement
  working, not a fault.

## Example

From the rig on 2026-11-01, after one UE exhausted two slice buckets:

```
chf_sessions_active 0
chf_quota_exhausted_total{scope="per_session",dnn="internet"} 2
chf_cdr_written_total{result="success"} 2
chf_cdr_encoded_total{format="json",result="success"} 2
chf_cdr_encoded_total{format="asn1",result="success"} 2
chf_quota_bucket_selected_total{kind="scoped",slice="1/000001"} 199
chf_quota_bucket_selected_total{kind="scoped",slice="1/000002"} 109
```

The two bucket counters read 199 and 109 rather than 1 each because of the refused
retries. Nothing appears under `catchall`, which is the point of per-slice buckets.

## Adding a metric

Add it to the enum in `src/chf/metrics.h` and its spec in `src/chf/metrics.c`. The
spec tables are sized by the enum, so a forgotten spec would leave a nameless row.
`METR-1` in `tests/chf/chf-metrics-test.c` fails if that happens. Keep labels
bounded, and add the metric to this document.

`chf_session_duration_seconds` was considered and left out on purpose: it would add
a histogram the CDRs already answer.
