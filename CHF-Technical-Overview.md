# Open5GS CHF — Technical Overview

**Status:** working implementation, not certified against any conformance suite
**Upstream base:** `aafde931b` (Open5GS main)
**Change set:** 100 commits, 695 files (568 of them generated), eight patch phases in `patches/`
**Last verified:** 2026-10-22 — UERANSIM regression on a two-VM rig including 5G slicing, per-slice balances isolated, CDRs decoded back from BER, live ChargingNotify, 0 CHF errors

This describes what the Charging Function does today, what of 3GPP and TM Forum
it implements, what it can carry, where it stops, and what would come next. It
supersedes the earlier `CHF_TECHNICAL_OVERVIEW.md` at the repository root,
which described a per-subscriber quota with charging state shared with Gy.
That document was deleted in session 58, once everything still true of it
lived here; it remains in git history for anyone tracing why the early
decisions were made.

For the northbound API in detail, see [CHF-TMF-API.md](CHF-TMF-API.md).

---

## 1. What it is

A 5G Charging Function: a network function that decides how much data a
subscriber may use, tells the SMF, counts what is used, and writes a record when
the session ends. It speaks **Nchf_ConvergedCharging** (TS 32.291) to the SMF
over SBI, and is provisioned through **TM Forum Open APIs** served by the WebUI.

Three pieces, in one repository:

| Piece | Where | Size | Role |
|---|---|---|---|
| **CHF network function** | `src/chf/` | ~5,500 lines | Serves Nchf_ConvergedCharging, owns quota decisions, writes CDRs |
| **SMF charging client** | `src/smf/nchf-*.c`, plus wiring | ~1,330 lines + hooks | Asks the CHF for quota, programs the UPF, reports usage |
| **Provisioning** | `webui/` | TMF APIs + two pages | Buckets, accounts, parties, top-ups |

A fourth, small piece lives in `lib/sbi/`: a CHF's NRF profile carries a
`supiRangeList`, so an SMF can discover the CHF that serves a given subscriber
(TS 29.510 §6.1.6.2.9).

The CHF process links **no Diameter libraries**. Gy remains the EPC's interface,
untouched: `git diff` against upstream contains no `sess->gy` line, and
`gy-path.c` / `gy-handler.c` are unchanged.

---

## 2. The charging model

### Buckets

A subscriber does not have "a quota". A subscriber holds **buckets**, each an
allowance for a **scope**:

| Dimension | Source in the charging request (TS 32.291) |
|---|---|
| Slice (SST, optional SD) | `pduSessionInformation.networkSlicingInfo.sNSSAI` |
| DNN | `pduSessionInformation.dnnId` |
| Home PLMN | `pduSessionInformation.hPlmnId` |
| Roaming state | `userInformation.roamerInOut` (absent = home) |

Any dimension left open matches anything. A bucket with all four open is the
subscriber's **catch-all**, which is what a plain per-subscriber plan is.

When several buckets cover a session, the one with the highest **priority** is
charged; equal priorities keep the older bucket, so the choice never depends on
the order the database returned. A bucket that names a dimension the request
does not carry is never eligible: a "slice 1" allowance is not spent by a
session whose slice is unknown.

If a subscriber is provisioned but no bucket covers the session, it is treated
as unprovisioned and follows `charging.unprovisioned`.

### The cycle counter

Each bucket carries its own billing-cycle counter — `consumedBytes`,
`topupBytes`, `periodStart` — written only by the CHF, with atomic `$inc`. It
survives session teardown, which is what makes "what is left this cycle"
meaningful across reconnects. Several allowances therefore run at once, one per
bucket.

The cycle is renewed lazily: the CHF opens or rolls it over on the next session
or report after its end, according to `autoRenew`.

### Grants

The CHF does not hand a session everything that is left. Each grant is capped:

```
grantedUnit.totalVolume = min(remaining in the cycle, charging.grant.max_volume_mb)
validityTime            = min(time left in the cycle, charging.grant.max_validity_seconds)
volumeQuotaThreshold    = 10% of the grant, or 0 when the grant ≤ min_report_mb
quotaHoldingTime        = min(validityTime, charging.grant.quota_holding_seconds)
```

That decides three things at once: how quickly a plan change reaches a live
session, how much two devices on one plan can overspend, and how many Updates an
allowance costs. With the shipped 50 MB / 300 s / 5 MB, a 90 MB plan is spent in
**3 reports**; without the floor it takes 9, because each early report leaves
10% of the one before.

`volumeQuotaThreshold` is how the CHF tells the SMF when to report — the SMF
turns it into the URR's volume threshold, and a 0 means "report only when the
grant is used up".

`quotaHoldingTime` covers the case those three do not: a session that stops
sending. It holds its grant until `validityTime` expires — five minutes by
default — and for that long the CHF sees no usage and a change reaches nothing.
The holding time is how long the session may sit idle before it has to report,
60 s as shipped. The UPF arms a timer for it; when the timer fires it measures
the time since the last packet, re-arms for the remainder if the session turned
out not to be idle after all, and otherwise reports with the Quota Holding Time
trigger and stops until traffic resumes. So an idle session sends **one** QHT
report, not one per holding time, and the rest of its grant is back in the cycle
within a minute instead of five.

It does not replace `validityTime`: that timer keeps running, so an idle session
still reports at the 300 s mark and every 300 s after. The holding time adds an
early report, it does not remove the later ones — what it changes is how stale
the CHF's view of an idle session can get, from five minutes to one.

The other half of that problem — a change that arrives while the session is
*busy*, and still has to wait for the next report — is what ChargingNotify
solves; see §8.

---

## 3. Session lifecycle

**Create** — the SMF sends the subscriber, the session's slice, DNN, PLMN and
roaming state. The CHF picks the bucket, opens the cycle if this is its first
session, computes what is left, grants one slice of it with a validity time, and
persists a session row. A subscriber with nothing left is granted 0 with a
FinalUnitIndication, which the SMF turns into a refusal (§4).

**Update** — the SMF reports usage and says why (TS 32.291 `triggers`). The CHF
adds the usage to the bucket's counter, re-reads the plan, re-bases the
session's ceiling on what the cycle now has left, and grants the next slice. A
plan edited between two reports takes effect here. Cycle expiry, auto-renewal
and mid-session provisioning are all handled on this path.

Three things bring a session to this path: it used its grant (or crossed the
early-report threshold), its `validityTime` expired, or it went quiet for
`quotaHoldingTime` and gave the rest of the grant back. A fourth comes from the
other direction — the CHF sends a **ChargingNotify** and the SMF reports
straight away (§8), which is how a top-up reaches a session that is in the
middle of a 50 MB slice and would otherwise say nothing for minutes.

**Release** — the final usage is banked, a CDR is written, and the session row is
removed. A session that was granted nothing and used nothing produces no CDR, so
a UE retrying against an empty balance cannot bury the real records.

When the balance runs out, the SMF releases the PDU session the network-requested
way (TS 23.502 §4.3.4.2): PFCP deletion first — its response carries the UPF's
final usage, which the Release bills — then a **PDU Session Release Command over
N1/N2**, then the usual PCF/UDM cleanup.

---

## 4. Feature list

| Area | Feature |
|---|---|
| **Charging** | Nchf_ConvergedCharging Create / Update / Release over cleartext HTTP/2 |
| | Volume quota (UL+DL combined), granted in slices with a validity time |
| | `volumeQuotaThreshold` so the CHF decides when the SMF reports |
| | Reporting triggers: quota threshold, quota exhausted, validity time, quota holding time, forced re-authorisation, final |
| | `quotaHoldingTime`, so an idle session's unused grant returns to the cycle |
| | ChargingNotify (TS 32.291 §6.3.4): a top-up or a bar reaches a live session at once, not at its next report |
| | FinalUnitIndication with TERMINATE / REDIRECT / RESTRICT_ACCESS (see limits) |
| | Billing cycles: daily, weekly, monthly, custom; auto-renew or expire |
| **Buckets** | Per subscriber, slice, DNN, home PLMN and roaming state |
| | Explicit priority; catch-all addressed by SUPI; per-bucket counters |
| | Top-ups that apply to the current cycle only |
| | Configurable default for unprovisioned SUPIs, or refusal |
| **SMF side** | Quota programmed into the PFCP URR (volume quota, threshold, validity, quota holding time) |
| | `notifyUri` offered to the CHF, and a `charging-notify` endpoint that serves it |
| | Graceful network-requested release when the balance runs out |
| | PDU session refused (5GSM cause 26) with a T3396 back-off when nothing is left |
| | Usage reports answered during teardown, so the last interval is billed |
| | Own accounting state, independent of Gy |
| **Records** | TS 32.298 CHF CDR (`ChargingRecord`), one per closing session |
| | Written as BER, as JSON, or both — one record, two serialisations, so they cannot disagree |
| | BER is what TS 32.298 clause 6.1 requires on Bx; the codec is generated by `asn1c` from the published 3GPP module |
| | JSON carries the same 3GPP field names and nesting, for reading without tooling |
| | Filed one file per session, or aggregated with record-count and size thresholds, configured per encoding |
| | `open5gs-chf-cdr-decode`, generated from the same ASN.1 at build time and installed with the CHF |
| | MongoDB index of CDR files |
| **Provisioning** | TMF632 Individual, TMF666 BillingAccount, TMF654 Bucket + TopupBalance |
| | WebUI pages: CHF Quota (buckets) and CHF Sessions (live) |
| | Idempotent top-ups; conditional writes against the live counter |
| | A top-up, plan change or deprovision queues a ChargingNotify for live sessions |
| **Operations** | 26 Prometheus metric families |
| | NRF registration with `supiRangeList` for CHF selection by SUPI |
| | NRF registration with `allowedNssais` for CHF selection by slice, so one CHF can be dedicated to a slice and another to a SUPI range |
| | Start-up migration of pre-bucket documents |
| **User plane** | UPF Quota Holding Time timer, so an idle session reports once and releases the rest |

