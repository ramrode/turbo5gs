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
| `scope.dnn` | writable | e.g. `internet`, `ims` |
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

A second, scoped bucket for the same subscriber — 2 GB on slice 1's IMS DNN,
which outranks the 10 GB catch-all above because its priority is higher:

```http
POST /api/tmf-api/prepayBalanceManagement/v4/bucket
Content-Type: application/json

{ "logicalResource": [{ "id": "imsi-999700000000001" }],
  "allowance": { "amount": 2, "units": "GB" },
  "scope": { "sNSSAI": { "sst": 1 }, "dnn": "ims" },
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

So three of these writes also queue a row in `chf.notifications`, which the CHF
polls every five seconds and turns into a TS 32.291 ChargingNotify to every
live session drawing on that bucket:

| Write | Queued | What the session does |
|---|---|---|
| `POST /topupBalance` (applied) | `REAUTHORIZATION` | reports at once and takes a fresh grant, so the top-up is usable from the next packet |
| `PATCH /bucket/{id}` | `REAUTHORIZATION` | same — the new plan is what the next grant is measured against |
| `DELETE /bucket/{id}` | `ABORT_CHARGING` | the PDU session is released; its final usage is billed and its CDR records `managementIntervention` |

Measured end to end on the test rig: under six seconds from the API call to the
notification, then 3 ms for the round trip that fetches the new grant.

This is **best-effort and never fails your request**. The balance change is
what counts and is already committed; the notification only decides whether the
session hears about it now or at its next report. If the queue write fails it
is logged and the response is unchanged. Delivery is at-most-once — nothing
retries — and a subscriber with no live session needs no notification, since
their next session reads the balance at Create.

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
- **No event notifications** (TMF `hub` / listener callbacks). A BSS learns
  about exhaustion by polling. The `chf.notifications` queue described above
  runs the other way — this API telling the CHF — and is not a TMF hub.
