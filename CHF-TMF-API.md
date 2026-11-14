# CHF subscriber management — TM Forum Open APIs

Northbound API for a BSS/CRM to manage the people, accounts and data balances
behind the CHF. It is served by the WebUI server and aligned with the TM Forum
Open APIs below. It has **not** been run through the TMF Conformance Test Kit,
so treat it as *aligned with* the specifications, not certified against them.

| API | Resource | Purpose |
|---|---|---|
| TMF632 Party Management v4 | `individual` | users |
| TMF666 Account Management v4 | `billingAccount` | accounts |
| TMF654 Prepay Balance Management v4 | `bucket` | a SUPI's data balance and plan |
| TMF654 Prepay Balance Management v4 | `topupBalance` | adding data to a balance |
| extension to TMF654 | `simSwap` | moving a subscriber's balances to a new SIM |

## Base URL and access

```
{scheme}://{webui-host}:{port}/api/tmf-api/{apiName}/v4/{resource}
```

TMF leaves the server root to the implementation; here it is `/api`.

Authentication is the WebUI's JWT: obtain a token from `POST /api/auth/login`
and send `Authorization: Bearer <token>`. **Reads** need any WebUI account;
**writes** (POST, PATCH, DELETE) need an account with the `admin` role and
otherwise return `403`.

## Conventions (TMF630)

- Every resource carries `id`, `href` and `@type`.
- **Lists:** `?offset=` and `?limit=` (default 100, max 1000). Responses carry
  `X-Total-Count` and `X-Result-Count`, and use `206 Partial Content` when the
  page is not the whole result.
- **Projection:** `?fields=a,b` keeps those top-level attributes plus `id`,
  `href` and `@type`.
- **Filtering:** `?attribute=value` for equality, on the attributes listed per
  resource below. Anything else is a `400`, including operator syntax such as
  `?$where=` or `?attr[$ne]=`.
- **Create:** `POST` returns `201 Created` with a `Location` header.
- **Update:** `PATCH` takes a JSON Merge Patch (RFC 7386) sent as
  `application/merge-patch+json` or `application/json`. A `null` removes the
  member.
- **Delete:** `204 No Content`.
- **Read-only attributes** (such as `id`, `href`, `@type`) are rejected with
  `400` if a request sets them.
- **Errors** use the TMF Error object:

```json
{ "@type": "Error", "code": "404", "status": "404",
  "reason": "Not Found", "message": "Bucket not found" }
```

---

## TMF632 — Individual

`/api/tmf-api/partyManagement/v4/individual`

| Attribute | Notes |
|---|---|
| `givenName`, `familyName`, `fullName` | at least one required |
| `middleName`, `title`, `gender`, `birthDate`, `nationality`, ... | optional strings |
| `contactMedium`, `externalReference`, `partyCharacteristic`, ... | optional arrays, stored as sent |
| `status` | `initialized` (default), `validated`, `deceased` |
| `lastUpdate` | read-only |

Filter on: `givenName`, `familyName`, `fullName`, `status`.

Deleting an Individual that a billing account still names in `relatedParty`
returns `409`.

```http
POST /api/tmf-api/partyManagement/v4/individual
Content-Type: application/json

{ "givenName": "Amal", "familyName": "Haddad",
  "contactMedium": [{ "mediumType": "email",
    "characteristic": { "emailAddress": "amal@example.com" } }] }
```

## TMF666 — BillingAccount

`/api/tmf-api/accountManagement/v4/billingAccount`

| Attribute | Notes |
|---|---|
| `name` | required |
| `accountType` | `prepaid` (default) or `postpaid` |
| `state` | `active` (default), `suspended`, `closed` |
| `description` | optional |
| `relatedParty[]` | `{ id, role }`. Each `id` must be an existing Individual, or the request is a `400`. |
| `lastModified` | read-only |

Filter on: `name`, `state`, `accountType`, `relatedParty.id`.

Deleting an account that still has buckets charged to it returns `409`: move
or delete the buckets first.

```http
POST /api/tmf-api/accountManagement/v4/billingAccount
Content-Type: application/json

{ "name": "Haddad household", "accountType": "prepaid",
  "relatedParty": [{ "id": "<individual id>", "role": "owner" }] }
```