---

## 5. 3GPP compliance

Field names and enumerations are taken from the 3GPP OpenAPI shipped in this
tree (`lib/sbi/support/r19-.../TS32291_Nchf_ConvergedCharging.yaml`), not from
memory — including spellings that are easy to get wrong, such as
`pDUSessionChargingInformation`, `pduSessionID`, `dnnId` and `sNSSAI`.

| Specification | Implemented | Not implemented |
|---|---|---|
| **TS 32.291** Nchf_ConvergedCharging | Create / Update / Release; `ChargingDataRequest` with `pDUSessionChargingInformation` (charging id, `userInformation.servedGPSI`, `roamerInOut`, `pduSessionInformation` with `pduSessionID`, `dnnId`, `ratType`, `hPlmnId`, `networkSlicingInfo.sNSSAI`); `multipleUnitUsage` / `usedUnitContainer`; `multipleUnitInformation` with `grantedUnit.totalVolume`, `validityTime`, `quotaHoldingTime`, `volumeQuotaThreshold`, `finalUnitIndication`; `triggers` with `IMMEDIATE_REPORT`; `notifyUri` and `ChargingNotify` (`REAUTHORIZATION`, `ABORT_CHARGING`, `reauthorizationDetails`) | Rating-group granularity (one group per session); time and event quota; tariff-time changes; `oneTimeEvent`; roaming QBC; `ChargingNotifyResponse.invocationResult` (the SMF answers 204, never a failure body) |
| **TS 32.290** charging principles | Quota-controlled online charging, per-session state, final-unit handling | Offline-only charging (`Nchf_OfflineOnlyCharging`) |
| **TS 32.298** CDR content and syntax | The `ChargingRecord` (clause 5.2.5) with volumes, duration, start/stop, cause, SUPI/GPSI, DNN, S-NSSAI and rating group, **BER-encoded** per clause 6.1 and/or rendered as JSON with the same field names. The codec is generated by `asn1c` from the published Rel-19 module | The non-5G-SA charging-information fields of `ChargingRecord` (IMS, SMS, MMS, ProSe and the rest); no CDR file transfer (Ga/Bx); the BER file is a bare concatenation of records, not the TS 32.297 file format with its headers; no rotation or retention beyond the aggregation thresholds and the daily directory |
| **TS 32.255** 5G data connectivity charging | Quota per PDU session, triggers, final unit | Per-rating-group charging driven by PCC charging keys |
| **TS 29.510** NRF | CHF profile with `chfInfo.supiRangeList`; SMF-side discovery matching a SUPI against ranges, so a CHF can be dedicated to an IMSI range | `chfInfo.gpsiRangeList`, `plmnRangeList`, `groupId`, and the primary/secondary CHF instance fields. Note `ChfInfo` has **no** S-NSSAI member, so slice restriction cannot go here — see the row below |
| **TS 33.518** NF discovery by slice | `NFProfile.allowedNssais` from `charging.slices`, and the SMF asking for a CHF on the session's S-NSSAI, so a CHF can be dedicated to a slice. Matching is exact on SST and SD, and ANDs with the SUPI-range filter | Slice restriction on the *service* rather than the instance (`nfServices[].allowedNssais`) |
| **TS 29.244** PFCP | URR with volume quota, volume threshold, quota validity time and quota holding time; the Quota Holding Time IE added to Update URR, which upstream omitted; usage reports consumed, including during deletion | Time quota/threshold as a charging input; per-QFI URRs; start-of-traffic reporting, which is what a fully conformant quota-holding release would need |
| **TS 23.502** procedures | Network-requested PDU session release on quota exhaustion (§4.3.4.2) | — |
| **TS 24.501** NAS | Establishment reject with cause #26 and a T3396 back-off timer; release command cause | — |
| **Transport** | Cleartext HTTP/2 (h2c) as Open5GS uses between NFs; TLS is available from `lib/sbi` configuration | TLS and OAuth2 not exercised in this work |

**Not certified.** Nothing here has been run against a 3GPP conformance suite.
"Implemented" means the messages are built and parsed in the shapes the
specification defines and were verified against a live SMF, UPF and gNB.

---

### 5.1 How the TS 32.291 models are produced

Open5GS does not hand-write `lib/sbi/openapi` — it generates it with
openapi-generator from the 3GPP YAML, so a release upgrade is a re-run rather
than a hand-edit. The CHF now follows that, rather than parsing charging JSON
with cJSON by hand.

The bundle in `lib/sbi/support/r19-20260402-openapitools-7.20.0/` is the whole
pipeline: `standard/` (pristine ETSI) → `patched/` (our hand-edits) →
`transform.py` → `modified/` → `generator.sh` → `lib/sbi/openapi/`.
`TS32291_Nchf_ConvergedCharging.yaml` (r19, API v3.3.0) was already present at
all three stages, including `transform.py`'s 1,801-line expansion of the
`oneOf` constructs the C generator cannot digest. It was simply never named in
`generator.sh`. Adding that line yields 188 models —
`charging_data_{request,response}`, `charging_notify_{request,response}`,
`multiple_unit_{usage,information}`, `granted_unit`, `final_unit_indication`
and the rest.

**Three schemas had to be renamed first.** The C generator flattens every spec
into one `OpenAPI_*` namespace, and TS 32.291 defines `NotificationType`,
`RedirectAddressType` and `QosMonitoringReport` itself, with different values
from specs already generated. Generating it unrenamed silently *replaced*
them — `OpenAPI_notification_type_e` went from the NRF's fourteen values
(`N1_MESSAGES`, `N2_INFORMATION`, …) to charging's two, underneath
`default_notification_subscription` in the NF profile. Nothing references
those symbols by name, so it still compiled; NF-profile and PCF parsing would
simply have stopped recognising the old strings. They are now
`ChargingNotificationType`, `ChargingRedirectAddressType` and
`ChargingQosMonitoringReport`, and the incumbents are byte-identical again.

Two enum values in the spec cannot become C identifiers and are fixed in
`patched/`: ETSI writes `Revocation Notification` with a space where its two
siblings use hyphens, and `VAS4SMS_SHORT_MESSAGE_VIRTUAL_PRIVATE_NETWORK(VPN)`
has parentheses.

`meson.build` is **not** generated — there is no mustache template for it — so
its source list is synced by hand after each run, as upstream does.

**Upgrading to R20** is then: drop the new YAML into `standard/`, re-apply the
`patched/` diffs (the three renames and two enum fixes among them), run
`transform.py` and `generator.sh`, sync `meson.build`, and fix whatever the
compiler complains about. That is the whole point of doing it this way.

**Known, not yet addressed.** Sixteen shared models still change shape when
TS 32.291 is generated — `Tai`, `Point`, `PduSessionInfo` and the geographic
family — because its `$ref` chain reaches different definitions of those names.
None has a consumer outside the generated tree today, so nothing regresses, and
both gcc and clang build clean. But they are a trap for whoever next uses one
of those types expecting the CommonData shape, and they want the same rename
treatment.

---

### 5.2 How the TS 32.298 CDR codec is produced

The CDR encoder is generated too, by the same `asn1c` that produces NGAP and
S1AP, from the same kind of bundle:
`lib/asn1c/support/cdr-r19.6.0/` is `standard/` (pristine 3GPP) → `patched/`
(our hand-edits) → `closure.py` → `modified/` → `generator.sh` →
`lib/asn1c/cdr/`.

**The ASN.1 is no longer in the specification.** TS 32.298 Rel-19 clause 5.2.5
says only "ASN.1 definitions are specified in 3GPP Forge", naming
`TS32298_CHFChargingDataTypes.asn`. `standard/` holds that file and its two
dependencies, taken from Forge `Rel-19` at commit `3e24b9aa`.

**The published module does not compile.** `NetworkFunctionality` is missing
the comma after `aIOTF (23)`, so the `ENUMERATED` does not parse.
`patched/spec-defects.asn` carries the corrected definition, copied verbatim
apart from that comma, and says so. It should disappear when 3GPP fixes it.

**Only the 5G SA path is generated.** `CHFRecord` reaches 353 types across
seven sibling charging modules, TS 29.002 MAP, CAMEL CAP and ITU-T
CMIP/ACSE/X.721 — none of which a PDU-session CDR needs, and some of which
3GPP does not publish. `patched/chf-5gsa-records.asn` trims `ChargingRecord`
and `PDUSessionChargingInformation` to the fields the CHF can populate,
keeping every retained field's original tag and type, and `closure.py` then
takes the transitive closure of what that reaches: **26 types, 21 of them
copied verbatim from the published module**. Because only `OPTIONAL` fields
were dropped and no tag moved, a decoder built from the complete TS 32.298
reads our records correctly.

**BER, not APER.** TS 32.298 clause 6.1 requires BER on the Bx interface
("Data Record Format" 1), which is the opposite of what NGAP and S1AP want.
`asn1c` writes the codec selection into `asn_config.h`, so `lib/asn1c/cdr`
keeps its own copy of the asn1c runtime instead of sharing
`lib/asn1c/common`: a C quote-include resolves against the including file's
own directory first, so sharing would compile the shared sources against
`common`'s BER-disabled config while the generated code used the BER-enabled
one — and those two disagree about the layout of `asn_TYPE_operation_s`. That
links cleanly and fails later, so the duplication buys a real guarantee.
`asn1c` emits DER, which is a canonical subset of BER, so any BER decoder
reads it.

As with the SBI models, `meson.build` is **not** generated and its source list
is synced by hand.

**Upgrading to R20** is: drop the new modules into `standard/`, re-check
whether `patched/spec-defects.asn` is still needed, run `generator.sh`, sync
`meson.build`. The Python decoder follows automatically — it is generated from
`modified/` at build time, so it cannot drift from the encoder.

---

### 5.3 Selecting among several CHFs, and who the consumer is

Two changes on 2026-10-09, both about identity rather than charging.

**Slice-restricted CHF selection.** A CHF can now be dedicated to one or
more slices, so a deployment can run one CHF per slice and another for a
SUPI range:

```yaml
chf:
  charging:
    slices:
      - sst: 1
        sd: 000001
```

That registers `NFProfile.allowedNssais`, and the SMF now asks for a CHF on
the session's S-NSSAI as well as its SUPI. It is deliberately **not** part
of `chfInfo`: TS 29.510's `ChfInfo` has no S-NSSAI member at all — only
SUPI, GPSI and PLMN ranges — so `allowedNssais` (TS 33.518 §4.2.2.2.1) is
the mechanism, and the NRF already applied it to every NF type. Nothing in
the discovery matcher needed changing; what was missing was a way for the
CHF to populate it and for the SMF to ask.

Three properties worth knowing:

- **The two filters AND.** A CHF restricted to a slice *and* a SUPI range
  answers only when both hold. An instance meant to serve a SUPI range
  regardless of slice must therefore leave `slices` empty.
- **Empty means every slice**, so an existing `chf.yaml` is unaffected and a
  single-CHF deployment needs no change.
- **SD matching is exact**, unlike a quota bucket's scope. A CHF listing
  `sst: 1` with no SD serves the S-NSSAI "SST 1, no SD" and *not* "SST 1,
  SD 000001". The two are different mechanisms — 3GPP NF discovery against
  our billing model — and conflating them is the easiest mistake to make
  here, so there is a test pinning it (`SBI-14`).

Selection happens once: Update and Release follow the Location URI that
Create returned, so a session stays on the CHF that admitted it.

**nfConsumerIdentification corrected.** `nFName` now carries the SMF's NF
instance id, which is what TS 32.291 types it as (an NfInstanceId, a UUID
per TS 29.571) and what TS 32.298 requires where the CDR records it as a
`NetworkFunctionName`. It previously carried the FQDN or the SBI address —
short enough to encode cleanly, which is why this went unnoticed, but not
an NfInstanceId. The FQDN and addresses now go in `nFFqdn`,
`nFIPv4Address` and `nFIPv6Address`, so nothing is lost.

That created one real tension, because the CHF used `nFName` as a
Prometheus label and an instance id is regenerated on every SMF start,
which would grow label cardinality without bound. The CHF therefore now
keeps the two apart: `smf_id` is the instance id and goes in the CDR,
while the metric label prefers `nFFqdn`, then the addresses, falling back
to the id only if the SMF sent nothing else.

---

## 6. TM Forum compliance

| API | Resource | State |
|---|---|---|
| **TMF632** Party Management v4 | `individual` | CRUD, filtering, projection, JSON Merge Patch |
| **TMF666** Account Management v4 | `billingAccount` | CRUD, `relatedParty` validation, delete guards |
| **TMF654** Prepay Balance Management v4 | `bucket` | CRUD; `@type: ChfDataBucket`, `@baseType: Bucket`; extension attributes for the plan and the scope |
| **TMF654** | `topupBalance` | Create and read; immutable records (405 on modify); `Idempotency-Key` enforced by a unique index |
| **TMF630** conventions | — | `id`/`href`/`@type`, `offset`/`limit` with `X-Total-Count` and 206, `?fields=`, equality filters on a whitelist, TMF Error objects, read-only attribute rejection |

Not implemented: event notifications (`hub`/listener callbacks), ETags on
Individual and BillingAccount, and any TMF Conformance Test Kit run. Errors from
the authentication layer and the global JSON parser are not TMF-shaped.

---

## 7. Configuration

```yaml
chf:
  charging:
    cdr:
      enable: true
      path: /var/log/open5gs/cdr
      format: json            # json | asn1 | both | none
      aggregation:            # the default for both encodings
        enable: false         # false: one file per session
        max_records: 1000     # roll at this many records; 0 = no cap
        max_size_mb: 16       # roll at this size; 0 = no cap
      asn1:                   # per-encoding override, optional
        aggregation:
          enable: true
    default_quota:            # for a SUPI with no bucket
      volume_mb: 10240
      validity_seconds: 86400
      final_unit_action: TERMINATE
    unprovisioned: default    # or "reject" (404 USER_UNKNOWN)
    grant:
      max_volume_mb: 50       # 0 disables the cap
      max_validity_seconds: 300
      min_report_mb: 5        # grants ≤ this are reported only when used up
      quota_holding_seconds: 60   # idle this long and the grant goes back; 0 off
    notify:                   # ChargingNotify — see §8
      enable: true
      poll_seconds: 5         # upper bound on how long a top-up waits
    supi_ranges:              # optional; empty means "serve every SUPI"
      - start: "imsi-001010000000000"
        end:   "imsi-001010000049999"
    slices:                   # optional; empty means "serve every slice"
      - sst: 1
        sd: 000001
```

All the `grant` and `notify` values and `unprovisioned` also have built-in
defaults, so an existing `chf.yaml` keeps working unchanged (Open5GS does not
overwrite an installed config) — including one written before these keys
existed, which then gets the shipped 60 s holding time and 5 s poll.

`cdr.format` defaults to `json` and `cdr.aggregation.enable` to `false`, so a
config written before the ASN.1 encoder existed keeps writing exactly what it
wrote before: one JSON file per session. The *contents* of that file have
changed, though — see §11.

The `json:` and `asn1:` blocks override `aggregation` for one encoding. That
is the arrangement the split exists for: a mediation system wants one
aggregated BER stream, while an operator reading JSON by hand wants a file per
session.

A `.ber` file is read back with the decoder installed alongside the CHF:

```
open5gs-chf-cdr-decode /var/log/open5gs/cdr/2026/10/01/cdr-*.ber
open5gs-chf-cdr-decode --count --strict /var/log/open5gs/cdr/2026/10/01/*.ber
```

It prints the same JSON the CHF would have written, needs only the Python
standard library, and can be copied to a billing host on its own.

---

## 8. Interfaces

**Southbound (SMF → CHF), HTTP/2 prior knowledge:**

```
POST /nchf-convergedcharging/v3/chargingdata               → 201 + Location
POST /nchf-convergedcharging/v3/chargingdata/{ref}/update  → 200
POST /nchf-convergedcharging/v3/chargingdata/{ref}/release → 204
```

**Northbound to the SMF (CHF → SMF), the same transport.** The SMF puts a
`notifyUri` in every `ChargingDataRequest`, pointing at its own callback
service, and the CHF POSTs there when something should reach a live session
before its next report:

```
POST {nsmf-callback}/v1/charging-notify/{smContextRef}   → 204
  { "notificationType": "REAUTHORIZATION",
    "reauthorizationDetails": [ { "ratingGroup": 1 } ] }
```

`REAUTHORIZATION` makes the SMF report immediately with triggerType
`FORCED_REAUTHORISATION`; the answer to that report carries the new grant, so
the top-up is live from the next packet. `ABORT_CHARGING` releases the session
down the same path a spent quota takes — PFCP deletion first so its response
carries the final usage, then a PDU Session Release Command over N1/N2.