---

## TMF654 — Bucket

`/api/tmf-api/prepayBalanceManagement/v4/bucket/{id}`

A bucket is a data balance for a **scope**: a slice, a DNN, a home PLMN and a
roaming state. Any dimension left out is open and matches anything, so a
bucket with no scope at all covers everything the subscriber does. It is
stored as the CHF document the CHF enforces against, so changes take effect on
the subscriber's next usage report.

**Bucket ids.** A subscriber's catch-all bucket — the one with no scope — is
addressed by its SUPI, exactly as before scoped buckets existed. A scoped
bucket gets its own id (`imsi-…-<12 hex>`), returned in `id` and `href` when
you create it. List a subscriber's buckets with
`?logicalResource.id=imsi-999700000000001`.

The CHF Quota page saves through the WebUI's own REST resource,
`/api/db/ChfSubscriber`, rather than this API, and it too is addressed by
bucket id. A bucket created there without an id is given one by the same
rule. Before 2026-10-30 it was stored without one, and so could not be
edited or deleted until the WebUI restarted and its start-up migration
filled the id in.

> **Not the same rule as `charging.slices` in `chf.yaml`.** A bucket's scope
> leaves an omitted dimension *open*, so `{sst: 1}` with no SD matches any SD.
> The `charging.slices` key, which restricts **which CHF instance serves a
> slice** rather than which balance a session draws, matches SST and SD
> **exactly** — there `sst: 1` with no SD means the S-NSSAI "SST 1, no SD" and
> will not match SST 1 / SD 000001. Two different mechanisms: this one is the
> billing model, that one is 3GPP NF discovery (TS 33.518 §4.2.2.2.1).

**Which bucket a session is charged to.** The CHF takes the slice, DNN, home
PLMN and roaming state from the charging request (TS 32.291:
`networkSlicingInfo.sNSSAI`, `dnnId`, `hPlmnId`,
`userInformation.roamerInOut`), keeps the buckets whose scope covers them, and
charges the one with the **highest `priority`**. Equal priorities keep the
older bucket. A bucket that names a dimension the request does not carry is
not eligible — a "slice 1" bucket is never spent by a session whose slice is
unknown. If the subscriber is provisioned but no bucket covers the session,
the CHF treats it like an unprovisioned SUPI and applies
`charging.unprovisioned` from `chf.yaml`.

Quota is **not** metered per rating group: all usage in a session counts
against the one bucket it was matched to.

The CHF hands out a balance in slices, so a live session reports back at
least every `charging.grant.max_volume_mb` of traffic or
`charging.grant.max_validity_seconds` (50 MB or 5 minutes by default,
in `chf.yaml`), whichever comes first. A change to a bucket, including
creating one for a SUPI that is already online, therefore reaches live
sessions within that bound.

To change a plan, `PATCH` the bucket. Deleting a bucket and creating it again
also deletes this cycle's usage counter, and while the bucket is gone the SUPI
is unprovisioned (see `charging.unprovisioned` in `chf.yaml`).

It is published as `@type: ChfDataBucket`, `@baseType: Bucket`: the standard
Bucket attributes, plus the plan attributes TMF654 leaves to extensions.

| Attribute | Access | Notes |
|---|---|---|
| `logicalResource[0].id` | create only | the SUPI, `imsi-` + 15 digits |
| `scope.sNSSAI` | writable | `{ sst: 0-255, sd: "6 hex" }`; an `sst` alone covers every instance of that slice |
| `scope.dnn` | writable | e.g. `internet`. A bucket scoped to `ims`, `sos` or `mcptt` is never charged, since those DNNs are outside quota management |
| `scope.hPlmnId` | writable | `{ mcc: "999", mnc: "70" }` — the subscriber's home network |
| `scope.roaming` | writable | `home`, `inBound` or `outBound` |
| `priority` | writable | integer, higher wins; default `0` |
| `allowance` | writable | Quantity; required on create |
| `validityPeriod` | writable | `daily`, `weekly`, `monthly` (default), `custom` |
| `validitySeconds` | writable | required for `custom`; derived for the presets |
| `autoRenew` | writable | default `true` on create |
| `finalUnitAction` | writable | `TERMINATE` (default), `REDIRECT`, `RESTRICT_ACCESS` — see *Known limitations* |
| `partyAccount` | writable | `{ id }` of a billing account; `null` unlinks |
| `remainingValue` | read-only | see below |
| `consumedValue`, `topupValue` | read-only | this cycle only |
| `status` | read-only | `notStarted`, `active`, `expired` |
| `validFor` | read-only | the current cycle's start and end |