What starts it is a row in `chf.notifications`, written by the TMF layer on a
top-up, a plan change or a deprovision, and polled by the CHF every
`poll_seconds`. A queue rather than a direct call: the WebUI does not speak
Nchf, the CHF grows no inbound admin endpoint, change streams would need a
replica set, and a row written while the CHF is down is still delivered when it
returns. Delivery is at-most-once on purpose — a notification only ever asks
for a report the session would have made anyway, later — and queueing never
fails the request that moved the balance.

**Northbound (BSS → WebUI), JWT-authenticated, writes need an admin account:**

```
/api/tmf-api/partyManagement/v4/individual[/{id}]
/api/tmf-api/accountManagement/v4/billingAccount[/{id}]
/api/tmf-api/prepayBalanceManagement/v4/bucket[/{id}]
/api/tmf-api/prepayBalanceManagement/v4/topupBalance[/{id}]
```

**Storage** — MongoDB, alongside the rest of Open5GS:

| Collection | Written by | Contents |
|---|---|---|
| `chf.subscribers` | WebUI/TMF (plan, scope, priority), CHF (counter) | One document per bucket |
| `chf.sessions` | CHF | Live sessions |
| `chf.cdrs` | CHF | Index of CDR files |
| `chf.notifications` | WebUI/TMF (writes), CHF (reads and deletes) | ChargingNotify queue |

**Metrics** (Prometheus, port 9090): `chf_sessions_active`, `chf_sbi_requests_total`,
`chf_sbi_request_duration_milliseconds`, `chf_sbi_inflight`, `chf_session_create_total`,
`chf_session_update_total`, `chf_session_release_total`, `chf_quota_lookup_total`,
`chf_quota_granted_kilobytes_total`, `chf_quota_used_kilobytes_total`,
`chf_quota_exhausted_total`, `chf_quota_final_unit_total`, `chf_quota_auto_renew_total`,
`chf_provisioned_subscribers`, `chf_db_ops_total`, `chf_db_op_duration_milliseconds`,
`chf_db_unavailable_total`, `chf_cdr_written_total`, `chf_cdr_encoded_total`,
`chf_cdr_file_rolled_total`, `chf_cdr_bytes_total`,
`chf_cdr_write_duration_milliseconds`, `chf_quota_bucket_selected_total`,
`chf_errors_total`, `chf_charging_notify_sent_total`,
`chf_charging_notify_failed_total`.

Three were added on 2026-10-09, for the two things the earlier set could not
answer — which encoding is failing, and whether per-slice charging is actually
happening:

| Metric | Labels | Answers |
|---|---|---|
| `chf_cdr_encoded_total` | `format`, `result` | Is one encoding failing while the other succeeds? `chf_cdr_written_total` counts one per *record*, so with `format: both` it cannot show a BER file quietly falling behind the JSON. |
| `chf_cdr_file_rolled_total` | `format`, `reason` | Are the aggregation thresholds tuned? Rolls attributed almost entirely to `records` or to `size` mean the other threshold is doing nothing; `day` is the directory turning over. |
| `chf_quota_bucket_selected_total` | `kind`, `slice` | Is per-slice charging happening? `kind` is `scoped`, `catchall` or `default`; `slice` is `sst/sd`, `sst`, or `none`. Confirming that a scoped bucket beats the catch-all previously meant reading CHF logs — which is exactly what the slicing regression had to do. |

Measured on the rig with the BER stream rolling at one record per file: four
records gave `chf_cdr_written_total 4`, `chf_cdr_encoded_total` 4 for each
format, and `chf_cdr_file_rolled_total{format="asn1",reason="records"} 3` —
the first record opens a file and the next three roll it. The slice label came
out as `{kind="scoped",slice="1/000001"}` and `{...,slice="1/000002"}`, never
`catchall`, which is the property the per-slice buckets exist for.

All label values stay bounded, which is what makes them safe to label on:
`slice` by the number of slices a deployment runs, `format` and `reason` by
the code. The `CHF_METR_MAX_LABELED_INSTANCES` cap remains as the backstop.

---

## 9. Capability

**Measured**, with a load generator driving the CHF directly over h2c, on an
Apple M-series laptop with a local MongoDB — *not* on the test VM, which is
slower:

| Test | Result |
|---|---|
| Lifecycle (Create → 3 Updates → Release), 2,000 sessions, 50 concurrent | **~4,200 requests/s**; Create p99 16.8 ms, Update p99 20.3 ms, Release p99 18.5 ms |
| Attach storm, 5,000 Creates, 200 concurrent | 4,095 accepted, 905 refused cleanly at the session-pool limit, no crash |

**Structural limits:**

- **Concurrent sessions:** `max.ue × 4` (`OGS_MAX_NUM_OF_SESS`), preallocated —
  4,096 with the shipped `max.ue: 1024`. Beyond it, Create returns 500 and the
  refusals are counted, not fatal.
- **Single-threaded:** like every Open5GS NF, the CHF runs one event loop, so
  more cores do not help. MongoDB calls are synchronous and block it; the
  database is the first thing to watch under load.
- **Buckets per subscriber:** 16 are read per lookup; more are ignored with a
  warning.
- **Report rate:** an active session reports roughly once per 45 MB (90% of a
  50 MB slice). An idle one reports **twice**: once 60 s after its last packet
  (`QHT`), then at the 300 s validity mark (`VALIDITY_TIME`), and every 300 s
  after that. The quota holding time adds one early report; it does not reduce
  the long-run idle rate, which stays at one Update per session per 300 s
  (1,000 idle sessions ≈ 3.3 Updates/s). What it buys is freshness: the usage
  and the unused grant come back to the cycle within a minute instead of five.
  Measured on the rig, 2026-09-25: traffic stopped, `QHT` at +61 s,
  `VALIDITY_TIME` at exactly +300 s from Create.
- **ChargingNotify poll:** one indexed `find` on `chf.notifications` every 5 s,
  against a collection that is empty almost always. Measured delivery, once a
  row is queued: under 6 s to the notification, then **3 ms** from the CHF's
  POST to the SMF's re-authorisation Update landing back at the CHF.

---

## 10. Testing

**Unit** — `meson test -C build --suite chf`: two tests, no network or database
needed.

`chf-unit` is 7 suites, 77 cases: quota arithmetic, the CDR writer (paths,
field names, the json/asn1/both switch, aggregated filing against both
thresholds for each encoding, and that a BER aggregate is a concatenation of
whole records), the TS 32.298 record itself (which fields a session becomes,
the `[200]` tag the encoding opens with, a BER round-trip, volumes past 2^32,
all three closing causes, the SliceDifferentiator octets and the BCD
TimeStamp),
SUPI-range matching and slice-restricted CHF selection, grant shaping
including the quota holding time, bucket scope and priority, and the
metric spec tables.

`chf-cdr-decode` is the one test that can say the JSON mirrors the BER,
because it compares them through something that shares no code with either:
`chf-cdr-emit` writes both encodings of the same sessions, and
`open5gs-chf-cdr-decode` — generated from the ASN.1 module, not from the
CHF's C — decodes the BER back. The two JSON documents must then be equal.
It also concatenates the BER files and checks every record still decodes,
which is what aggregation depends on.

**WebUI** — 155 tests (plus 6 that run only against a real MongoDB): TMF
conventions, bucket scope, top-up idempotency and races with the CHF counter,
guards that stop the UI rewinding the usage counter, and the ChargingNotify
queue — what gets queued on a top-up, a plan change and a deprovision, and that
a queue failure never fails the request that moved the balance.

**End to end on the rig** — an eleven-case regression with UERANSIM against the
full core, against upstream base `eae00c996`, with every charging message built
and parsed by the generated TS 32.291 models:

| # | Case | Verified |
|---|---|---|
| 1 | Unprovisioned SUPI | warning logged, default 10 GB applied, granted one 50 MB slice at 300 s |
| 2 | Catch-all bucket | slice of the remainder granted, counter advances on the report |
| 3 | Scoped bucket | charged instead of the catch-all on priority; catch-all counter stays at 0 |
| 4 | Exhaustion | transfer cut off mid-file, graceful release, CDR `volumeLimit` with the slice |
| 5 | Empty balance | refused with 5GSM cause 26 and a 60 s back-off; UE sees `INSUFFICIENT_RESOURCES`; no zero-byte CDRs |
| 6 | Top-up | next grant exact to the byte (31,285,002 = plan + top-up − consumed); service returns |
| 7 | Three UEs | three independent counters, ~10.4–10.5 MB each |
| 8 | Release and deregistration | both paths write `normalRelease` CDRs with volumes, duration, slice and DNN |
| 9 | Idle session | reports at exactly 300 s with `VALIDITY_TIME` |
| 10 | **Quota holding time** | idle 60 s → Update with `trigger:QHT`, usage banked; one report per idle period |
| 11 | **ChargingNotify** | `REAUTHORIZATION` → SMF reports in **3 ms** with `FORCED_REAUTHORISATION`, top-up live; `ABORT_CHARGING` → release in 7 ms, final usage billed, CDR `managementIntervention` |