Filter on: `id` (the bucket id), `logicalResource.id` (the SUPI),
`partyAccount.id`, `scope.dnn`, `scope.roaming`, `scope.sNSSAI.sst`.

**Quantities** are `{ "amount": n, "units": u }` with units `octet`, `MB`,
`GB` or `TB`. The multiples are binary (1 GB = 2^30 octets), matching the CHF
Quota page. Responses always use `octet`.

### What `remainingValue` means

`remainingValue` is **what the CHF will grant at the subscriber's next
session**. It is computed with the same rules as the CHF's own Create path,
and the CHF Quota page uses the same function, so the two cannot disagree:

| `status` | `remainingValue` |
|---|---|
| `notStarted` (no session yet) | `allowance` |
| `active` | `allowance + topupValue − consumedValue`, never below 0 |
| `expired`, `autoRenew: true` | `allowance` — the next session opens a fresh cycle |
| `expired`, `autoRenew: false` | `0` — until a top-up |

A billing cycle starts at the subscriber's first session, or at the first
top-up if that comes first. The CHF renews or expires it lazily, on the next
session after its end. In that window `status` is `expired` and `consumedValue`
reads 0, since the old cycle's usage no longer applies.

### The usage counter is not writable

`consumedValue`, `topupValue` and the cycle dates come from the CHF's live
billing counter, which the CHF advances on every usage report. A PATCH never
writes them, only the plan attributes, and it writes only the attributes it
names. Setting a read-only attribute, or an unknown one, is a `400`, so a typo
fails instead of being ignored.

```http
POST /api/tmf-api/prepayBalanceManagement/v4/bucket
Content-Type: application/json

{ "logicalResource": [{ "id": "imsi-999700000000001" }],
  "allowance": { "amount": 10, "units": "GB" },
  "validityPeriod": "monthly", "autoRenew": true,
  "partyAccount": { "id": "<billing account id>" } }
```

A second, scoped bucket for the same subscriber — 2 GB on slice 1's `enterprise` DNN,
which outranks the 10 GB catch-all above because its priority is higher:

```http
POST /api/tmf-api/prepayBalanceManagement/v4/bucket
Content-Type: application/json

{ "logicalResource": [{ "id": "imsi-999700000000001" }],
  "allowance": { "amount": 2, "units": "GB" },
  "scope": { "sNSSAI": { "sst": 1 }, "dnn": "enterprise" },
  "priority": 50 }
```

```http
PATCH /api/tmf-api/prepayBalanceManagement/v4/bucket/imsi-999700000000001
Content-Type: application/merge-patch+json

{ "allowance": { "amount": 20, "units": "GB" } }
```

Deleting a bucket removes that allowance. When it was the subscriber's last
one, the CHF treats the subscriber as unprovisioned and applies its configured
default quota.

---

## TMF654 — TopupBalance

`/api/tmf-api/prepayBalanceManagement/v4/topupBalance`

Adds data to a bucket for the **current billing cycle**. Top-ups do not carry
over: the CHF drops them when it opens the next cycle.