All eleven passed with **0 CHF and 0 SMF errors**. The residual log lines are
upstream's AMF logging our deliberate rejections at ERROR level, and GTP-U error
indications for tunnels of UEs stopped without deregistering.

**The current-base regression (2026-10-22, base `aafde931b`)** closed the gap
the previous entry left open: the replant onto `aafde931b` had been verified
by invariants, build and unit suite, none of which involve live traffic. This
run was done the way §5.6 documents rather than from a working tree — the VM
was reset to a pristine `aafde931b` and the eight patch files were applied
there, so what the rig exercised is the deliverable.

| What | Result |
|---|---|
| Patch set, applied on the VM | all eight applied to a pristine `aafde931b` with no fuzz; byte sizes matched the generator's output exactly |
| Build and unit suite | clean build and install; 7 suites / **77 cases** plus `chf-cdr-decode`, all passing on the VM |
| The heartbeat condition | CHF alive through ~48 heartbeats, **0 CHF errors**, no crash cores — the §13.6 fault stays fixed on the new base |
| Slice isolation | catch-all **0** throughout; `slice1sd1` 63,052,628 and `slice1sd2` 42,026,802, each on its own bucket |
| Independent exhaustion | both scoped buckets hit their own quota and closed `volumeLimit` — 63,052,628 of 60 MB and 42,026,802 of 40 MB |
| CDRs | 2 JSON + **1** aggregated BER holding both records — `psi=1 sST=1 sD=000001` and `psi=2 sST=1 sD=000002` |
| Encodings agree | **2 of 2** JSON CDRs matched their BER record exactly, decoded by the installed `open5gs-chf-cdr-decode` |
| `test-chf-api.sh`'s assertions, live | **PASS** against a real rig CDR |
| ChargingNotify | **2 sent, 2 acknowledged** by the SMF with matching `chargingDataRef`s; `chf_charging_notify_failed_total` **0** |
| Metrics | `chf_cdr_written_total 2`, `chf_cdr_encoded_total` 2 per format, `chf_quota_bucket_selected_total{kind="scoped",…}` 221 and 125, nothing on `catchall` |
| Errors | CHF **0**, SMF 8, UPF 2, AMF 344 — the same documented residuals, in the same proportions, as 2026-10-20 |

Nothing new came from the three upstream commits this base brought in. The SBI
constify is source-compatible with our additions, which was confirmed by
compiling rather than by reasoning about `const` propagation. Upstream's UPF
change is better than neutral: `506a2d8c5` now calls
`upf_sess_urr_acc_remove_all()` on the session-establishment failure path, and
because our quota-holding timer lives in the same `urr_acc` slot that
`upf_sess_urr_acc_remove()` already clears, their use-after-free fix covers
phase 8's timer on a path we had not considered.

Two things in this run are worth reading rather than skimming. The AMF's 344
errors are the UE retrying establishment against an exhausted quota and being
refused, which is why `chf_quota_bucket_selected_total` reads 221 and 125
rather than 2 — one more than the rejects in each case being the establishment
that succeeded. And the ChargingNotify check initially refused to run at all,
reporting no live session: both PDU sessions had already been torn down by
`FinalUnitAction: TERMINATE` when their quota ran out. That is the guard added
on 2026-10-20 doing its job — queued against a released session a notify has
no `notifyUri` to reach, and the zero that follows would have meant nothing.
Re-provisioning and re-establishing gave it two live sessions to work with.

**The ASN.1 CDR run (2026-10-01, base `4107085fe`)** re-exercised the charging
path with `format: both` and the BER stream aggregated, against the same rig:

| What | Result |
|---|---|
| Four sessions, ~97 MB over one 100 MB bucket | three billable CDRs; the fourth session was refused with nothing granted and nothing used, so it got no record |
| Filing | 3 individual `.json` files and **1** aggregated `.ber` holding all 3 records — the per-encoding policy doing exactly what it was set to |
| Encodings agree | every one of the 3 JSON CDRs matched its BER record **exactly**, decoded by the installed `open5gs-chf-cdr-decode` |
| Quota exhaustion | third record carries `causeForRecClosing: volumeLimit` in both encodings |
| Errors | CHF **0**, UPF **0** |
| Metrics | `chf_cdr_written_total{result="success"} 3`, `chf_cdr_bytes_total 3583` |

**The replant regression (2026-10-16, base `f5c702545`)** re-ran the slicing
and CDR paths after twenty-one upstream commits, one of which conflicted:

| What | Result |
|---|---|
| Patch set | all eight applied clean to a pristine `f5c702545`; 7 suites / 76 unit cases and the decode test passing; installed |
| Slice isolation | catch-all **0** throughout; `slice1sd1` 43,771,286 and `slice1sd2` 42,039,234, each on its own bucket |
| CDRs | 2 JSON + 1 aggregated BER — `psi=1 sST=1 sD=000001 normalRelease` and `psi=2 sST=1 sD=000002 volumeLimit` |
| Encodings agree | **2 of 2** JSON CDRs matched their BER record exactly |
| Metrics | `chf_cdr_written_total 2`, `chf_cdr_encoded_total` 2 per format, `chf_quota_bucket_selected_total{kind="scoped",…}` for both slices and nothing on `catchall` |
| Errors | CHF **0**, SMF **0**; UPF 3 and AMF 113, both the documented residuals |

The conflict was worth reading rather than resolving mechanically: our hunk in
`reselect_upf()` had removed an early `return` so sessions on a failed UPF get
released, and upstream has since done the same and gone further, properly
releasing EPC sessions towards the SGW where ours only logged that EPC
restoration was unimplemented. Upstream's version is strictly better, so
theirs is what survives and phase 6 is smaller for it.

The SMF's error count was 8 in the previous run — a PCF `sm-policies` delete
race — and is 0 here, which upstream's `b50611f91` (don't abort on PFCP
deletion timeout when the SBI stream is gone) plausibly accounts for.

**The crash-fix regression (2026-10-20, base `310fea94e`)** re-ran the whole
charging path after the replant onto `310fea94e` crashed the CHF on its first
NF heartbeat — see §13.6 for the fault itself. A crash during a rig run voids
that run's results, so this one starts from a clean rig.

| What | Result |
|---|---|
| Patch set | all eight applied clean to a pristine `310fea94e`; 7 suites / 77 unit cases and the decode test passing; installed |
| The fix under its own condition | all 13 NFs alive through the heartbeat interval that used to kill the CHF, and **0** CHF errors across the whole run |
| Slice isolation | catch-all **0** throughout; `slice1sd1` 63,058,008 and `slice1sd2` 42,038,610, each on its own bucket |
| Independent exhaustion | both scoped buckets hit their own quota and closed `volumeLimit` — 63,058,008 of 60 MB and 42,038,610 of 40 MB |
| CDRs | 2 JSON + **1** aggregated BER holding both records — `psi=1 sST=1 sD=000001` and `psi=2 sST=1 sD=000002`, both `volumeLimit` |
| Encodings agree | **2 of 2** JSON CDRs matched their BER record exactly, decoded by the installed `open5gs-chf-cdr-decode` |
| `test-chf-api.sh`'s assertions, live | the TC-12 field checks run against a real rig CDR for the first time: **PASS** |
| ChargingNotify | **2 sent, 2 acknowledged** — one per live session, each matched by an SMF "CHF asked for re-authorisation" with the same `chargingDataRef`; `chf_charging_notify_failed_total` **0** |
| Metrics | `chf_cdr_written_total 2`, `chf_cdr_encoded_total` 2 per format, `chf_quota_bucket_selected_total{kind="scoped",…}` 355 and 252 for the two slices, nothing on `catchall` |
| Errors | CHF **0**, SMF 8, UPF 2, AMF 605 |

The AMF's 605 error lines are worth reading rather than dismissing, because the
count is new: 354 for PSI 1 and 251 for PSI 2, both "PDU session establishment
reject". They are the UE retrying establishment after its slice quota ran out,
each retry reaching the CHF and being refused — which is why
`chf_quota_bucket_selected_total` reads 355 and 252 rather than 2, one more
than the rejects in each case being the establishment that succeeded. Refusing
a session with no quota and no top-up is the correct charging outcome, so this
is enforcement working, logged at ERROR by upstream's AMF. The SMF's 8 are the
documented `npcf-smpolicycontrol .../delete` race (two events, one of them
dumping seven lines of message fields) and the UPF's 2 are GTP-U error
indications for a tunnel whose UE stopped without deregistering.

Two faults in the verification harness surfaced here, both of which had been
reporting false results, and neither in the CHF:

- The decode step wrote its scratch files to `/tmp`. With
  `fs.protected_regular=1` — the default on this Ubuntu — even root cannot
  `O_CREAT` over a file another user owns in a world-writable sticky
  directory, so a scratch file left by an earlier non-root run made the
  decode fail with `EACCES` and report "0 records decoded". That is
  indistinguishable from a CHF that never wrote any BER. It now uses a
  private directory under `/root`.
- The ChargingNotify check grepped the whole SMF log and tailed the last five
  matches, so it displayed month-old lines from an earlier run as this run's
  evidence while the counter sat at 0. It is now a delta against a line mark,
  and it refuses to run at all unless the SUPI has a live session — a notify
  is addressed to a session's `notifyUri`, so queued against a released
  session it has nowhere to go, and the zero that follows means nothing.

One assertion was also wrong rather than stale: the live CDR check required
`causeForRecClosing: normalRelease`. Which of the three causes a record
carries is a property of the session, not of the writer — `nchf-handler.c`
picks `managementIntervention` for an aborted session, `volumeLimit` when a
final-unit indication was issued, and `normalRelease` otherwise. A rig session
that runs its slice quota down closes with `volumeLimit` and is exactly as
correct as `test-chf-api.sh`'s own session, which never exhausts its grant and
so always closes `normalRelease`. The check now asserts the enum.

`chf.sessions` held 18 documents for 2 live sessions, which is residue from
crashed and killed daemons across weeks of work rather than a leak: today's
607 refused establishments left 3 strays between them, and the notify went to
the 2 in-memory sessions and ignored every stale document, so they cause no
false notifications. Clearing the collection is part of restoring the rig.

**The 5G slicing run (2026-10-09, base `d5d735c67`)** tested the thing the
bucket model exists for: one subscriber holding separate balances per slice.

The rig was given two slices differing *only* by S-NSSAI SD — `1-000001` and
`1-000002`, both on DNN `internet` — because a bucket scoped to `{sst:1}` with
the SD left open would match either, and prove nothing. One UE then held two
concurrent PDU sessions, one per slice, against three buckets: a 500 MB
catch-all at priority 0, and a 60 MB and 40 MB bucket scoped to one slice each
at priority 10.

| What | Result |
|---|---|
| Bucket selection | the CHF logged `Bucket [...-slice1sd1] charged [priority:10 of 3 buckets]` and `[...-slice1sd2]` — each slice chose its own scoped bucket, not the 500 MB catch-all |
| Isolation | ~80 MB on slice `000001` left `slice1sd2` and the catch-all at **0**; traffic on `000002` then left `slice1sd1` unchanged at 63,043,704 |
| Independent exhaustion | both buckets hit their own quota and closed `volumeLimit` — 63,043,704 of 60 MB and 42,164,386 of 40 MB |
| Catch-all | **never charged**, despite holding five times the quota |
| CDRs | one per session, each with the right `sST` and a distinct `sD` (`000001`, `000002`) |
| Encodings agree | **2 of 2** JSON CDRs matched their BER record exactly |
| `SliceDifferentiator` on the wire | `81 03 00 00 01` and `81 03 00 00 02` — tag [1], length 3, the three octets TS 32.298 specifies. The first run to exercise this field; previous runs had no SD |
| Errors | CHF **0**, SMF **0** |

That the counter overshoots its quota slightly — 63.0 MB against 60 MB — is
threshold reporting working as designed, not a defect: the CHF learns the final
interval only when the session reports it.

The SMF's eight error lines are a `npcf-smpolicycontrol .../delete` race with
the UE re-establishing immediately after release — not the charging path. The
AMF's are again its ERROR-level logging of the cause-26 rejections the CHF
asked for, repeated as the UE retried against an exhausted bucket.

One conformance gap this run made visible, in the SMF rather than the CHF: the
CDR's `nFunctionConsumerInformation.networkFunctionName` came out as
`127.0.0.4`. TS 32.298 says a `NetworkFunctionName` shall be a UUIDv4, and
TS 32.291's `nfConsumerIdentification.nFName` is an NfInstanceId. The SMF was
sending its FQDN, or its address when it had no FQDN, so the CHF was
faithfully recording what it was told. **Fixed on 2026-10-09** — see §5.3.

The conversion to generated models was re-run through the same eleven cases.
It found **three conformance bugs the hand-written JSON had been getting away
with** — all of them fields TS 32.291 marks required, all of them silently
absent for as long as this code has existed, and all of them caught because the
generated serialiser refuses to emit a body without them:

| Missing field | Where | Effect once enforced |
|---|---|---|
| `invocationTimeStamp` | ChargingDataRequest | no Create could be built |
| `invocationTimeStamp` | ChargingDataResponse | CHF answered 504 |
| `nfConsumerIdentification` | Update and Release (Create had it) | session could not be released |

A CHF that validated against the schema would have rejected every request this
SMF ever sent. Ours did not, so the gap was invisible. The required lists were
then read off the spec directly rather than discovered one rig run at a time:
those three, plus `pduSessionID` on PDUSessionInformation, which was always set,
are the complete set for the schemas this code builds.

Three defects were found by the earlier (2026-09-25) run and fixed then:

1. **The validity report lost its trigger.** `fill_usage_report()` infers the
   time triggers by comparing `dur_measurement` — the time since the *last*
   report — against the timer's period. That is the same number only while every
   report restarts every timer, which the QHT report deliberately does not do.
   An idle session's 300 s report arrived with no trigger at all. The three
   grant-lifetime timers now state their own trigger instead of having it
   inferred.
2. **ChargingNotify was answered 400 before the handler ran.** `parse_content()`
   rejects an `nsmf-callback` resource it has no OpenAPI model for, and
   ChargingNotifyRequest has none. It now passes the body through, the way the
   ChargingDataRequest already did, and the handler decides.
3. **An aborted session's CDR read as an ordinary release.** A session closed by
   `ABORT_CHARGING` wrote `normalRelease`, which is not what happened — the
   subscriber still had quota. It now writes TS 32.298 `managementIntervention`.

One thing the rig shows that is worth stating: a UE whose session is aborted
re-establishes immediately, and upstream's duplicate-PSI handling then logs
three ERROR lines cleaning up the old context's PCF policy while the release is
still in flight. The teardown itself completes correctly — CHF Release OK, final
usage billed, CDR written — and the same race exists on the quota-exhaustion
path. It is upstream's, not this work's, but it is visible whenever an abort is
followed by a fast re-attach.

UERANSIM does not honour the T3396 back-off: it retries a refused PDU session
about once a second regardless. The back-off IE is built and sent (case 5
confirms the SMF side); what a real UE does with it is not tested here.

---

## 11. Limitations

**One breaking change to call out first.** The JSON CDR is no longer the flat,
Open5GS-specific object it was. It is now the TS 32.298 record rendered as
JSON, which means different field names and real nesting — `supi` became
`chargingFunctionRecord.subscriberIdentifier.subscriptionIDData`, the volumes
moved into `listOfMultipleUnitUsage[].usedUnitContainers[]`,
`causeForRecordClosing` became `causeForRecClosing`, and `quotaExhausted` is
gone because `causeForRecClosing: volumeLimit` already says it. Anything
parsing the old shape needs updating. The upside is that there is now one
record definition rather than two, and the standard's names rather than ours.
`charging.cdr.format` still defaults to `json`, so an existing deployment
keeps getting one JSON file per session — with new contents.

Ordered by how likely they are to matter.

1. **One rating group per session.** All traffic in a PDU session counts against
   one bucket. Charging different services within a session differently is not
   possible, and if the PCF installs PCC rules with different charging keys,
   their usage is still merged.
2. **REDIRECT and RESTRICT_ACCESS are signalled but not enforced.** The CHF
   sends the chosen `finalUnitAction`; the SMF tears the session down for all
   three. There is no redirect server or restricted filter.
3. **CDRs are written, never transferred.** They are now the TS 32.298
   `ChargingRecord` in BER, in JSON, or both, filed individually or aggregated
   — but there is still no Bx or Ga: a billing system reads files from disk.
   Nor is there rotation or retention beyond the aggregation thresholds and
   the daily directory; nothing deletes an old CDR. Two further gaps worth
   naming: the BER file is a bare concatenation of records, not the
   TS 32.297 CDR *file* format with its file header and per-record headers;
   and the MongoDB CDR index stores one path per record, so with both
   encodings enabled it points at the JSON and the BER file is named only in
   the log line.
4. **Sessions are not restored after a CHF restart.** In-memory sessions are
   lost; MongoDB session rows remain until cleaned. Counters survive, so billing
   does not lose data, but live sessions keep their last grant until they report
   again.
5. **Quota holding reports early; it does not release.** On the holding timer
   the UPF reports and the CHF re-grants from the current cycle, which is what
   makes a change visible within a minute instead of five. A fully conformant
   implementation would return the grant and re-request it on the next packet,
   which needs start-of-traffic reporting the UPF does not have. The
   `validityTime` timer also keeps running, so an idle session still reports
   every 300 s: the holding time adds an early report rather than replacing the
   later ones, and the long-run idle signalling rate is unchanged.