| Attribute | Notes |
|---|---|
| `bucket.id` | required, the bucket id (a SUPI, or a scoped bucket's id) |
| `amount` | required, a Quantity greater than zero |
| `reason` | optional |
| `status` | read-only: `inProgress`, `completed`, `failed` |
| `reactivated` | read-only: `true` if the top-up opened a new cycle |
| `requestedDate`, `confirmationDate`, `statusReason` | read-only |

Filter on: `bucket.id`, `status`.

**How a top-up applies, by bucket state:**

| Bucket | Effect | `reactivated` |
|---|---|---|
| `active` | `topupValue` increases by `amount` | `false` |
| `notStarted` | opens the cycle now, with `amount` already in it | `true` |
| `expired` | opens a **new** cycle now, with `amount` in it | `true` |

A top-up on an expired bucket therefore reactivates it, **including on a plan
with `autoRenew: false`** — which has no other way back to service. The new
cycle includes the plan's full `allowance` as well as the top-up. If your
business rules say a lapsed non-renewing plan should receive only what was
bought, this API does not do that today.

### Retries: send an `Idempotency-Key`

A client that times out and retries a top-up would otherwise credit the
subscriber twice. Send a unique `Idempotency-Key` header (1–128 printable
ASCII characters, such as your order id) with every top-up:

```http
POST /api/tmf-api/prepayBalanceManagement/v4/topupBalance
Content-Type: application/json
Idempotency-Key: order-2026-09-17-7781

{ "bucket": { "id": "imsi-999700000000001" },
  "amount": { "amount": 1, "units": "GB" }, "reason": "bolt-on purchase" }
```

The first request returns `201`. A repeat with the same key, including
concurrent ones, returns `200` with the **original** record and credits
nothing further. This is enforced by a unique index, not just a lookup; five
concurrent requests with one key were verified to credit once.

Every attempt is recorded before the balance is touched, so failures are
audited too. Records are immutable: `PATCH` and `DELETE` return `405`.

### Reaching a session that is already up

A write here changes MongoDB, and the CHF would otherwise not see it until the
subscriber's session next reports — up to five minutes with the shipped grant
caps, and the full five for a session that is idle.

So four of these writes also queue a row in `chf.notifications`, which every
CHF polls every five seconds. Each turns it into a TS 32.291 ChargingNotify to
the live sessions it holds that draw on that bucket, or for a SIM swap to the
sessions of that SIM that draw on a bucket:

| Write | Queued | What the session does |
|---|---|---|
| `POST /topupBalance` (applied) | `REAUTHORIZATION` | reports at once and takes a fresh grant, so the top-up is usable from the next packet |
| `PATCH /bucket/{id}` | `REAUTHORIZATION` | same — the new plan is what the next grant is measured against |
| `DELETE /bucket/{id}` | `ABORT_CHARGING` | the PDU session is released; its final usage is billed and its CDR records `managementIntervention` |
| `POST /simSwap` (completed) | `ABORT_CHARGING` for the old SIM | the old SIM's PDU sessions are released; see [SimSwap](#simswap--an-extension-to-tmf654) for what happens to their last usage |
| | `REAUTHORIZATION` for the new SIM | a session the new SIM already has on the default quota reports at once, and is charged to the moved catch-all bucket from then on |

Measured end to end on the test rig: under six seconds from the API call to the
notification, then 3 ms for the round trip that fetches the new grant.

**A session that has already run out is a different case.** Everything above
assumes the session is still drawing on the bucket. One that exhausted it was
sent a FinalUnitIndication, and the open5gs SMF tears the session down on that
for every `finalUnitAction` - REDIRECT and RESTRICT_ACCESS are signalled, not
enforced - so by the time a top-up arrives there is usually no session left to
notify, and the top-up applies from the subscriber's next session. The CHF
does its part regardless: since 2026-10-29 a recharge clears the final unit on
the session's next Update, so a session still up in the window between FUI and
teardown - or one an SMF keeps up under REDIRECT or RESTRICT_ACCESS - resumes
on a normal grant. Before that fix it kept receiving FUI after the top-up.

This is **best-effort and never fails your request**. The balance change is
what counts and is already committed; the notification only decides whether the
session hears about it now or at its next report. If the queue write fails it
is logged and the response is unchanged. Delivery is at-most-once — nothing
retries — and a subscriber with no live session needs no notification, since
their next session reads the balance at Create.

**With several CHFs.** A deployment can run one CHF per slice, or per SUPI
range, all on one database, and a subscriber with sessions on two slices then
has sessions on two CHFs. Every CHF reads every row once and reaches the
sessions it holds. No CHF deletes a row on reading it: rows are deleted five
minutes after the first CHF read them, so give every CHF the same
`poll_seconds`. A CHF that has just started ignores the rows queued before it
started, since it holds no session yet and the sessions it sets up read the
balance at Create. Until 2026-11-14 the first CHF to poll deleted every row it
read, and the sessions on another CHF never heard.

There is no way to ask which sessions a given notification reached. The CHF
exposes `chf_charging_notify_sent_total` and `chf_charging_notify_failed_total`
as Prometheus counters, and that is all.

---

### Concurrency with the CHF

The CHF updates the same document while top-ups run. It adds usage on every
report and re-stamps the cycle when it renews. Each top-up write is
conditional on the cycle it read. If the CHF renewed in between, the top-up is
re-evaluated against the new cycle rather than applied to the old one. This
matters most for an expired bucket: a stale "open a new cycle" write would
otherwise erase usage the CHF had already counted on the renewed cycle. After
repeated interference the request returns `409` and can be retried.

---

## SimSwap — an extension to TMF654

`/api/tmf-api/prepayBalanceManagement/v4/simSwap`

Replaces a subscriber's SIM in the CHF. One request provisions the new SUPI
and moves everything the old one had: every bucket of the old SUPI becomes a
bucket of the new SUPI, with its plan and with what is left of it.

TMF654 has no SIM swap. This is a task resource in the TMF654 namespace,
shaped like `topupBalance`, and it names the two ends as TMF654's
TransferBalance does. It is not a TransferBalance: no amount is given, and
nothing stays behind.

| Attribute | Notes |
|---|---|
| `logicalResource.id` | required: the SUPI being replaced, `imsi-` + 15 digits |
| `receiverLogicalResource.id` | required: the SUPI replacing it. It must differ, and it must have no bucket yet |
| `reason` | optional string |
| `status` | read-only: `inProgress`, `completed`, `failed` |
| `bucket[]` | read-only: one entry per bucket in the swap, with `id` (its id on the new SIM), `formerId` (the id it had) and `href` |
| `requestedDate`, `confirmationDate`, `statusReason` | read-only |

Both ends are single objects. A bucket's `logicalResource` is an array, and
sending one here is a `400`.

Filter on: `logicalResource.id`, `receiverLogicalResource.id`, `status`.

```http
POST /api/tmf-api/prepayBalanceManagement/v4/simSwap
Content-Type: application/json
Idempotency-Key: swap-2026-11-13-0042

{ "logicalResource": { "id": "imsi-999700000000001" },
  "receiverLogicalResource": { "id": "imsi-999700000000002" },
  "reason": "lost SIM" }
```

```http
HTTP/1.1 201 Created
Location: .../prepayBalanceManagement/v4/simSwap/01a00abe-01eb-4e75-803f-6553bdb55652

{ "id": "01a00abe-01eb-4e75-803f-6553bdb55652",
  "href": ".../prepayBalanceManagement/v4/simSwap/01a00abe-01eb-4e75-803f-6553bdb55652",
  "@type": "SimSwap",
  "status": "completed",
  "requestedDate": "2026-11-13T17:52:17.386Z",
  "confirmationDate": "2026-11-13T17:52:17.391Z",
  "logicalResource": { "id": "imsi-999700000000001", "@referredType": "LogicalResource" },
  "receiverLogicalResource": { "id": "imsi-999700000000002", "@referredType": "LogicalResource" },
  "bucket": [
    { "id": "imsi-999700000000002",
      "href": ".../prepayBalanceManagement/v4/bucket/imsi-999700000000002",
      "formerId": "imsi-999700000000001", "@referredType": "Bucket" },
    { "id": "imsi-999700000000002-3f9c2a7be401",
      "href": ".../prepayBalanceManagement/v4/bucket/imsi-999700000000002-3f9c2a7be401",
      "formerId": "imsi-999700000000001-3f9c2a7be401", "@referredType": "Bucket" } ],
  "reason": "lost SIM" }
```

### What moves, and what does not

A bucket is moved, not copied. Only its SUPI and its id are rewritten, so
these arrive unchanged:

- the plan: `allowance`, `validityPeriod`, `autoRenew`, `finalUnitAction`
- `scope` and `priority`
- the `partyAccount` link to a billing account
- this cycle's counter: `consumedValue`, `topupValue` and the cycle dates

`remainingValue` on the new SIM is therefore what it was on the old one, and
the cycle does not restart.

**Bucket ids change**, because a bucket's id starts with its SUPI. The
catch-all bucket's id is the SUPI itself, so it becomes the new SUPI. A scoped
bucket keeps its suffix: `imsi-999700000000001-3f9c2a7be401` becomes
`imsi-999700000000002-3f9c2a7be401`. The swap record lists both ids for every
bucket. After the swap the old ids are `404`.

What a swap does **not** touch:

- **The subscriber database.** The new SIM's keys, slices and sessions are
  provisioned in the WebUI's Subscriber page as for any SIM, and the new SIM
  cannot register without them. This API only moves what the CHF charges
  against.
- **The old SUPI's entry in the subscriber database.** The old SUPI has no
  bucket afterwards, so the CHF treats it as unprovisioned: it gets
  `charging.default_quota`, or is refused under `unprovisioned: reject`. To
  stop the old SIM being used at all, remove it from the subscriber database.
- **TopupBalance records.** They are an audit trail and keep the bucket id
  they were made against. `GET /topupBalance?bucket.id=` with a new id finds
  only top-ups made after the swap; use `formerId` for the earlier ones.
- **Individuals and billing accounts.** A bucket's link to its billing
  account moves with it.

### Responses

| Status | When |
|---|---|
| `201` | swapped. `Location` is the swap record |
| `200` | a repeat of a request with the same `Idempotency-Key`: the original record, and nothing is moved again |
| `400` | a SUPI is missing or is not `imsi-` + 15 digits, the two are the same, a read-only attribute is set, or the `Idempotency-Key` is malformed |
| `403` | the account does not have the `admin` role |
| `404` | the old SIM has no bucket |
| `409` | the new SIM already has a bucket; or another swap involving either SIM is running; or a bucket changed while the swap ran |
| `500` | a swap failed part-way and a bucket could not be put back. The record's `statusReason` names it |
| `405` | `PATCH`, `PUT` or `DELETE` on a swap record. Records are immutable |

Every well-formed request is recorded before a bucket is touched, so a `404`
and a `409` leave a record with `status: failed` and a `statusReason`. The one
exception is a request refused because another swap holds one of its SIMs: it
leaves no record.

**Never a merge.** If the new SIM already has a bucket, the swap is refused.
Two plans cannot be added up without deciding whose cycle and whose usage
survive, and that is the caller's decision. Delete the new SIM's bucket first
if it should be replaced.

### All or nothing

A subscriber can have several buckets, and a standalone MongoDB has no
multi-document transaction. The swap gets the same result by hand:

- Each bucket is moved by its own write, which only matches if the bucket is
  still the old SIM's. If one does not match, or the new SIM was given a
  bucket in the meantime, the buckets already moved are put back and the
  request fails with `409` and "nothing was moved". It can be retried.
- While a swap runs, its record holds both SIMs under a unique index. A
  second swap that names either of them, as the old SIM or the new one, gets
  `409` until the first has ended. Two swaps of one SIM to two different new
  SIMs therefore cannot each take some of its buckets.
- The CHF adds usage to a bucket while it is being moved. Each move writes
  only the SUPI and the id, so a usage report that lands at the same moment is
  kept.

### Retries: send an `Idempotency-Key`

As for a top-up, send a unique `Idempotency-Key` header (1–128 printable ASCII
characters). The first request returns `201`. A repeat with the same key,
including a concurrent one, returns `200` with the original record and moves
nothing.

The key stands for the request, whatever came of it:

- A repeat of a swap that **failed** returns the failed record, and the swap
  is not tried again even if its cause is gone. Check `status`, and use a new
  key for a new attempt.
- A repeat that arrives while the first is **still running** returns the
  record as `inProgress`. Read it again.
- Without a key, a repeat of a completed swap is a `404`, since the old SIM
  has nothing left to move. It is never mistaken for a second swap.

### If the server stops in the middle of a swap

The record was written first, with the id every bucket had and the id it was
to get, so the swap can be undone from the record alone. A swap still
`inProgress` a minute after it started is taken to be interrupted. The next
request that meets it undoes it: the buckets it had moved are put back with
the old SIM, and its record becomes `failed` with "Interrupted; its buckets
were put back".

Two kinds of request do this: a retry with the interrupted swap's
`Idempotency-Key`, which then returns the failed record, and any new swap
that names either SIM, which then goes ahead. Only one request undoes a given
swap, and both SIMs stay held until it has finished. Until such a request
arrives, the buckets stay where the interrupted swap left them, some with
each SIM, and each SIM is charged against the ones it holds. Nothing is lost
or counted twice in that state, but it is not a state to leave: retry.

### Sessions that are up during a swap

- **The old SIM's sessions are released.** They are sent `ABORT_CHARGING`
  within the CHF's five-second poll, as when a bucket is deleted.
- **Their last usage is recorded but not deducted.** What an old session
  reports after the swap, including its final report when it is released, is
  in its CDR but is not taken from the moved balance, because the bucket is no
  longer under the id the session was charging. That is at most one grant per
  session, 50 MB as shipped. Swap a SIM that is not in use if the balance has
  to be exact.
- **The new SIM is re-authorised**, in case it is already up on the default
  quota. Such a session reports at once and is charged from then on to the
  moved catch-all bucket, the one whose id is the new SUPI. A scoped bucket
  it would match, such as one for its DNN, applies from its next session,
  because the CHF chooses among scoped buckets only at Create. The new SIM's
  sessions set up after the swap are charged to the moved buckets as usual.
- Sessions on `ims`, `sos` and `mcptt` draw on no bucket and are left alone.

As for every write here, the notifications are best-effort and never fail the
request. A swap that did not complete queues none.

### What was checked

The rules above are covered by 19 tests on in-memory repositories and 7 on a
real MongoDB, which include concurrent requests with one key, two swaps that
share a SIM, and interrupted swaps. On 2026-11-13 a swap was also run end to
end against a CHF and MongoDB on one machine, with requests in place of the
SMF: a bucket with 1 GB, a 200 MB top-up and 30 MB used arrived on the new SIM
with all three, the old SIM's session was sent `ABORT_CHARGING`, 15 MB it
reported afterwards appeared in its CDR and not in the balance, the new SIM's
first session was granted from the moved balance, and the old SIM got the
default quota. In a second run a session the new SIM already had on the
default quota was sent `REAUTHORIZATION`, and its next report was counted to
the moved catch-all bucket.

The same day it ran on the test rig, with a UERANSIM UE and the real SMF. With
the UE's two sessions up, its three buckets were moved to another SUPI with
their counters, and the SMF released both sessions on `ABORT_CHARGING`. The UE
set them up again at once on the default quota. Swapping the buckets back
moved those two sessions to the catch-all on `REAUTHORIZATION`. The 6.3 MB the
released sessions reported after the swap was in their CDRs and not in the
balance.

---

## Known limitations

- **Not certified.** Resource shapes and REST conventions follow TMF630, 632,
  654 and 666, but no TMF CTK run has been done. Only the attributes documented
  here are supported; other TMF attributes are rejected or ignored as noted.
- **`finalUnitAction` is not enforced end to end.** The CHF signals the chosen
  action, but the SMF currently tears the session down for all three values.
  `REDIRECT` and `RESTRICT_ACCESS` behave as `TERMINATE`.
- **Not all errors are TMF-shaped.** A missing or invalid token is rejected by
  the authentication layer with a plain `401`. A malformed `application/json`
  body is rejected by the WebUI's global parser before reaching this API.
  Malformed `application/merge-patch+json` bodies do return a TMF Error.
- **Last write wins** on Individual and BillingAccount PATCH; there are no
  ETags. Buckets are unaffected, since each attribute is set individually.
- **Only IMSI subscribers can be provisioned.** A bucket's SUPI must be `imsi-` plus 15
  digits. The CHF itself accepts any well-formed SUPI, so a subscriber with another kind,
  such as an NAI, always gets `charging.default_quota`, or is refused under
  `unprovisioned: reject`.
- **A SIM swap does not wait for the old SIM's sessions.** Usage they report
  after the swap is in their CDRs but is not deducted from the moved balance:
  at most one grant per session. The swap also moves balances only. The new
  SIM still has to be added to the subscriber database, and the old one
  removed from it.
- **No event notifications** (TMF `hub` / listener callbacks). A BSS learns
  about exhaustion by polling. The `chf.notifications` queue described above
  runs the other way — this API telling the CHF — and is not a TMF hub.