6. **ChargingNotify is polled, not pushed.** A top-up reaches a live session
   within `poll_seconds` (5 s shipped) plus one Nchf round trip — measured at
   3 ms for the round trip itself — not instantly. Delivery is at-most-once: if
   the CHF cannot reach the SMF the change lands at the session's next report
   instead. Nothing retries, and nothing tells the operator which sessions a
   given top-up actually reached beyond the `chf_charging_notify_*` counters.
7. **Multi-device overspend up to one slice per device.** Two devices on one
   plan can each be granted a slice before either reports.
8. **Mid-session provisioning only picks up the catch-all.** A *scoped* bucket
   created while a session is running applies from that subscriber's next
   session.
9. **Session-pool ceiling is preallocated** at `max.ue × 4`; raising it costs
   memory at start-up, and every NF must be raised together.
10. **No OAuth2 or TLS in this work.** The SBI transport is whatever Open5GS is
   configured for; neither was exercised.
11. **Home-routed roaming is not tested.** The roaming dimension is populated
    from the serving/home PLMN comparison, but no HR-roaming rig exists here.
12. **Not certified**, against either 3GPP conformance or the TMF CTK.

---

## 12. Roadmap

**Next, and self-contained:**

| Item | Why | Rough size |
|---|---|---|
| Per-rating-group metering | The one gap that blocks real tariffs: charge IMS, video and general traffic differently within a session. Needs `multipleUnitInformation` per group, PCC charging keys from the PCF, and a bucket key that includes the rating group | Large |
| Enforce REDIRECT / RESTRICT_ACCESS | Makes the two advertised final-unit actions real: a redirect FAR to a portal, or a restricted PDR set | Medium |
| CDR rotation, retention and export | Makes the records usable by a billing system without a bespoke reader | Medium |
| Session restore after restart | Rebuild live sessions from `chf.sessions` so a CHF restart does not leave the SMF holding stale grants | Medium |

**Done since this document was first written:** ChargingNotify (TS 32.291) and
quota holding time — see §8 and §2. What remains of each is in §11: the
notification is polled rather than pushed, and quota holding reports and
re-grants rather than returning the grant and re-requesting it on the next
packet.

**After that:**

- **Start-of-traffic reporting in the UPF**, which is what would turn quota
  holding from "report early" into a true release-and-re-request.
- **Time and event quota**, alongside volume.
- **CHF redundancy**: more than one CHF per SUPI range, with SMF-side failover.
- **TMF hub/notifications**, so a BSS learns about exhaustion without polling.
- **Conformance runs**: 3GPP message conformance and the TMF CTK, which would
  turn "aligned with" into "certified against".

---

## 13. The patch set: how the change is split, and why

The work is carried as eight patches against a recorded upstream commit, not as
a branch to be merged wholesale. That shape is deliberate: it is what makes a
change of this size reviewable, and what lets it survive upstream moving.

### 13.1 The eight phases

Each row is one patch, in the order they apply. Sizes are added lines, which is
the honest measure here — almost nothing is deleted.

| # | Patch | Files | Added | What it contains | Depends on |
|---|---|---|---|---|---|
| 1 | `chf-phase-1-generated-code` | 568 | 73,569 | Everything machine-generated, and the two spec bundles that generate it: the TS 32.291 models from openapi-generator, and the TS 32.298 CDR codec from asn1c. Read the two `generator.sh` scripts and the `patched/` diffs; skip the output | — |
| 2 | `chf-phase-2-shared-libs` | 10 | 406 | Shared libraries: a CHF's NRF profile carries `supiRangeList` and discovery matches a SUPI against it; the charging payloads on `ogs_sbi_message_t`; PFCP gains Quota Holding Time on Update URR | 1 |
| 3 | `chf-phase-3-chf-complete` | 44 | 13,898 | The CHF network function itself, its config, its CDR writer in both encodings, the generated Python decoder, and its tests. Nothing outside `src/chf/`, `tests/chf/`, `configs/` and the registrations | 1, 2 |
| 4 | `chf-phase-4-smf-selector` | 4 | 511 | SMF: which charging interface a session uses, the CHF's own accounting state, and usage taken from PFCP reports | 2 |
| 5 | `chf-phase-5-smf-nchf-client` | 6 | 1,497 | SMF: the Nchf client — request building, grant handling, URR programming, the ChargingNotify handler | 1, 2, 4 |
| 6 | `chf-phase-6-smf-wiring` | 9 | 509 | SMF: the state machine — when Create/Update/Release are sent, the ChargingNotify endpoint, release on exhaustion, refusal with back-off | 5 |
| 7 | `chf-phase-7-webui` | 50 | 15,533 | Provisioning: TM Forum APIs, the two CHF pages, the start-up migration, the ChargingNotify queue. 8,469 of those lines are `package-lock.json` | 3 |
| 8 | `chf-phase-8-upf-quota-holding` | 2 | 153 | UPF: the Quota Holding Time idle timer, so an unused grant comes back to the cycle | 2 |

Phase 1 grew on 2026-10-01 and was renamed from `chf-phase-1-sbi-generated-models`
to `chf-phase-1-generated-code`: it now carries two generators rather than one,
since the CDR codec is asn1c output and belongs with the other machine-written
code. Nothing was renumbered — the ASN.1 codec has the same dependents the
models do, so it joined phase 1 rather than displacing anything.

The numbering was reordered on 2026-09-26. The generated models used to be phase 8
and were described as a leaf; converting the charging code to them made
`lib/sbi/message.c`, `src/chf` and `src/smf/nchf-*.c` all depend on them, so the
foundation was being applied last and three rows of this table pointed forwards.
Putting them first is what makes **every** dependency point backwards, and it
reads in the order a person would build it: models, libraries, the CHF, the SMF
that talks to it, provisioning, user plane.

### 13.2 How the split was chosen

Three rules decide which patch a change belongs to.

**By what owns the code, not by when it was written.** A phase is one
component: the CHF, the shared libraries, the SMF's selector, the SMF's client,
the SMF's state machine, the WebUI, the UPF. A fix made late to the CHF goes into phase 1
next to the code it fixes, however long after phase 1 was first written. The
patches are therefore always a description of the *current* system, never a
history of how it got there — that is what the git log is for.

**Every changed file belongs to exactly one phase.** No file is split across
two patches. This is checked mechanically on every regeneration, and it is what
makes a patch reviewable on its own: you never have to hold half a file in your
head while reading another patch to find the rest.

**Ordered so each phase stands on the one before.** Phase 1 supplies the
generated models before anything parses into them; phase 2 adds discovery and
the message payloads before phase 3 uses them; phase 5 adds the Nchf client
before phase 6 calls it. A reviewer reading in order never meets a call to
something that does not exist yet, and no row of the table above points
forwards. Phases 7 and 8 are leaves — nothing depends on either — so their
order between themselves carries no meaning.

One consequence worth stating plainly: phases are not independently *runnable*.
Phase 1 alone gives you models nothing uses; phases 1–3 give you a CHF that
nothing talks to; phases 1–6 give you a working core with no provisioning UI and
no idle-quota reclaim. They are units of review, not release increments.

### 13.3 What is checked on every regeneration

The patches are generated from the branch, never edited by hand, and four
invariants are verified each time:

1. **Coverage** — the set of files changed since the base equals the set of
   files across the eight patches. Currently 695 files, 0 mismatches.
2. **No duplication** — no file appears in two patches.
3. **Applies to a pristine tree** — all eight apply to a clean checkout of the
   recorded upstream commit, in order, with no fuzz.
4. **Reproduces the branch exactly** — every file in the patched pristine tree
   is byte-compared against the branch. 0 differences.

A fifth check is specific to this work: **no added or removed line in the patch
set touches `sess->gy`**, which is how "the CHF does not touch Gy" stays a
checkable fact rather than an intention.

```bash
cat patches/*.patch | grep -cE '^[+-].*sess->gy'   # 0
```

Two `sess->gy` lines do appear in phase 3, as *context* — unchanged Gy code
shown around our hunk in `n4-handler.c`, because the CHF branch sits directly
above Gy's own `switch` in that function. That is the evidence working, not
failing: the diff shows our code placed beside Gy's and leaving every one of its
lines alone. A plain `grep -c` over the patches counts those two, so the check
has to be on `^[+-]` or it measures the wrong thing.

### 13.4 Why this helps a reviewer

**Each patch has one question to answer, and one reviewer who can answer it.**

| Patch | The question | Who should read it |
|---|---|---|
| 1 | Is the generator wired the way upstream wires the other specs, and do the three schema renames leave every other NF's models untouched? | Core maintainer — 414 files, but only about forty lines are hand-written |
| 2 | Is the shared library change safe for every NF, not just the CHF? | Core maintainer — smallest patch, highest blast radius |
| 3 | Is the charging logic right — quota arithmetic, cycle handling, the records? | Charging / BSS |
| 4–6 | Does the SMF do the right thing at the right moment, and is the EPC path untouched? | SMF / session maintainer |
| 7 | Are the APIs and the UI correct, and can they corrupt the CHF's counters? | Web / BSS integration |
| 8 | Does the new idle timer measure and report what it claims, and can it disturb a session that is busy? | UPF / user-plane maintainer |

**Generated code is quarantined.** Phase 1 is by far the largest patch and the
least to read: 414 files, of which all but the `generator.sh` line and the
`patched/` spec diff come out of openapi-generator. Keeping it apart is what
lets phase 2 — the hand-written shared-library change every NF links — stay at
396 lines and get the close reading it deserves.

**Blast radius is visible from the size.** Phase 2 is 396 lines and touches code
every network function links — so it gets the closest reading. Phase 8 is
smaller still at 151 lines, but it runs in the forwarding path's accounting, so
it is read for what it does to a session that is *not* idle as much as for what
it does to one that is. Phase 7 is the largest hand-written patch, but it is
entirely in `webui/` and cannot affect a running core; most of its bulk is a
lockfile that a reviewer can skip in one decision rather than one line at a
time.

**The riskiest property is checkable, not argued.** "This does not disturb EPC
charging" is not a claim in a commit message; it is `cat patches/*.patch | grep
-cE '^[+-].*sess->gy'` returning 0 and `gy-path.c`/`gy-handler.c` showing zero
changes. A reviewer can confirm it in one command.

**Upstream review is possible at all.** Eight focused patches against a named
commit are something an upstream maintainer can take, reject or take in part —
phase 1 could land alone as spec coverage that needs no CHF at all, phase 2 on
top of it, phases 1–6 without the UI, phase 8 on its own merits as a PFCP
feature upstream lacks. A single 531-file branch offers only accept or
reject.

**Rebasing stays honest.** When upstream moves, the branch is replanted and the
patches regenerated and re-verified against the new base. The last replant moved
three upstream commits (`aaddc921d`, `9ea1af417`, `eae00c996` — a zero-length
ULI IE rejection, a GTP bit-rate octet order fix, and a QoS-flow comparison in
`src/smf/binding.c`) with no conflicts, and **not one patch file changed** —
not even a hunk offset. That is the cleanest form of the signal that upstream
changed nothing this work depends on; the replant before it moved two `lib/sbi`
commits and shifted a single patch's offsets by six lines.

### 13.5 Applying and re-verifying

```bash
# apply to a clean checkout of the recorded base
for p in patches/chf-phase-*.patch; do git apply --whitespace=nowarn "$p"; done

# what the regeneration checks: coverage, duplication, apply, byte-compare
git diff --name-only <base> HEAD \
  | grep -vE '^(patches/|docs/|CHF_(DEVELOPMENT_PLAN|TECHNICAL_OVERVIEW)\.md$)' \
  | sort > /tmp/changed
cat patches/*.patch | grep '^diff --git' | awk '{print substr($3,3)}' | sort > /tmp/in-patches
comm -3 /tmp/changed /tmp/in-patches    # must be empty
```

**`--whitespace=nowarn` is not cosmetic, and `--whitespace=fix` must not be
used.** Applied without the flag, phase 1 reports whitespace warnings — five
lines, then `squelched 1008 whitespace errors` and `1013 lines add whitespace
errors`. They are expected, and they are confined to phase 1; phases 2 through
8 are silent. Phase 1 is the generated-code phase, and every offending line
comes from something we do not write by hand:

| Origin | Lines |
|---|---:|
| `cdr-r19.6.0/standard/` — pristine 3GPP Forge modules | 499 |
| `lib/asn1c/cdr/` — `asn1c` output and its runtime skeletons | 228 |
| `lib/sbi/openapi/` — openapi-generator output | 201 |
| `cdr-r19.6.0/modified/` — `closure.py` output | 37 |
| `cdr-r19.6.0/patched/` — ours, but copied verbatim from the spec | 6 |

The six in `patched/` are byte-identical to the lines they were copied from in
`standard/` — space-before-tab in four ASN.1 type headers, one in a copied
`ENUMERATED`, one in a copied comment. Keeping them is what makes "copied
verbatim apart from the comma" true and keeps a diff against `standard/`
showing only the intended change.

Three modes, and only one is right:

- `--whitespace=nowarn` (what the command above uses): exits 0, silent, tree
  byte-identical to the branch.
- **default (`warn`)**: exits 0 and applies correctly — the warnings are
  noise, not a failure. Verified: all eight patches exit 0 and all 695 files
  come out byte-identical.
- `--whitespace=error`, or `apply.whitespace=error` in the user's git config:
  **exits 128 and phase 1 does not apply.** If a clean checkout refuses the
  patch, check that setting first.
- `--whitespace=fix`: exits 0 and **silently rewrites 448 files**, stripping
  whitespace from generated code and from the pristine 3GPP modules. The tree
  then matches neither the branch nor what `generator.sh` reproduces, and
  invariant 4 fails. Never use it here.

Fixing the whitespace at source is not an option worth taking: it would mean
either editing generated files, which the next regeneration would undo, or
altering the pristine spec modules, which exist precisely to be unaltered.

### 13.6 What the invariants cannot catch

The five invariants are about the patch chain, not about the code: they prove
that every change is carried, carried once, applies to the recorded base
without fuzz, reproduces the branch byte for byte, and leaves Gy alone. On the
replant onto `310fea94e` all five passed, the unit suite passed, the build
installed — and the CHF segfaulted on its first NF heartbeat.

The cause is structural, and it will recur. Upstream's commit "avoid stale
pointers in NF timers and subscription responses" changed what `lib/sbi` puts
in `e->h.sbi.data` for an SBI timer: a pool id instead of a pointer, so a
timer firing after its NF instance was freed cannot dereference it. Upstream
updated every NF it maintains, and `src/smf/smf-sm.c` picked the change up
through the merge because upstream owns that file. **Nothing updates
`src/chf`.** The CHF went on treating the id as a pointer, dereferenced a
small integer, and died at
`ogs_assert(OGS_FSM_STATE(&nf_instance->sm))` — about thirty seconds into
every run, once per heartbeat interval.

So the hazard of maintaining an NF out of tree is not merge conflicts, which
git reports, but silent contract drift, which it does not. A conflict is
upstream and our change touching the same lines; this was upstream changing
the meaning of a field we read, in a file we do not share. The patch chain was
in perfect health throughout.

Three timer sites now look the object up and drop the event when it has
already gone — the NF instance timers and both subscription timers — while the
response path still carries a pointer, because that is what upstream left
there. `SBI-17` pins the contract itself: a pool id round-trips through
`OGS_UINT_TO_POINTER`, and an unallocated id resolves to NULL rather than a
wild pointer. The next change to it fails a test instead of crashing a daemon.

Two practical consequences for a replant:

- **Run the daemon, not just the suite.** The crash needed thirty seconds of
  uptime and no traffic at all. A build that installs and a suite that passes
  say nothing about it.
- **A crash voids the run it happened in.** Results gathered from a rig whose
  CHF was dying and restarting are not evidence of anything; the 2026-10-20
  entry in §10 is a clean re-run, not a continuation.

---

## 14. Appendix — where things live

| Path | Contents |
|---|---|
| `src/chf/` | The CHF: `nchf-handler.c` (the service), `context.c` (quota and bucket logic), `db-handler.c` (MongoDB), `cdr-path.c` (records), `metrics.c`, `sbi-path.c`, `chf-sm.c` |
| `src/smf/nchf-build.c`, `nchf-handler.c` | The SMF's charging client: request building, grant handling, URR programming |
| `src/smf/n4-handler.c` | CHF accounting from PFCP reports, kept apart from Gy's |
| `src/smf/gsm-sm.c`, `namf-handler.c`, `gsm-build.c` | Release on exhaustion, refusal with back-off |
| `src/chf/notify-path.c` | ChargingNotify: the queue poller and the outbound request |
| `lib/sbi/` | CHF NF profile and SUPI-range discovery |
| `lib/pfcp/`, `src/upf/context.c` | Quota Holding Time: the IE on Update URR, and the UPF's idle timer |
| `webui/server/tmf/` | The TM Forum APIs |
| `webui/src/{components,containers}/Chf*` | The CHF Quota and CHF Sessions pages |
| `tests/chf/` | Unit suites, plus `test-chf-api.sh` for a live CHF |
| `lib/sbi/openapi/model/charging_*` | TS 32.291 models from openapi-generator |
| `lib/sbi/support/r19-.../` | The spec bundle: `standard/` → `patched/` → `transform.py` → `modified/` → `generator.sh` |
| `patches/` | The eight phases, applied to upstream in order — generated models first |

The patch set and how it is split is described in §13.
