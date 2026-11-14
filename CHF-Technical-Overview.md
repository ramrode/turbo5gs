# Open5GS CHF — Technical Overview

**Status:** working implementation, not certified against any conformance suite
**Upstream base:** `39a8c771f` (Open5GS main)
**Change set:** 201 commits, 730 files (542 of them generated C), eight patch phases in `patches/`
**Last verified:** 2026-11-14 on macOS for the ChargingNotify change of that day, which lets several CHFs share the queue: a new test with two CHFs, 18 of 18, also under ASan + UBSan. 2026-11-13 on `39a8c771f` — the UERANSIM regression on a two-VM rig, including a SIM swap with the UE's sessions up, 5G slicing, well-known DNNs, `ctf.enabled: yes`, a frozen CHF, UPF restarts under charged sessions, a full CHF session pool and a real dedicated QoS flow: per-slice balances isolated, CDRs decoded back from BER, live ChargingNotify, the over-the-wire API suite 55/55, a clean shutdown, 0 CHF errors. Upstream's suites 14 of 14 with the CHF in their test harness. A build and the unit tests after every patch, and ASan + UBSan, on macOS. The chain walked live, one patch at a time, on the same base on 2026-11-11. A plain `meson test` that day passed everything but upstream's `core` timer test and, once, `transfer`: neither touched by the patches, and neither reproduced against them

This describes what the Charging Function does today, what of 3GPP and TM Forum
it implements, what it can carry, where it stops, and what would come next. It
supersedes the earlier `CHF_TECHNICAL_OVERVIEW.md` at the repository root,
which described a per-subscriber quota with charging state shared with Gy.
That document was deleted in session 58, once everything still true of it
lived here; it remains in git history for anyone tracing why the early
decisions were made.

For the northbound API in detail, see [CHF-TMF-API.md](CHF-TMF-API.md). For every
metric, see [CHF-Metrics.md](CHF-Metrics.md). For what each patch contains and
whether Open5GS still works after it, see
[patches/README.md](../patches/README.md). For installing and running a CHF, see the
user's guide, [_docs/guide/04-chf.md](_docs/guide/04-chf.md).

---

## 1. What it is

A 5G Charging Function: a network function that decides how much data a
subscriber may use, tells the SMF, counts what is used, and writes a record when
the session ends. It speaks **Nchf_ConvergedCharging** (TS 32.291) to the SMF
over SBI, and is provisioned through **TM Forum Open APIs** served by the WebUI.

Three pieces, in one repository:

| Piece | Where | Size | Role |
|---|---|---|---|
| **CHF network function** | `src/chf/` | ~8,300 lines | Serves Nchf_ConvergedCharging, owns quota decisions, writes CDRs |
| **SMF charging client** | `src/smf/nchf-*`, plus wiring | ~1,470 lines + hooks | Asks the CHF for quota, programs the UPF, reports usage |
| **Provisioning** | `webui/` | TMF APIs + two pages | Buckets, accounts, parties, top-ups |

A fourth, small piece lives in `lib/sbi/`: a CHF's NRF profile carries a
`supiRangeList`, so an SMF can discover the CHF that serves a given subscriber
(TS 29.510 §6.1.6.2.9).

It is packaged like the other network functions: a systemd unit, a Debian package
(`open5gs-chf`, optional, as the EIR's is), a section in every test config and a place
in upstream's test harness, a demo TLS certificate, and a user's guide.

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

### Well-known DNNs

`ims`, `sos` and `mcptt` carry IMS, emergency and mission-critical traffic, so whether
they work must not depend on a subscriber's balance or on the charging system being
healthy. Whatever the slice or roaming state, they are outside quota management. The
match is on the DNN's Network Identifier and ignores case, so `IMS` and
`sos.mnc070.mcc999.gprs` count, and `imsx` does not.

| | Ordinary DNN | `ims`, `sos`, `mcptt` |
|---|---|---|
| Bucket lookup | Yes | None, so a bucket scoped to one of them is never charged |
| Empty balance, or `unprovisioned: reject` | Refused | Set up anyway |
| Usage | Adds to a counter | Adds to nothing, and uses up no other session's allowance |
| Exhaustion and final unit | Yes | Never |
| ChargingNotify, including `ABORT_CHARGING` | Reaches the session | Never reaches it |
| The CHF refuses or does not answer a Create | Session refused | Session set up uncharged |
| CDR | Yes | Yes, unless `charging.well_known_dnn.cdr` is off |

Such a session still goes through the CHF, which grants it a slice at a time, so the SMF
keeps reporting and the CDR has its volumes. `ctf.bypass_well_known_dnn` in `smf.yaml`
skips the CHF altogether: no Create, no reports and no CDR. The CDR covers the whole
session, including its dedicated QoS flows, so a VoNR call's media is in the volumes.

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
| | `ims`, `sos` and `mcptt` outside quota management, whatever the slice or roaming state, with a toggle for their CDRs in the CHF and one to bypass the CHF in the SMF |
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
| **Provisioning** | TMF632 Individual, TMF666 BillingAccount, TMF654 Bucket + TopupBalance, and a SimSwap extension |
| | WebUI pages: CHF Quota (buckets) and CHF Sessions (live) |
| | Idempotent top-ups; conditional writes against the live counter |
| | SIM swap: every bucket of one SUPI moved to another with its counter, all or nothing, never merged |
| | A top-up, plan change, deprovision or SIM swap queues a ChargingNotify for live sessions |
| **Operations** | 26 Prometheus metric families, plus one from the WebUI ([reference](CHF-Metrics.md)) |
| | NRF registration with `supiRangeList` for CHF selection by SUPI |
| | NRF registration with `allowedNssais` for CHF selection by slice, so one CHF can be dedicated to a slice and another to a SUPI range |
| | Start-up migration of pre-bucket documents |
| | Requests checked before use: a malformed SUPI, or a `pduSessionID` or `sst` out of range, gets 400; a full session pool gets 500 `INSUFFICIENT_RESOURCES` |
| | Packaged like the other NFs: systemd unit, optional Debian package, demo TLS certificate, a section in every test config and a place in the test harness |
| **User plane** | UPF Quota Holding Time timer, so an idle session reports once and releases the rest |

---

## 5. 3GPP compliance

Field names and enumerations are taken from the 3GPP OpenAPI shipped in this
tree (`lib/sbi/support/r19-20260402-openapitools-7.20.0/standard/TS32291_Nchf_ConvergedCharging.yaml`, as published), not from
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
| **Transport** | Cleartext HTTP/2 (h2c) as Open5GS uses between NFs; TLS is available from `lib/sbi` configuration | An SMF-to-CHF exchange over TLS, and OAuth2, not run. The CHF serves HTTPS with its demo certificate |

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
`generator.sh`. Adding that line yields 199 new models —
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
`patched/` diffs (the `Charging*` renames and two enum fixes among them), run
`transform.py` and `generator.sh`, sync `meson.build`, and fix whatever the
compiler complains about. That is the whole point of doing it this way.

**Seventeen more models would have changed shape the same way,** because
TS 32.291 is generated last and its `$ref` chain reaches different definitions
of names already in use: `Tai`, `Point`, `PduSessionInfo`, `Trigger`,
`TransportProtocol` and the geographic family. They have `Charging*` names in
`patched/` too, so patch 1 adds models and changes none, and every existing
model is byte-identical to upstream's. After a regeneration,
`git diff --diff-filter=M <base> -- lib/sbi/openapi/model` must print nothing.

Not all of them could be a plain rename. `Trigger` stays as published beside
`ChargingTrigger`, because TS 29.502 reaches it. TS 29.520 and TS 29.571 are
shared with other NFs' runs, so what TS 32.291 needs from them is copied into its
own file under `Charging*` names, and `UserLocation` and `N3gaLocation` are copied
only because they lead to `TransportProtocol`. The copies are separate C types: a
charging message carries an `OpenAPI_charging_user_location_t`, so code that fills
one in has to build that type. `patches/README.md` lists each definition and how
it is kept apart.

---

### 5.2 How the TS 32.298 CDR codec is produced

The CDR encoder is generated too, by the same `asn1c` that produces NGAP and
S1AP. That is `mouse07410/asn1c`, the build `lib/asn1c/support/README.md` pins.
The original, `vlm/asn1c`, cannot generate this codec as it stands: it has no
`-fprefix`, which the `CHFCDR_` names come from, and its only codec switches are
`-no-gen-OER` and `-no-gen-PER`. The bundle has the same shape as NGAP's:
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

**One ChargingNotify queue for every CHF.** A change on 2026-11-14. All the
CHFs of a deployment share `chf.notifications`, and a row does not say which
of them holds the subscriber's sessions: with one CHF per slice, a subscriber
on two slices has sessions on two. Until then each CHF read up to 64 rows and
deleted them, delivered or not, so whichever polled first took every row, and
the sessions on the other CHF missed the top-up or the abort. Now no CHF
deletes a row on reading it. Each adds its NF instance id to the row's
`seenBy` before it delivers anything, never reads that row again, and so
delivers each row at most once. A row is deleted five minutes after the first
CHF read it, or three polls if that is longer. A CHF ignores the rows queued
before it started, by marking them at start-up: it holds no session then, and
the sessions it sets up read the balance at Create. A malformed row is now
marked like any other, so it is logged once, not on every poll.

---

## 6. TM Forum compliance

| API | Resource | State |
|---|---|---|
| **TMF632** Party Management v4 | `individual` | CRUD, filtering, projection, JSON Merge Patch |
| **TMF666** Account Management v4 | `billingAccount` | CRUD, `relatedParty` validation, delete guards |
| **TMF654** Prepay Balance Management v4 | `bucket` | CRUD; `@type: ChfDataBucket`, `@baseType: Bucket`; extension attributes for the plan and the scope |
| **TMF654** | `topupBalance` | Create and read; immutable records (405 on modify); `Idempotency-Key` enforced by a unique index |
| Extension in the TMF654 namespace | `simSwap` | Create and read; a TMF630 task resource that names its two ends as TMF654 TransferBalance does; immutable records; `Idempotency-Key`; all or nothing across a subscriber's buckets, with a lock that keeps two swaps of one SIM apart |
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
    well_known_dnn:
      cdr: true               # CDRs for ims, sos, mcptt; never quota-managed
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

On the SMF side, `smf.yaml` has the matching toggle. It defaults to `false`, so these
sessions reach the CHF and get CDRs:

```yaml
smf:
  ctf:
    enabled: auto                  # or yes (a CHF is required), or no
    bypass_well_known_dnn: false   # true: ims, sos, mcptt skip the CHF; no CDR
```

`ctf.enabled` decides what no CHF means for a 5GC session. With `auto`, the default, it
runs uncharged. With `yes` it is refused with `NETWORK_FAILURE`, while `ims`, `sos` and
`mcptt` are still set up. With `no` the CHF is never used.

`unprovisioned` applies when a subscriber has no bucket, or none covering the
session. If MongoDB cannot be read at all, the CHF grants `default_quota` even under
`reject`. That is deliberate: an outage says nothing about whether a subscriber is
provisioned, and refusing on it would refuse everyone until MongoDB returned. The
WARNING tells the two apart ("Subscriber lookup failed" against "Not provisioned"),
and `chf_quota_lookup_total{source="default"}` counts both.

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
/api/tmf-api/prepayBalanceManagement/v4/simSwap[/{id}]
```

**Storage** — MongoDB, alongside the rest of Open5GS:

| Collection | Written by | Contents |
|---|---|---|
| `chf.subscribers` | WebUI/TMF (plan, scope, priority), CHF (counter) | One document per bucket |
| `chf.sessions` | CHF | Live sessions |
| `chf.cdrs` | CHF | Index of CDR files |
| `chf.notifications` | WebUI/TMF (writes); every CHF reads each row once, and they are deleted five minutes after the first read | ChargingNotify queue |
| `tmf.individuals`, `tmf.billingAccounts` | WebUI/TMF | Parties and accounts |
| `tmf.topupBalances`, `tmf.simSwaps` | WebUI/TMF | Audit records of top-ups and SIM swaps. A running swap's record also holds its two SIMs under a unique index |

**Metrics** (Prometheus, port 9090): 26 families covering requests, sessions, quota,
ChargingNotify, CDRs, MongoDB and errors, all with bounded labels.
[CHF-Metrics.md](CHF-Metrics.md) lists each one with its labels and values, and
suggests alerts.

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
  4,096 with the shipped `max.ue: 1024`. Beyond it, Create returns 500 with cause
  `INSUFFICIENT_RESOURCES`, and the refusals are counted, not fatal. What the SMF
  then does with the session is limitation 9.
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

**In the test harness** — upstream's 5G suites start a CHF from their test config, so a plain `meson test`, which is what
CI runs, exercises one. `no_chf: true` under `global.parameter` leaves it out, and the test configs keep no CDRs.

**Unit** — `meson test -C build --suite chf`: two tests, no network or database
needed.

`chf-unit` is 7 suites, 83 cases: quota arithmetic and reviving a recharged session, the CDR writer (paths,
field names, the json/asn1/both switch, aggregated filing against both
thresholds for each encoding, and that a BER aggregate is a concatenation of
whole records), the TS 32.298 record itself (which fields a session becomes,
the `[200]` tag the encoding opens with, a BER round-trip, volumes past 2^32,
all three closing causes, the SliceDifferentiator octets and the BCD
TimeStamp),
SUPI-range matching and slice-restricted CHF selection, how long a ChargingNotify queue row is kept, grant shaping
including the quota holding time, bucket scope and priority, and the
metric spec tables.

`chf-cdr-decode` is the one test that can say the JSON mirrors the BER,
because it compares them through something that shares no code with either:
`chf-cdr-emit` writes both encodings of the same sessions, and
`open5gs-chf-cdr-decode` — generated from the ASN.1 module, not from the
CHF's C — decodes the BER back. The two JSON documents must then be equal.
It also concatenates the BER files and checks every record still decodes,
which is what aggregation depends on.

**Over the wire** — `tests/chf/test-chf-api.sh`, 55 checks against a running
CHF and MongoDB over cleartext HTTP/2, in the request shape of TS 32.291:
Create/Update/Release and their status codes, the session and CDR documents,
provisioned and default quota, recharge before and after exhaustion, admin
raise and lower mid-session, cross-session aggregate exhaustion, malformed and
unparseable requests, an out-of-range `pduSessionID` or `sst`, a malformed SUPI, well-known DNNs, NRF registration and discovery, and quota
provisioned through the WebUI. It is not a meson test, because it needs a live CHF; that is
also why it has rotted twice. In session 54 its CDR assertions still expected
the flat pre-TS 32.298 record. By 2026-10-29 every request body it sent
predated the R19 model's four mandatory members, so the first Create got 400
and 29 of its 42 checks failed. Six of its quota cases also compared quotas
that grant shaping makes indistinguishable: four could not pass and two could
not fail.

That second rot hid a real CHF defect. With the script unable to run, nothing
exercised the case it existed for, and a session revived by a recharge after
exhaustion had stopped being revived. Both are fixed (see the 2026-10-29
entry below), and each quota case now sizes its plan from the grant cap it
reads off the CHF, then asserts the exact grant it expects. All of its checks pass
on the rig, 55 of 55 at the last round, and the two cases that pin the CHF fixes are
known to fail on the binary without them.

**A dedicated QoS flow** — `tests/chf/test-dedicated-flow.sh`, run as root from the build
directory. UERANSIM cannot test this: the UPF ignores a dedicated flow's downlink PDR until
the gNB answers the N2 modify, and UERANSIM's gNB does not, so its traffic stays on the
default flow whatever the PCC rules say. The script runs upstream's `vonr` `qos-flow-test`,
whose simulated gNB does answer, charged by the CHF the test harness starts, and checks the CDR: 2 pings on each
flow at 28 bytes each must read 112 each way, where 56 means the dedicated flow went
uncounted.

**Two CHFs, one queue** — `tests/chf/test-notify-two-chfs.sh`, from the build directory,
with MongoDB and the WebUI's `npm install`, whose MongoDB driver it uses. Two CHFs and an
NRF on loopback, against a database of their own that it drops afterwards. One SUPI has a
session on each CHF, as a subscriber on two slices would, and another has one on the second.
18 checks: each CHF reaches its own sessions, once; a restarted CHF ignores rows queued
before it started and hears the ones after; rows go only once they are old enough; and a
malformed row is read once. On the CHF from before the fix it fails 9 or 10 of them,
depending on which CHF polls first.

**WebUI** — 178 tests (plus 16 that run only against a real MongoDB): TMF
conventions, bucket scope, top-up idempotency and races with the CHF counter,
guards that stop the UI rewinding the usage counter, the ChargingNotify
queue — what gets queued on a top-up, a plan change, a deprovision and a SIM
swap, and that a queue failure never fails the request that moved the balance —
the bucket id a subscriber created through the WebUI's own REST resource is
given, and the SIM swap: that everything moves and nothing changes, that a move
failing part-way puts the rest back, that two swaps sharing a SIM cannot run at
once, and that an interrupted swap is undone, by one request only.
The sixteen opt-in tests run with `CHF_TMF_MONGO_URI` set, each file in a
database of its own that it drops afterwards: thirteen for the TMF API, seven
of them for the SIM swap, and three for `/api/db/ChfSubscriber`.

**End to end on the rig** — two VMs, the full core on one and UERANSIM on the other.
A regression round today is:

| Part | What it covers |
|---|---|
| The build | the eight patches applied to a pristine base on the VM, their checksums compared with the commit, and the binaries checked for the newest code |
| Twelve feature tests | one UE holding `ims`, `sos`, `mcptt` and `internet`: empty buckets, the well-known-DNN CDR toggle, the SMF bypass, a CHF frozen during attach, a CHF that serves another slice, the four `ctf.enabled` cases, PCC rules on a charged session, a real dedicated QoS flow, and the whole `vonr` binary charged by the harness's CHF |
| The regression proper | one UE on two slices, each with its own bucket: isolation from the catch-all, live ChargingNotify, both buckets cut at quota, every JSON CDR compared with its BER record, the API suite's CDR assertions on a live record, the metrics, and the error count of every NF |
| Around it | the API suite over the wire, a shutdown with a populated metrics table, the WebUI's opt-in tests on the rig's MongoDB, and upstream's 14 suites one at a time |
| Failures | three UPF restarts under two charged sessions, and a full CHF session pool |
| A SIM swap | with the UE's two sessions up, its balance moved to another SUPI and back: the counters travel, the old sessions are released by `ABORT_CHARGING`, and sessions on the default quota move to the catch-all on `REAUTHORIZATION` |

Two more are run when asked for: the chain walked one patch at a time with live traffic, and
a plain `meson test`. The result of each round is a dated record below, newest first.

**The original baseline** — an eleven-case regression with UERANSIM against the
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

**ChargingNotify with several CHFs (2026-11-14).** The CHF's reader of `chf.notifications` changed, as §5.3
describes, on the same base. Tested on macOS. It has **not** run on the rig yet.

| Check | Result |
|---|---|
| `test-notify-two-chfs.sh`, two CHFs on one queue | **18 / 18**, three runs. Also 18 / 18 with both CHFs and the NRF built with ASan + UBSan: 0 sanitizer reports |
| The same test on the CHF before the change | 9 and 10 failures in two runs. The first CHF to poll took both rows, so the sessions on the other CHF were never notified, and which CHF won changed between runs |
| ChargingNotify to a real HTTP/2 listener | a top-up's `REAUTHORIZATION` and a SIM swap's `ABORT_CHARGING`, each delivered once |
| Unit | 7 suites / 83 cases, one new for how long a row is kept; clean under ASan + UBSan, with the canary firing |
| Per patch | all 9 states build on mongo-c-driver 2.5.3, with `core`, `crypt` and `unit` passing and the CHF's tests from phase 3 |
| The rest of the macOS QA | the API suite 29 passed, 0 failed, 25 skipped; ten SIGTERM cycles clean; a full pool refused with 500 and the CHF still up; malformed SUPIs 400; the guide's `Create` 201 then 204; fresh-database indexes with no warning; the WebUI's 178 and 16 opt-in tests |

What an operator sees differently: rows now stay in `chf.notifications` for five minutes after the first CHF read them,
with `seenBy` and `seenAt` added. A check that expects the queue to be empty straight after a poll should count the rows
with no `seenBy` instead. And a CHF ignores the rows queued while it was down.

**A SIM swap, and a third round on `39a8c771f` (2026-11-13).** Later the same day. Two patches changed: patch 7
gained the SIM swap endpoint, and patch 3's user guide a few lines on it. The rig ran the whole round on the new set, and
a new test with the UE.

| Regression, complete set, on the rig | Result |
|---|---|
| Patch set | all eight on a pristine `39a8c771f`, no fuzz, checksums matching the commit, and the binaries checked for the new code |
| WebUI | **178** tests, and the **16** opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 0 failed, queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 62,993,136 of 60 MB, `slice1sd2` 42,131,178 of 40 MB, both `volumeLimit` |
| Encodings agree | **83 of 83**: every CDR in that day's directory |
| Live TC-12 | PASS |
| Over-the-wire API suite | **55 / 55**, leaving `chf.subscribers` as found |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Errors | CHF **0**, SMF **0**, UPF 5 (GTP-U error indications), AMF 281, exactly the 283 bucket selections less the 2 that succeeded |
| Upstream's suites, with the CHF in their harness | **14 of 14** under random `MALLOC_PERTURB_` |
| The whole `vonr` binary, charged by the harness's CHF | all pass, 51 CDRs, 0 CHF error lines |
| `test-dedicated-flow.sh` | 10 of 10 |
| UPF restart under two charged sessions, 3 runs | as before: the CHF held 2 sessions each time, each replaced session was released with a final report of 0 and a CDR, and the new sessions were charged, 3.30 to 3.39 MB each. SMF 12, 18 and 18 lines: the PFCP restart, the failed restoration, and the PCF delete race on one session in the first run and on both in the others |
| Full CHF session pool | the order of the earlier runs, not of the second round: `mcptt` took the last slot, `internet` was refused (the UE saw 14 `NETWORK_FAILURE`), and `ims` and `sos` came up uncharged with a warning each. With the three direct sessions released, all four came up |

*A SIM swap with the UE.* The UE stays `imsi-999700000000001`. Its three buckets were given used counters first, 100 MB
on the catch-all, 10 MB on `slice1sd1` and 5 MB on `slice1sd2`, and the swap ran through the TMF router from the replanted
WebUI source, on its own port beside the WebUI service, which was left alone.

| Step | Result |
|---|---|
| Swap to `imsi-999700000000099` with both sessions up, 3 MB pulled on each | **201**; all three buckets moved, ids rewritten (`-slice1sd1` kept its suffix), counters 100, 10 and 5 MB on the new SUPI, none left on the old |
| What the sessions heard | `ABORT_CHARGING` sent 2, 0 failed; the SMF released both. Their CDRs: 3.13 and 3.19 MB, `managementIntervention` |
| The moved balance after their final reports | unchanged at 100, 10 and 5 MB: the documented limit, one grant per session at most |
| The UE asked for its sessions again at once | both set up on the **default quota**, since the old SUPI had no bucket |
| A second swap of the old SUPI | **404**, recorded as failed |
| Swap back, with those two sessions up | **201**; `REAUTHORIZATION` sent 2; the SMF reported at once for both, and the CHF moved both to the plan |
| 3 MB more, then the UE left | counted to the **catch-all**: 103.14 MB. The slice buckets stayed at 10 and 5 MB, since a session moved mid-session goes to the catch-all (limitation 8) |
| Afterwards | the queue empty, `PATCH` on a record 405; the records, the extra collection and the buckets put back as found |

The SMF logged 16 lines in the swap's window: two occurrences of the PCF delete race, as the UE asked for each session
again 200 ms after the abort released it, and the SMF dropped the old session with its PCF delete still in flight. The CHF
had already closed both. The swap test ran on the same rig straight after the round, before the gNB was put back.

On macOS, with the same patches: all 9 states build on mongo-c-driver 2.5.3 when applied one at a time, with `core`,
`crypt` and `unit` passing and the CHF's tests from phase 3. On driver 1.30 under ASan + UBSan: **0 reports**. The API
suite against a local CHF: 29 passed, 0 failed, 25 skipped. Ten SIGTERM cycles: 10 of 10 clean. The user guide's
`Create` example: 201, then 204. The WebUI's 178 and 16 opt-in tests. And the swap end to end against a local CHF, with
requests in place of the SMF: a bucket with a 200 MB top-up and 30 MB used arrived whole on the new SUPI, a repeat with
the same key got 200 and one without got 404, the old session's later 15 MB went to its CDR and not to the balance, and a
session already up on the new SUPI was moved to the plan by `REAUTHORIZATION`.

Not run in this round: the live walk and a plain `meson test`, which last ran on this base on 2026-11-11, before the SIM
swap.

**A second round on `39a8c771f` (2026-11-13).** Upstream had not moved, so there was no replant, and the patches
are the ones the 2026-11-11 round tested, byte for byte. The macOS QA and the rig regression were run again in full.

| Regression, complete set, on the rig | Result |
|---|---|
| Patch set | all eight on a pristine `39a8c771f`, no fuzz, checksums matching the commit, and the binaries checked for the new code |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 0 failed, queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 63,006,916 of 60 MB, `slice1sd2` 42,069,462 of 40 MB, both `volumeLimit` |
| Encodings agree | **17 of 17**: every CDR in that day's directory |
| Live TC-12 | PASS |
| Over-the-wire API suite | **55 / 55**, leaving `chf.subscribers` as found |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Errors | CHF **0**, SMF 8 (the PCF delete race), UPF 13 (GTP-U error indications), AMF 280, exactly the 282 bucket selections less the 2 that succeeded |
| Upstream's suites, with the CHF in their harness | **14 of 14** under random `MALLOC_PERTURB_` |
| The whole `vonr` binary, charged by the harness's CHF | all pass, 51 CDRs, 0 CHF error lines |
| `test-dedicated-flow.sh` | 10 of 10 |
| UPF restart under two charged sessions, 3 runs | the CHF held 2 sessions each time, and each replaced session was released with a final report of 0 and a CDR. The new sessions were charged, 3.28 to 3.36 MB each. SMF 12 lines each run, as before |

*The full pool, the other way round.* In every earlier run the UE's `internet` request met the full pool and was
refused. This time it arrived first and took the last slot:

| | Earlier runs | This run |
|---|---|---|
| The last free slot | a well-known DNN | `internet` |
| Refused by the CHF, 500 `INSUFFICIENT_RESOURCES` | `internet` and two well-known DNNs | `ims`, `sos` and `mcptt` |
| What the UE saw | `NETWORK_FAILURE` on `internet`, and retries | nothing: all four sessions up |
| Given the UE's one CHF session | a well-known DNN, which uses no balance | `internet`, charged as normal |
| Set up with no CHF session, each with a warning | two well-known DNNs | all three well-known DNNs |

Both are the designed behaviour. Which one happens depends on the order the four requests reach the CHF. Limitation 9
now says so.

The twelve feature tests gave the earlier results again. The SMF's 8 lines are one occurrence of the PCF delete race, as
a retry replaced a session after the quota cut. The gNB's config on the UE VM again advertised one slice. It was set to two
for the run and put back as found.

On macOS, with the same patches: all 9 states build on mongo-c-driver 2.5.3 when applied one at a time, with `core`,
`crypt` and `unit` passing and the CHF's tests from phase 3. On driver 1.30 under ASan + UBSan: **0 reports**. The API
suite against a local CHF: 29 passed, 0 failed, 25 skipped. Ten SIGTERM cycles: 10 of 10 clean. The user guide's
`Create` example: 201, then 204. The WebUI's 159 and 9 opt-in tests.

Not run in this round: the live walk and a plain `meson test`, which ran on this base and these patches on 2026-11-11,
in the record below.

**The chain walked live on `39a8c771f`, and a plain `meson test` (2026-11-11).** Later the same day, on the same base, with
the same patches. This was the first walk with the CHF in upstream's test harness, so from patch 3 on, the four suites run
at each step had one.

| After patch | Upstream's `registration`, `slice`, `vonr`, `attach` | Live, no CHF | Live, CHF running |
|---|---|---|---|
| 1, 2 | pass | 12 NFs, 126 MB, 0 errors | no CHF exists |
| 3, 4 | pass, with the CHF in the harness | 12 NFs, 126 MB, 0 errors | 13 NFs, 126 MB, 0 errors, **0 Creates** |
| 5 | `registration` hung once and was killed at 150 s; the other three pass | 12 NFs, 126 MB; SMF 8, the PCF delete race | 13 NFs, 126 MB, **0 Creates**; SMF 8, the same race |
| 6 | pass | 12 NFs, 126 MB, 0 errors | charged: `slice1sd1` 63,094,748 of 60 MB, then cut. AMF 95 (the refused retries), UPF 3 |
| 7 | pass | 12 NFs, 126 MB, 0 errors | charged: that run's first tunnel was `slice1sd2`, 42,175,686 of 40 MB, then cut. AMF 95, UPF 3 |
| 8 | pass | 12 NFs, 126 MB, 0 errors | charged: `slice1sd2` 42,090,390 of 40 MB, then cut. AMF 94, UPF 6 |

The patch-5 hang left no log, because the next test overwrote it. So the patch-5 tree was rebuilt, from a reset base
through patch 5, and `registration` was run 10 times there: 10 of 10. It also passed 5 of 5 on the complete set.

*A plain `meson test`, with no suite named,* ran twice on the complete set:

| Run | Result | What failed |
|---|---|---|
| 1 | 22 of 23 | `core`: timed out in `timer-test` |
| 2 | 20 of 23 | `core`, the same; `transfer`, which aborted; `transfer-error`, which followed from it |

- **`core` is upstream's `lib/core` suite**, which nothing in the patch set touches. `timer-test.c` line 70 asserts that a
  timer has not fired yet. It found that it had, because the poll woke late on a loaded VM, and the test then hung. Run
  alone it passed 2 of 5, and it passed on 2026-11-09 with identical `lib/core`.
- **`transfer` aborted when its simulated gNB could not connect to the second AMF** at `127.0.0.50`, under
  `MALLOC_PERTURB_=25`. `transfer-error` then could not bind the NRF's port, which the aborted run's processes still held.
  Under the same `MALLOC_PERTURB_=25`, `transfer` passed 5 of 5 with the CHF in its harness, and 5 of 5 with `no_chf`. It
  is one of the suites already known to be intermittent under that setting.

The CHF's tests and every other 5G and EPC suite passed in both runs. The first attempt to read the second run picked up
the first run's results, because the poll found the old done-marker before the new run had removed it. That run was then
waited for properly, and the rig subscriber restored after it.

**The `39a8c771f` replant and the regression (2026-11-11).** Four upstream commits, three in the MME and one in the
AMF, all about registration: ESM admission during Attach, a second PDN request kept out of the attach path, and an
Identity Response ignored when the identity is already known. None touches the charging path, and the CHF has no
identity procedure to share their faults. All eight patches came out **byte-identical**, the cleanest replant there is.

This was also the first regression with the CHF in upstream's test harness. Two harness changes followed from that:

- The whole-`vonr` test (T9) no longer starts a CHF of its own beside the binary. It runs on a copy of `vonr.yaml`
  that writes CDRs, and is charged by the harness's CHF.
- The API suite's default address is now `127.0.0.30`. The rig's installed `chf.yaml` stays on `127.0.0.16`,
  because an install never overwrites a config, so the regression names that address.

| Regression, complete set, on the rig | Result |
|---|---|
| Patch set | all eight on a pristine `39a8c771f`, no fuzz, checksums matching the commit, and the binaries checked for the new code |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 0 failed, queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 63,039,224 of 60 MB, `slice1sd2` 42,080,594 of 40 MB, both `volumeLimit` |
| Encodings agree | **17 of 17**: every CDR in that day's directory |
| Live TC-12 | PASS |
| Over-the-wire API suite | **55 / 55**, leaving `chf.subscribers` as found |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Errors | CHF **0**, SMF 2, UPF 8 (GTP-U error indications), AMF 291: 280 refusals, exactly the 282 bucket selections less the 2 that succeeded, and 11 lines from one request, below |
| Upstream's suites, with the CHF in their harness | **14 of 14** under random `MALLOC_PERTURB_`. They left 14 rows in `chf.sessions`, from charged sessions still open when the harness stopped its CHF, and the regression cleared them |
| The whole `vonr` binary, charged by the harness's CHF | all pass, 51 CDRs, 0 CHF error lines |
| `test-dedicated-flow.sh` | 10 of 10 |
| UPF restart under two charged sessions, 3 runs | the CHF held 2 sessions each time, and each replaced session was released with a final report of 0 and a CDR. SMF 12 lines each run, as before |
| A full CHF session pool | 500 `INSUFFICIENT_RESOURCES`, `internet` refused, the other DNNs up, and all four charged once slots freed |

*The SMF's two lines, and the AMF's eleven.* After the quota cut, the UE's retry replaced a session. A 5GSM message
for the old session then reached the SMF, which logged "Session has already been removed" and dropped it without
answering the AMF. That is upstream code, `bc3b27339` in `smf-sm.c`. The AMF's request timed out ten seconds later,
which is the other nine lines and the SMF's stream reset. The 2026-11-07 walk logged the same pair once, at patch 6.
It depends on timing, and it is upstream's to fix.

The twelve feature tests gave the earlier results again. The gNB's config on the UE VM again advertised one slice. It was
set to two for the run and put back as found.

On macOS, with the same patches: all 9 states build on mongo-c-driver 2.5.3 when applied one at a time, with `core`,
`crypt` and `unit` passing and the CHF's tests from phase 3. On driver 1.30 under ASan + UBSan: **0 reports**. The API
suite against a local CHF: 29 passed, 0 failed, 25 skipped. Ten SIGTERM cycles: 10 of 10 clean. The user guide's
`Create` example: 201, then 204. The WebUI's 159 and 9 opt-in tests.

Not run on this base: the live walk, and a plain `meson test` with no suite named, which passed on `5ff0dc56f`.

**The CHF packaged and tested like the other NFs (2026-11-09).** Later the same day, on the same base. What an upstream
NF such as the BSF has and the CHF lacked was added: a systemd unit, a Debian package, a section in all twelve
`configs/*.yaml.in`, a place in the test harness, a TLS certificate and a user guide in `docs/_docs/guide/`. The CHF moved
from `127.0.0.16`, which `configs/vonr.yaml.in` and nine example configs give to the AF, to `127.0.0.30`.

Two choices are worth recording:

- **The Debian package follows the EIR, not the BSF.** `open5gs` lists it under `Suggests`, because an SMF charges every 5G
  session once a CHF registers. In `Depends`, `apt install open5gs` or an upgrade would start charging every subscriber on
  the default quota.
- **The test configs keep no CDRs.** Every 5G test now runs a CHF, and a test run should not leave billing files behind.
  `test-dedicated-flow.sh`, which reads CDRs, runs on a copy of `vonr.yaml` that writes them.

| Check | Result |
|---|---|
| `meson test` on the rig, no suite named, as `meson-ci.yml` runs it | **23 of 23**: the unit suites, `chf-unit`, `chf-cdr-decode`, the EIR tests, and upstream's 5G and EPC suites |
| The CHF in those suites | up in 41 of 63 samples taken during the run, with rows in `chf.sessions` in 48. The EIR tests use configs of their own and run without one |
| `test-dedicated-flow.sh`, through the harness's CHF | 3 of 3: `ul=112 dl=112` in both CDRs |
| The generated test config, on macOS | the CHF starts from it, registers, reports CDRs off, and exits 0 |
| The certificate | verifies against `configs/open5gs/tls/ca.crt`. The CHF serves HTTPS with it, and registers with the NRF |
| Debian files | every source named in `debian/open5gs-chf.install` exists in the build. The package itself was not built |
| All 9 patch states on macOS | build, with `core`, `crypt` and `unit`, and the CHF's tests from phase 3 |
| ASan + UBSan, driver 1.30 | **0 reports** |
| API suite against a local CHF | 29 passed, 0 failed, 25 skipped |
| The user guide's `Create` example | 201, and the release 204 |
| WebUI | 159 tests, and the 9 opt-in tests |

The UERANSIM regression in the record below ran before this work, and was not repeated. Only patch 3 has changed since. One test in the rig's
regression still starts its own CHF beside `vonr`, and needs changing before the next round, since the harness now starts one.

**The `5ff0dc56f` replant, the CHF's SUPI check, and the regression (2026-11-09).** Twenty-seven upstream
commits, no conflicts. This round also gave the renamed generated models and the restored Gy lines their first run on
the rig.

| Upstream | What it means for charging | Checked by |
|---|---|---|
| `8d6c52518` every NF validates a SUPI before using it | **The CHF did not**, fixed below | TC-ERR-6, on macOS and the rig |
| `6ebfdc93f` reverts `68ab28cd8`: closing an inbound stream no longer cancels the outbound transactions it started | A CHF Create can now be answered after the AMF's stream has gone. Before, it would have been cancelled, leaving nothing to end the wait in `wait_5gc_nchf_create`. Every function the response reaches accepts a NULL stream | Reading the code. Nothing here closes that stream on purpose |
| `36f1d63fb` `lib/dbi` ignores array entries past the maximum instead of asserting | Does the CHF share the fault? No: `chf_db_load_buckets()` already stops at 16, with a warning | Reading the code |
| `e3659f1a9` the AUSF survives outbound SBI failures | ChargingNotify already checks its send result. The SMF's CHF sends keep the `ogs_assert(r != OGS_ERROR)` the rest of the SMF uses | Reading the code |
| `655198981`, `ed486ae1e`, `6a56d9bfe`, `ec325bef7`, `eef4f1033`, `e5f9820b8` PFCP and SMF bounds | They touch `lib/pfcp/build.c`, `src/smf/context.c` and `.h`, and `gsm-build.c`, which the patches also change, in other hunks | Every session came up, and `vonr` passes |
| The other 17: MME, AMF, S1AP, NAS, AUSF and UDM, PCF | Not charging, but every charged session registers first | `registration`, `attach`, `volte` and `csfb` pass |

*The CHF's SUPI check.* Nothing updates a new NF. Measured on a local CHF before and after:

| SUPI in a Create | Before | Now |
|---|---|---|
| `imsi-999700000000001`, `nai-user@example.com` | 201 | 201 |
| `not-a-supi`, `notasupi`, `imsi-`, `-999700000000001`, a letter in the IMSI, sixteen digits, a `-wk` suffix, a `/../../x` suffix, an empty string | **201**, and the default 10 GB | 400 `Invalid SUPI`, counted as `bad_supi` |

No crash was involved: the CHF would have billed those strings as subscribers. The API suite had invented its extra
subscribers by adding a suffix to the SUPI, which is what the check refuses, so they now differ in digits, and TC-ERR-6
pins the check with a NAI SUPI as the control.

| Regression, complete set, on the rig | Result |
|---|---|
| Patch set | all eight on a pristine `5ff0dc56f`, no fuzz, checksums matching the commit, and the binaries checked for the new code |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 0 failed, queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 63,116,196 of 60 MB, `slice1sd2` 42,044,670 of 40 MB, both `volumeLimit` |
| Encodings agree | **62 of 62**: every CDR in that day's directory |
| Live TC-12 | PASS |
| Over-the-wire API suite | **55 / 55**, leaving `chf.subscribers` as found |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Errors | CHF **0**, SMF **0**, UPF 2 (GTP-U error indications), AMF 282, exactly the 284 bucket selections less the 2 that succeeded |
| Upstream's suites | **14 of 14** under random `MALLOC_PERTURB_` |
| UPF restart under two charged sessions, 3 runs | the CHF held 2 sessions each time, and each replaced session was released with a final report of 0 and a CDR. The new sessions were charged, 3.29 to 3.41 MB each. SMF 12 lines each run, as on 2026-11-07 |
| A full CHF session pool | as on 2026-11-07: 500 `INSUFFICIENT_RESOURCES`, `internet` refused, the other DNNs up, and all four charged once slots freed |

The twelve feature tests gave the results of 2026-11-04 again. The CHF beside the whole `vonr` binary caught all 52
sessions, 23 of them exempt, with 0 errors. `test-dedicated-flow.sh` passed 10 of 10, and the CHF started 9 times with no
index warning.

*A rig fault the numbers gave away.* The first pass exited 0 with `slice1sd2` at 0. The AMF had refused the second
session with "Not Subscribed in the Slice" because the gNB advertised only one slice: its config on the UE VM had been
changed that morning, before the round began. The UDM's answers were correct, so nothing in the patches was involved.
The regression and the UPF and pool tests were rerun with the rig's `gnb-slices.sh`, the results above, and the gNB's
config was put back as it was found. The feature tests use one slice and stand.

On macOS, with the same patches: all 9 states build on mongo-c-driver 2.5.3 when applied one at a time, with `core`, `crypt`
and `unit` passing and the CHF's tests from phase 3. On driver 1.30 under ASan + UBSan, the CHF's suites and
`chf-cdr-decode`: **0 reports**, with the canary firing. The API suite against a local CHF: 29 passed, 0 failed, 25 skipped.
Ten SIGTERM cycles with a request in flight: 10 of 10 exit 0, each answered 503. The WebUI's 159 and 9 opt-in tests.

Not run on this base: the chain walked live one patch at a time, which last ran on 2026-11-07.

**The `422c5b31d` replant and a macOS QA round (2026-11-08).** Three upstream commits, and no VM was
used, so nothing in this record ran with a UE, traffic, or an SMF talking to a CHF.

| Upstream | What it means for charging | Checked by |
|---|---|---|
| `f44961889` SMF releases a rejected session when the AMF does not answer the N1N2 transfer | **The one conflict,** in the SBI client timer of `src/smf/smf-sm.c`, where the CHF's code sits. A refused session goes through `smf_gsm_state_5gc_n1_n2_reject`, and upstream's new cleanup frees it. It has already sent its CHF Release, on entry to that state and without waiting for the answer, so the CHF is not left holding it. A timed-out CHF Release cannot trigger the cleanup, which applies only to `namf-comm` | Reading the code: the SMF has no unit tests |
| `4f95293df` QoS flow description encoding on N16 | Home-routed roaming only. It touches `gsm-build.c` and `sbi-path.c`, which the patches also change, in other hunks | The build |
| `422c5b31d` Update CLA | No code. Section 4 of the new agreement asks a submission to identify third-party material, and `patches/README.md` now has that table | — |

Both sides of the conflict are kept, with the CHF's checks ahead of upstream's cleanup because that cleanup can
free the session. Upstream's commit saves the transaction's service name for the same reason the CHF's code did,
so the patches now use upstream's variable and carry no copy of their own. Six patches came out byte-identical,
phase 5 changed only in blob hashes and hunk offsets, and phase 6 fell from 627 to 624 added lines.

| QA on these patches, on macOS | Result |
|---|---|
| Build and unit tests, after every patch | all 9 states build on mongo-c-driver 2.5.3, with `core`, `crypt` and `unit` passing, and the CHF's tests from phase 3 |
| ASan + UBSan, on driver 1.30 | the CHF's suites and `chf-cdr-decode`: **0 reports**, with the canary firing |
| Unit suites on the branch | 3 of 3, and the CHF's 2 of 2 |
| WebUI | 159 tests, and the 9 opt-in tests on a real MongoDB |
| API suite against a local CHF | 27 passed, 0 failed, 25 skipped: no `mongosh`, SMF or WebUI there |
| Ten SIGTERM cycles with a request in flight | 10 of 10 exit 0, the NRF saw each de-registration, and each request was answered 503 |
| A full session pool | the fifth Create gets 500 `INSUFFICIENT_RESOURCES`, and the CHF keeps running |
| A fresh database, the CHF first | the intended indexes, with no warning |

The shutdown cycles printed nothing on the first attempt. That was the harness: the scratchpad had been emptied, and
the copy recovered from the session log was the one with the bare `wait` that session 69 had already found hanging.
With that fixed, the cycles passed as above.

`patches/README.md` was rewritten for someone who maintains Open5GS or carries these patches. Working it out from the
code turned up three things it now states rather than leaves to be found: 17 generated models still change shape,
which no existing NF can see today but should be renamed before the models go upstream; the CHF's default address is
the AF's in `configs/vonr.yaml.in` and nine example configs; and the CHF has no systemd unit, Debian package or test
config. It also corrected the apply recipe, which failed on the development branch because checking out the base
removes the tracked `patches/` directory. The 17 models were renamed later the same day, as section 5.1 describes.

Not run on this base: the rig, in full. The last run is the record below, three upstream commits earlier.

**A UPF restart, a full session pool, and the chain walked live on `3e007ddf0` (2026-11-07).** Upstream had
not moved, so there was no replant. The rig ran the three tests the last three rounds had left out, and the
first found a defect in the SMF. The fix is in phase 6, which grew from 578 to 627 added lines. Every result
below is from the fixed patches.

*A UPF restart under a charged session.* One UE had two charged `internet` sessions, one on each slice, and
pulled 3 MB. The UPF was then killed and started again 5 s later. Ten seconds after it came back, the SMF saw
the restart and released both sessions with reactivation requested. Upstream's `fc26daab9` skipped restoring
them, since they were no longer operational. The UE asked for the same two PDU session IDs again within 0.2 s,
and that is where the defect was. A Create for a PDU session ID the SMF still holds removes the old session on
the spot. That skips the teardown state that sends the CHF Release:

| | Before the fix | After, 3 runs |
|---|---|---|
| CHF sessions after the restart, with 2 live | **4** | 2, every run |
| The two replaced sessions | never released: no CDR, and each held a slot in the CHF's session pool until the CHF restarted | released with a final report of 0 bytes, one CDR each |
| The 3 MB pulled before the restart | unbilled | unbilled, as limitation 14 says: the UPF had not reported it yet, and lost it when it restarted |
| The new sessions | charged, 3,289,459 and 3,314,031 bytes | charged, 3.28 to 3.44 MB each |

The fix: before such a Create replaces a session, the SMF sends the old session's CHF Release without waiting
for the answer. It already does the same when the UPF does not answer a deletion. The answer arrives after the
session is gone and is logged at debug level. EPC sessions never have a CHF session and are left alone.

The three restarts logged 12, 12 and 18 SMF errors, the same 12 as before the fix, all from upstream code: the
PFCP restart and the failed restoration, the PCF delete race, and in the first run a 5GSM status message the SMF
does not handle. In the third run the race hit both sessions instead of one. The UPF logged 3 each time. The SMF never stopped, and both sessions carried traffic again. In
two runs, a third pair of CHF sessions was still open at the end. That pair comes from the test harness: after
its deregistration the UE registered again, set up both sessions, and was killed 4 s later without releasing
them.

*The CHF's session pool full.* With `max.ue: 1` the CHF's pool holds 4 sessions. Three slots were filled by
Creates sent straight to the CHF. Then the UE asked for `ims`, `sos`, `mcptt` and `internet`:

| | Result |
|---|---|
| The last free slot | the first of the UE's Creates to arrive: `mcptt` this run, `ims` in the run before the fix |
| Every other Create | 500 `Insufficient resources`, cause `INSUFFICIENT_RESOURCES`, each counted in `chf_errors_total{kind="session_add"}` |
| `internet` | refused. The UE saw `NETWORK_FAILURE` and kept retrying: 16 refusals by the first check, 29 by the time slots were freed |
| The other two well-known DNNs | set up uncharged, each with a warning |
| The CHF | stayed up, 0 FATAL |
| After the three direct sessions were released | the UE's next attempt brought all four up through the CHF, with no refusals |

So the SMF treats a full pool like a CHF that does not answer: `ims`, `sos` and `mcptt` stay up, and anything
else is refused.

*The walk.* A clean `3e007ddf0`, with the patches applied one at a time on the rig. Each step ran the four
upstream suites and live traffic, as on 2026-11-02:

| After patch | Upstream's `registration`, `slice`, `vonr`, `attach` | Live, no CHF | Live, CHF running |
|---|---|---|---|
| 1, 2 | pass | 12 NFs, 126 MB, 0 errors | no CHF exists |
| 3 | pass | 12 NFs, 126 MB, 0 errors | 13 NFs, 126 MB, 0 errors, **0 Creates** |
| 4, 5 | pass | 12 NFs, 126 MB; SMF 8 each time, the PCF delete race | 13 NFs, 126 MB, 0 errors, **0 Creates** |
| 6 | pass | 12 NFs, 126 MB, 0 errors | charged: `slice1sd1` 62,971,496 of 60 MB, then cut. AMF 106 (the refused retries), UPF 2, SMF 2 |
| 7 | pass | 12 NFs, 126 MB, 0 errors | charged: 63,056,992 of 60 MB, then cut. AMF 95, UPF 1 |
| 8 | pass | 12 NFs, 126 MB, 0 errors | charged: that run's first tunnel was `slice1sd2`, 42,050,914 of 40 MB, then cut. AMF 94, UPF 2 |

The UPF lines are GTP-U error indications, sent when packets arrived on a tunnel the cut had removed. Patch 6's
two SMF lines also come from upstream code. One was a 5GSM message that arrived for a session a same-ID Create
had just replaced; the other was an HTTP/2 stream reset. Patches 7 and 8 went through the same cut and retries
without either. The chain was walked twice in this round, before and after the fix, with the same outcome. The
table is from the second walk, because the first walk's error counts carried over from step to step: root could
not overwrite a mark file in `/tmp` that another user had created.

| Regression, complete set, on the rig | Result |
|---|---|
| Patch set | all eight on a pristine `3e007ddf0`, no fuzz, checksums matching the commit, and the binaries checked for the new code, the replaced session's Release included |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 0 failed, queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 63,012,516 of 60 MB, `slice1sd2` 42,029,434 of 40 MB, both `volumeLimit` |
| Encodings agree | **81 of 81**: every CDR in that day's directory |
| Live TC-12 | PASS |
| Over-the-wire API suite | **53 / 53**, leaving `chf.subscribers` as found |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Errors | CHF **0**, SMF **0**, UPF 5 (GTP-U error indications), AMF 282, exactly the 284 bucket selections less the 2 that succeeded |
| Upstream's suites | **14 of 14** under random `MALLOC_PERTURB_` |

The twelve feature tests gave the results of 2026-11-04 again. The CHF beside the whole `vonr` binary caught all
52 sessions, 23 of them exempt, with 0 errors. `test-dedicated-flow.sh` passed 10 of 10, and the CHF started 9
times without an index warning.

On macOS, before the walk, the QA round ran with these results:

- the CHF's suites under ASan + UBSan, built on mongo-c-driver 1.30: **0 reports**, with the
  canary firing;
- the WebUI's 159 tests and its 9 opt-in tests;
- the API suite against a local CHF: 27 passed, 0 failed and 25 skipped, because there is no
  `mongosh`, SMF or WebUI there;
- ten shutdown cycles, each clean, with the request in flight answered 503;
- the CHF first on a fresh database: the intended indexes.

After the fix, all 9 states built again on mongo-c-driver 2.5.3 when applied one at a time, with `core`,
`crypt` and `unit` passing, and the CHF's tests passing from phase 3.

**The `3e007ddf0` replant, two CHF defects, and the regression (2026-11-06).** One upstream
commit, no conflicts. Seven patches came out byte-identical, and phase 6 changed only in blob
hashes and hunk offsets.

| Upstream | What it means for charging | On the rig |
|---|---|---|
| `3e007ddf0` graceful shutdown moves onto each NF's worker thread | **Every SBI NF changed except the CHF**, which kept the old `event_termination()` and the race that commit fixes: NRF de-registration and GOAWAY sent from the termination thread while the worker may still be using the same libcurl handles. It compiled unchanged, so only reading the commit found it. Ported, below | The rig's shutdown test: exit 0, no cores |

*The CHF's shutdown, ported.* `chf_terminate()` now closes the queue and joins the worker, and the
worker runs `ogs_sbi_nf_fsm_fini_all()` and `ogs_sbi_graceful_shutdown()` on its way out, as UDR and
the rest do. Thirty start-stop cycles each way on macOS, with a session open and a request in flight as
SIGTERM landed:

| | Before | After |
|---|---|---|
| Exit 0 | 30 of 30 | 30 of 30 |
| Aborts | 0 | 0 |
| NRF saw the de-registration | every time | every time |
| The request in flight | no answer | **503** |

The race itself never showed, so the port is upstream's reasoning rather than a measured failure. What
did change is that a request arriving during shutdown gets an answer.

*`chf.subscribers`' indexes, found by a warning nobody had read.* The CHF still asked for a **unique**
index on `supi`, from before buckets, when a SUPI now holds a catch-all bucket and scoped ones. On the rig
the WebUI had created its indexes first, so the CHF's request failed with a non-fatal warning on every
start since September, and nothing else happened. On a database where the CHF gets there first it is
worse. Measured on a fresh scratch database, the CHF started first:

| | Before | After |
|---|---|---|
| Indexes | `supi_1`, unique | `supi_1`; `bucketId_1`, unique and sparse: what the WebUI's model declares |
| A second, scoped bucket for the same SUPI | **refused**, E11000 | accepted |
| A duplicate `bucketId`, the key every usage write uses | **accepted** | refused |

The WebUI's start-up migration drops a unique `supi` index, but only a WebUI that starts afterwards. Buckets
written straight into MongoDB, as after patch 6 without the WebUI, never meet it. On the rig the CHF now
starts with no warning, 9 starts out of 9, and the WebUI's opt-in tests pass on a database whose indexes the
CHF created.

*`test-dedicated-flow.sh` lost a race.* In the first pass of this round it found 0 CDRs, and then 1 time in 5
more. Both failures had the same signature: the CHF started but never registered. The script started it the
moment the test's NRF process existed; the CHF's first registration then found no SCP listening, logged a
warning rather than an error, and its retry came after the test had finished. Started before the test, it
missed 4 times in 4; started once the NRF and SCP accept connections, it registered 10 times in 10. The script
now waits for both, and passed 10 of 10 again on the final patches.

| Regression, complete set, on the rig | Result |
|---|---|
| Patch set | all eight on a pristine `3e007ddf0`, no fuzz, checksums matching the commit, and the binaries checked for the new code |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 0 failed, queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 62,990,928 of 60 MB, `slice1sd2` 41,972,474 of 40 MB, both `volumeLimit` |
| Encodings agree | **105 of 105**: every CDR in that day's directory |
| Live TC-12 | PASS |
| Over-the-wire API suite | **53 / 53**, leaving `chf.subscribers` as found |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Errors | CHF **0**, SMF **0**, UPF 4 (GTP-U error indications), AMF 283, exactly the 285 bucket selections less the 2 that succeeded |
| Upstream's suites | **14 of 14** under random `MALLOC_PERTURB_` |

The twelve feature tests gave the results of 2026-11-04, below. This time the CHF beside the whole `vonr` binary
caught all 52 sessions, 23 of them exempt, with 0 errors, and the dedicated flows' traffic is in the CDRs.

On macOS, with the same patches: all 9 states build on mongo-c-driver 2.5.3 when applied one at a time, with
`core`, `crypt` and `unit` passing and the CHF's tests from phase 3. On driver 1.30, 7 suites / **82 cases** plus
`chf-cdr-decode`, clean under ASan + UBSan: **0 reports**, with the canary firing.

Not run on this base: a UPF restart under a charged session, a full CHF session pool on the rig, and the chain
walked live one patch at a time, which last ran on 2026-11-02.

**The `4fbe6d137` replant, QA round and regression (2026-11-06).** Seventeen upstream commits
came in with no conflicts. Six patches came out byte-identical, and phases 2 and 5 changed only
in blob hashes and hunk offsets, around upstream's new lines in `lib/sbi/nnrf-handler.c` and
`src/smf/sbi-path.c`. Those are the two files both sides touch, and the hunks are apart. Each
commit was read for what it means here, and then run on the rig:

| Upstream | What it means for charging | On the rig |
|---|---|---|
| `9c930ba5e` NFs answer a full context or session pool with 500 `INSUFFICIENT_RESOURCES` | **The CHF answered 500 with no cause**, fixed below | Not reachable: no regression comes near filling the pool |
| `085be2f79`, `20661128a`, `709b44451`, `5a51a1bc9`, `29464d14d`, `405e25f11` NAS (T)LV decoders and structures, 5GS and EPS | The SMF's cause-26 reject carries a GPRS timer 3 back-off. That structure and its encoder did not change, and upstream's MME still fills it the same way | Every refusal reached the UE as `INSUFFICIENT_RESOURCES` |
| `711cc9bc9`, `5803c12f1` PCO parse and build | Run on every session the SMF sets up | Every session came up |
| `c484a1a20`, `27cfb0106` core: zero-length TLVs, and a talloc report at shutdown | The report would show memory the CHF leaves behind | None printed on macOS. Exit 0 and no cores on the rig |
| `67819e07c`, `4fbe6d137` AMF and MME resolve a pending GUTI on a retry | Not charging, but every charged session registers first | UERANSIM registered on every run, and `registration` and `attach` pass |
| `e85748ef3` HSS iFC application server flags | None | Not exercised |
| `01bf3acd0`, `2ceb361e5`, `564113f61` whitespace | None | — |

*The CHF on a full session pool.* Measured on a CHF with `max.ue: 1`, whose pool holds 4 sessions,
before and after the change. The fifth Create gets:

| | Before | Now |
|---|---|---|
| Status | 500 | 500 |
| Title | `Cannot add CHF session` | `Insufficient resources` |
| Detail | none | `Cannot add CHF session` |
| Cause | **none** | `INSUFFICIENT_RESOURCES` |

The CHF keeps running either way. Without the cause, a client could not tell a full pool from any
other server error.

| Regression, complete set, on the rig | Result |
|---|---|
| Patch set | all eight on a pristine `4fbe6d137`, no fuzz, checksums matching the commit; 3,280 build steps, and the binaries checked for the new code |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 0 failed, queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 62,964,052 of 60 MB, `slice1sd2` 42,036,706 of 40 MB, both `volumeLimit` |
| Encodings agree | **17 of 17**: every CDR in that day's directory |
| Live TC-12 | PASS |
| Over-the-wire API suite | **53 / 53**, leaving `chf.subscribers` as found |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Errors | CHF **0**, SMF 8 (the PCF delete race), UPF 10 (GTP-U error indications), AMF 284, exactly the 286 bucket selections less the 2 that succeeded |

The twelve feature tests gave the results of 2026-11-04, below, with one exception. The CHF beside
the whole `vonr` binary registered late again and caught 31 sessions, none from `qos-flow-test`. So
the evidence for dedicated flows is `test-dedicated-flow.sh`: **PASS**, `ul=112 dl=112`.

**Upstream's suites:** 13 of 14 under random `MALLOC_PERTURB_`. `310014`, which aborted once on
2026-11-04, passed. `transfer-error` aborted at scramble value 56. This time the sweep ran
line-buffered (`stdbuf -oL`), so the test's output survived the abort: its simulated gNB was refused
at the AMF's SCTP address, so the AMF was not up. A line-buffered re-run that failed showed a second
start-up fault, an NF unable to bind `127.0.0.20:7777`, "Address already in use". Re-run: 6 of 6 without scrambling, 8 of 8 at random values, 2 of 6 at 56. Then the same test at
56 on an **unpatched** `4fbe6d137` built beside the patched tree, alternating: unpatched 6 of 12
failed, patched 2 of 12, in bursts on both trees. So it is upstream's, not something these patches
cause. The bursts are too uneven to compare rates.

On macOS, with the same patches: all 9 states build on mongo-c-driver 2.5.3 when applied one at a
time, with `core`, `crypt` and `unit` passing and the CHF's tests from phase 3. On driver 1.30, 7
suites / **82 cases** plus `chf-cdr-decode`, clean under ASan + UBSan: **0 reports**, with the canary
firing. The CHF ran against a real NRF and MongoDB through three heartbeats, with 0 errors and exit 0.

Not run on this base: a UPF restart under a charged session, a full pool on the rig, and the chain
walked live one patch at a time, which last ran on 2026-11-02.

**The `d9c44d67f` replant, QA round and regression (2026-11-04).** Seven upstream commits came
in with no conflicts. Seven patches came out byte-identical, and phase 6 changed only in blob
hashes and hunk offsets. Each commit was read for what it means here, and then run on the rig:

| Upstream | What it means for charging | On the rig |
|---|---|---|
| `5c437e9c2` PCF, UDM and AMF validate `pduSessionId` | **The CHF had the same bug**, fixed below | TC-ERR-4 |
| `48c0cc037` at most 1,024 series per dynamic metric table | Nothing to change. The CHF already has that cap and the same behaviour at it: existing series still update, new ones are dropped, one warning | 26 families, as before |
| `fc26daab9` SMF restores only operational sessions after a UPF restart | The one file both sides touch, `src/smf/pfcp-sm.c`, in different hunks. A session waiting on a CHF Create or being released is not operational, so it is skipped, and an operational charged session restores as before | **Not run:** nothing here restarts a UPF under a session |
| `3decb45a6`, `cfd25ad25` AMF and MME keep a UE-reported ngKSI or KSI apart from the stored one | Not charging, but every charged session registers first | UERANSIM registered on every run, and `registration`, `attach`, `volte` and `csfb` pass |
| `b00f7b5e5` AUSF and UDM authentication result removal | None: not on the charging path | `registration` passes |
| `d9c44d67f` `lib/dbi` stores each iFC's SPT count | None | Not exercised directly |

*Two narrowing bugs in the CHF.* The model holds `pduSessionID` and `sst` as ints, and the CHF
holds them in a `uint8_t`, with nothing between them. Upstream's commit pointed at the first,
and the same line of reading found the second. Measured on a running daemon:

| Sent | Before: answer, and what the CDR recorded | Now |
|---|---|---|
| `pduSessionID` 1, 255 | 201, the same id | the same |
| `pduSessionID` 0 | 201, 0 | 400 |
| `pduSessionID` 256 | 201, **0** | 400 |
| `pduSessionID` 257 | 201, **1** | 400 |
| `pduSessionID` -1 | 201, **255** | 400 |
| `sst` 1 | 201, SST 1 | the same |
| `sst` 257 | 201, **SST 1** | 400 |

Nothing asserts on these values here, as `pduSessionId` did in the PCF and AMF, so they gave
wrong records rather than crashes, and `sst` also picks the bucket a session draws from. Our
SMF holds both in a `uint8_t`, so 256 and its like can only come from some other client. A
Create with no `pduSessionInformation` or no S-NSSAI is allowed and still records 0.
`chf_errors_total` counts these as `bad_psi` and `bad_sst`, and TC-ERR-4 and TC-ERR-5 pin them.

| Regression, complete set, on the rig | Result |
|---|---|
| Patch set | all eight on a pristine `d9c44d67f`, no fuzz, checksums matching the commit |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 0 failed, queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 62,981,192 of 60 MB, `slice1sd2` 42,115,594 of 40 MB, both `volumeLimit` |
| Encodings agree | **17 of 17**: every CDR in that day's directory |
| Live TC-12 | PASS |
| Over-the-wire API suite | **53 / 53**, leaving `chf.subscribers` as found |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Errors | CHF **0**, SMF **0**, UPF 18 (GTP-U error indications), AMF 281, exactly the 283 bucket selections less the 2 that succeeded |

| Feature test, on the rig | Result |
|---|---|
| Every balance empty | `internet` refused with `INSUFFICIENT_RESOURCES`. `ims`, `sos`, `mcptt` up with CDRs, balances untouched, ABORT_CHARGING sent 0 |
| `charging.well_known_dnn.cdr` off | sessions work, 0 CDRs |
| `ctf.bypass_well_known_dnn` on | the CHF hears only of `internet`; its bucket 3,360,483 equals its CDR |
| CHF frozen during attach | T3580 retransmits 0. 4 lost Creates; `ims`, `sos`, `mcptt` up uncharged; `internet` refused once, then up uncharged after the NRF dropped the CHF |
| The only CHF serves another slice | `ims`, `sos`, `mcptt` reach it, with 3 CDRs. `internet` refused with `NETWORK_FAILURE` |
| `ctf.enabled: yes`, no CHF | `internet` refused with `NETWORK_FAILURE`; the other three up, with a warning |
| `yes`, CHF running | all four up and through the CHF |
| `yes` plus the bypass, no CHF | `internet` refused; the other three up, with no warning |
| `auto`, no CHF | all four up, uncharged, 0 rejects |
| PCC rules under UERANSIM | nothing breaks, although its gNB cannot answer the modify |
| `test-dedicated-flow.sh` | **PASS**, `ul=112 dl=112` |
| The whole `vonr` binary with a CHF beside it | passes: 52 sessions, 23 of them exempt, 0 CHF errors |

**Upstream's suites:** 13 of 14 under random `MALLOC_PERTURB_`. `310014` aborted once, 2 s in,
at `child_main: Assertion 'out_return_code == 0'`, meaning an NF it started exited non-zero. It
then passed 48 runs in a row: 8 without scrambling, 8 at the same value, 8 at others, and 24 at
random values straight after `non3gpp`, as the sweep had run it. So it is rare, and **its cause
is not known**: the NF's output sat in a buffer that the abort discarded, so which NF exited
cannot be told. It is an EPC test with no charging in it, and it looks like the start-up failures
recorded for `vonr` on an unpatched tree, but that is a resemblance, not a finding.

On macOS, with the same patches: all 9 states build on mongo-c-driver 2.5.3 when applied one at a
time, with `core`, `crypt` and `unit` passing and the CHF's tests from phase 3. On driver 1.30, 7
suites / **82 cases** plus `chf-cdr-decode`, clean under ASan + UBSan: **0 reports**, with the
canary firing.

Not run on this base: a UPF restart under a charged session, and the chain walked live one patch at
a time. That last ran on 2026-11-02, below.

**Dedicated QoS flows counted, `ctf.enabled: yes`, and the chain walked again (2026-11-02).**

*Dedicated flows.* On a session the CHF charges, a dedicated flow now has no URR of its own
and its PDRs count against the default flow's. Leaving `qos_flow->urr` NULL means nothing to
create, update, remove or free for that flow. A session the CHF does not charge keeps one URR per flow, as upstream.

This gap had never been seen running, so it was measured first, on the build without the
change. A first attempt with UERANSIM showed nothing: 43.7 MB landed on the default URR even
with a match-all PCC rule, because the UPF skips a dedicated DL PDR until the gNB answers the
N2 modify. So `vonr`'s simulated gNB was used instead, with a CHF beside it:

| | CDR per session, `vonr` `qos-flow-test` |
|---|---|
| Before | `ul=56 dl=56`: the default flow's 2 pings only, the dedicated flow uncounted |
| After | `ul=112 dl=112`: all 4 pings at 28 bytes each |

The whole `vonr` binary with a CHF beside it passed too, on the same SMF code: 52 charged
sessions, 23 of them exempt on `ims`, with dedicated flows added and removed by the AF tests,
and 0 CHF errors. A second such run on the final patches also passed, but its CHF registered
late and caught only 31 sessions, none from `qos-flow-test`, so it is the weaker evidence.

*`ctf.enabled: yes`* now refuses a new 5GC session when no CHF is available, rather than
running it uncharged until its first usage report.

| Test | Result |
|---|---|
| `yes`, no CHF | `internet` refused, `NETWORK_FAILURE`. `ims`, `sos`, `mcptt` up, with a warning |
| `yes`, CHF running | all four up and through the CHF, as normal |
| `yes` plus the bypass, no CHF | `internet` refused. `ims`, `sos`, `mcptt` up, with no warning |
| `auto`, no CHF | all four up, uncharged, as before |
| PCC rules on a charged session under UERANSIM | nothing breaks, although its gNB cannot answer the modify |

The tests of the previous record were all re-run on this code, with the same results.

*The walk.* Clean `b60aad44e`, patches applied one at a time on the rig, this time with `vonr`
among the suites. It ran uninterrupted:

| After patch | Upstream's `registration`, `slice`, `vonr`, `attach` | Live, no CHF | Live, CHF running |
|---|---|---|---|
| 1, 2 | pass | 12 NFs, 126 MB, 0 errors (once, at patch 2, the 8 lines of the PCF delete race) | no CHF exists |
| 3, 4, 5 | pass | 12 NFs, 126 MB, 0 errors | 13 NFs, 126 MB, 0 errors, **0 Creates** |
| 6 | pass | 12 NFs, 126 MB, 0 errors | charged: 41,955,698 of 40 MB, then cut. AMF 89, the refused retries |
| 7 | pass | 12 NFs, 126 MB, 0 errors | charged: 62,967,968 of 60 MB, then cut. AMF 90 |
| 8 | pass | 12 NFs, 126 MB, 0 errors | charged: 63,009,720 of 60 MB, then cut. AMF 91 |

| Regression, complete set | Result |
|---|---|
| Patch set, applied on the VM | all eight on a pristine `b60aad44e`, one at a time, by the walk above |
| C suites | 7 suites / **82 cases** plus `chf-cdr-decode`; clean under ASan + UBSan |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 2 acknowledged, 0 failed, queue left empty |
| Slice isolation | all 266 bucket selections went to a slice's own bucket (176 and 90), none to the catch-all; `slice1sd1` 62,995,068 of 60 MB, `slice1sd2` 42,021,226 of 40 MB, both `volumeLimit` |
| Encodings agree | **139 of 139**: every CDR then in the directory, including the feature tests' |
| Live TC-12 | PASS |
| Over-the-wire API suite | **49 / 49**, leaving `chf.subscribers` as found |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Upstream's suites | 13 of 14 under random `MALLOC_PERTURB_`. EPC `handover` timed out at value 117, and passed without it twice and at value 254. Nothing here touches EPC, and an unpatched base showed the same in an earlier round |
| Errors | CHF **0**, SMF 8 (the PCF delete race), UPF 4 (GTP-U error indications), AMF 264, exactly the 266 bucket selections less the 2 that succeeded |

On the rig, the last leftover test subscriber is gone, leaving the 5 documents of the 3 rig
SUPIs. The WebUI needed no redeploy, since phase 7 did not change.

**Well-known DNNs, the lost Create, and a live walk of the patch chain (2026-11-01).**
Done after the QA round below, on the same base: `ims`, `sos` and `mcptt` taken out of
quota management, a fix for the hang that round found, `n4-handler` moved into phase 5,
and the patch chain checked with live traffic rather than from reading the code.

*The walk.* A clean `b60aad44e`, patches applied one at a time on the rig. At each step:
the tree built and installed, upstream's `registration`, `slice` and `attach` passed, and
a UE brought up two sessions and pulled 126 MB on one of them.

| After patch | Live, no CHF | Live, CHF running |
|---|---|---|
| 1, 2 | 12 NFs, 126 MB, 0 errors | no CHF exists |
| 3, 4, 5 | 12 NFs, 126 MB, 0 errors | 13 NFs, 126 MB, 0 errors, **0 Creates**: the CHF hears nothing, buckets at 0 |
| 6, 7 | 12 NFs, 126 MB, 0 errors | charged: `slice1sd1` reached 63,041,592 and 63,040,752 of 60 MB and the transfer was cut. AMF 96 and 95, the refused retries |
| 8 | 12 NFs, 126 MB, 0 errors | charged: that run's first tunnel was `slice1sd2`, which reached 42,091,310 of 40 MB and was cut |

Both VMs rebooted together during patch 8's no-CHF step, including the UE VM, which runs
none of this code, so that step was run again and is the result above.

*The features.* Every test used one UE with `ims`, `sos`, `mcptt` and `internet` sessions.

| Test | Result |
|---|---|
| All buckets empty, default toggles | `internet` refused, `INSUFFICIENT_RESOURCES`. `ims`, `sos`, `mcptt` up. 126 MB over `ims`, and every bucket's counter unchanged |
| `ABORT_CHARGING` queued for that subscriber | `chf_charging_notify_sent_total` stayed 0 and all three sessions stayed up |
| CDRs on Release | `ims` 43,808,366 bytes, `mcptt` 3,282,223, `sos` 0, all `normalRelease`, and none for the refused `internet` |
| `charging.well_known_dnn.cdr: false` | sessions work as before, 0 CDRs |
| `ctf.bypass_well_known_dnn: true`, fresh buckets | all four up. The CHF saw only `internet`, whose bucket (3,296,835) equals its CDR |
| CHF frozen during attach | no T3580 retransmits. All 4 Creates timed out at about 10 s: `internet` refused with `NETWORK_FAILURE`, and `ims`, `sos`, `mcptt` set up uncharged |
| The only CHF serves another slice | `ims`, `sos`, `mcptt` still reached it, 3 CDRs. `internet` refused with `NETWORK_FAILURE`: the SCP answers 504 at once, so on this rig that path does not wait for the timer. Direct discovery would, which is read from the code and was not run |

Before the fix, the frozen-CHF test left the UE retransmitting on T3580 with no answer.

| Regression, complete set | Result |
|---|---|
| Patch set, applied on the VM | all eight on a pristine `b60aad44e`, checksums matching the commit |
| C suites | 7 suites / **82 cases** plus `chf-cdr-decode`; clean under ASan + UBSan. QU-20 and QU-21 fail with the exemption guards removed |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 2 acknowledged, 0 failed, queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 63,024,844 of 60 MB, `slice1sd2` 42,073,658 of 40 MB, both `volumeLimit` |
| Encodings agree | **60 of 60**: every record written that day, well-known DNN sessions included |
| Live TC-12 | PASS |
| Over-the-wire API suite | **49 / 49** |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Upstream's suites | **14 of 14** under random `MALLOC_PERTURB_` values, and `vonr`, `transfer`, `transfer-error` and `non3gpp` again without it. Those four remain intermittent under it, as the record below explains: a clean sweep does not change that |
| Errors | CHF **0**, SMF **0**, UPF 8 (GTP-U error indications), AMF 279, exactly the 281 bucket selections less the 2 that succeeded |

The traffic run used patches `25f3065cc`. Only a test script and a WebUI help string changed
after it, so the final patches, `cb77a08f9`, were rebuilt on the VM from a pristine base and
re-run for what those touch: the unit suite, the API suite and the WebUI.

On the rig, the WebUI was redeployed with the bucketId fix: the API suite now leaves
`chf.subscribers` at the same 6 documents it found, and its cleanup DELETEs succeed. The 26
old test subscribers were removed. One other leftover, `imsi-999700793300312-early`, is
still there.

**The `b60aad44e` replant, QA round and regression (2026-11-01).** Fourteen upstream
commits came in, with one conflict. The patches barely moved: seven came out
byte-identical and phase 6 changed only in context and offsets. But the SMF and the
UPF, which charging runs through, changed around them, and neither the unit suite nor
the invariants exercise those paths, so each commit was read for what it means here
and then watched on the rig:

| Upstream | What it means for charging | Seen on the rig |
|---|---|---|
| `b60aad44e` SMF deletes the UDM SDM subscription on a reject | The one conflict. A session the CHF refuses now goes CHF Release → PCF delete → **UDM SDM delete** → Reject. This closes a leak that path exercised hard, one subscription per refused establishment | 306 refusals, all cause 26, and all 306 reached the UE as `INSUFFICIENT_RESOURCES`. UDM and PCF logged 0 errors |
| `5c4d307ff` SMF stops passing a transaction ID as a stream ID | On a request with no stream, `e->h.sbi.data` is now 0. Every CHF Create on a non-roaming session is such a request, and `wait_5gc_nchf_create` reads the value with no range check. It holds, because the lookup returns NULL for 0 (§13.6). It also closes a latent bug: that state could pick up an unrelated stream when the IDs coincided | Every Create, refusal and release on exhaustion ran without an SMF abort |
| `5282c8d8f` UPF reports only the first URR on session deletion | The right URR still arrives, since the SMF takes only the default flow's and that one is first. It is also a fix: with a dedicated flow active, every entry used to carry the last URR's volume | Final usage billed on Release, and both CDRs agree with it. No dedicated flow was exercised |
| `926550203` UPF deletes an SMF's sessions on heartbeat failure | Quota-holding timers go with them, through `upf_sess_urr_acc_remove_all()`. Widens limitation 14 in §11 | Not exercised |
| `08e0940e1` UPF rejects an out-of-range URR-ID | None: the SMF allocates URR IDs from a pool inside that range | Sessions set up as usual |

| What | Result |
|---|---|
| Patch set, applied on the VM | all eight on a pristine `b60aad44e`, no fuzz, checksums matching the commit |
| A build after each patch | every step builds except the SMF at phase 4, which needs phase 5 ([patches/README.md](../patches/README.md)) |
| C suites | 7 suites / **79 cases** plus `chf-cdr-decode`, on mongo-c-driver 1.26 on the VM, and 1.30 and 2.5 on macOS. Clean under ASan + UBSan, with a canary proving the sanitizers live |
| WebUI | 159 tests, and the 9 opt-in tests on the rig's MongoDB |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 2 acknowledged, 0 failed, and the queue left empty |
| Slice isolation | catch-all **0**; `slice1sd1` 63,006,520 of 60 MB, `slice1sd2` 42,090,434 of 40 MB, both `volumeLimit` |
| Encodings agree | **2 of 2** JSON CDRs matched their BER record |
| Live TC-12 | PASS |
| Over-the-wire API suite | **44 / 44** |
| Shutdown with a populated metrics table | exit **0**, no cores |
| Errors | CHF **0**, SMF 8 (the PCF `sm-policies` delete race), UPF 8 (GTP-U error indications), AMF 306 (the refusals) |

The traffic run used patches `952c522d6`. One `# HELP` string changed after it, so the
final patches, `5b48909b7`, were rebuilt on the VM from a pristine base and re-run for
what that touches: the unit suite, the API suite at 44/44, and a scrape showing the new
text and all 26 families.

**Upstream's suites**, which run with no CHF, so they are the live evidence that a core
with these patches and no CHF still works:

| Suite | Patched | Unpatched `b60aad44e` |
|---|---|---|
| `eir-5g`, `eir-n5g`, `registration`, `slice`, `handover-5gc`, `attach`, `volte`, `csfb`, `handover-epc`, `310014` | pass | not re-run |
| `transfer`, `transfer-error` | fail under `MALLOC_PERTURB_`, pass without | the same |
| `vonr` | 4 failures in 15 runs, all under `MALLOC_PERTURB_` (a test that cannot reach the AMF, or an NF that fails to start); passes without it | 1 failure in 6, also under it (an NF child aborting at start-up); passes without it |
| `non3gpp` | failed once on a harness assertion, then passed 4 of 4 | hung until killed at one of the same perturb values |

So `vonr` and `non3gpp` are intermittent on both trees, and none of these tests involve
charging. The samples are too small to show that the failures are the same bug, or to
rule out a difference in rate. Their signatures point at start-up, not at anything
these patches change.

**Three defects, all fixed.** *The CHF did not build on mongo-c-driver 2.x*, although
`lib/dbi` supports it and every other NF built there. `db-handler.c` included
`<mongoc.h>` directly, a path 2.x no longer has. `cdr-record.h` pulled in asn1c's
statement-expression `MIN()` before the bson headers, which breaks a file-scope constant
in 2.x. And `bson_append_array_begin()` is deprecated there, with its replacement absent
from older drivers. The query now goes through `BCON_NEW()`, and its bytes were checked
unchanged on both drivers. *54 generated CDR files named the machine they were generated
on*, in their banners. `generator.sh` now passes the module path relative to the output
directory, as NGAP and S1AP do. *`chf_cdr_bytes_total`'s help text said JSON*, while it
counts every encoding.

**Three limitations nobody had written down**, now in §11. Traffic on a dedicated QoS
flow is not charged at all, where limitation 1 had claimed it was merged. A CHF that
stops answering leaves new sessions hanging. And with no CHF, sessions run free. The last
two were seen by freezing the CHF on the rig: both Creates timed out with no refusal
while the UE retransmitted, the NRF dropped the CHF 8 s after the freeze, a fresh attach
then carried 42 MB with 0 bytes charged, and on thawing, the CHF processed the late
Creates and left 2 orphan rows in `chf.sessions`. None of the three is fixed: each
changes what the SMF does, and the last two are a policy decision (§12).

The rig itself got in the way again. Unattended upgrades ran during the VM build, though
this time they did not restart `mongod`. And upstream's suites deleted the rig's
subscriber, as expected (16 documents went from `subscribers`), so it was restored from a
`mongodump` taken before they ran.

Commit hashes in the dated records below name the branch as it stood then. A replant
rewrites them, so look one up by its subject.

**The QA round and regression (2026-10-30)** was a round of checking rather
than of new features: read the code that changed on 2026-10-29 again, run the
C suites under sanitizers, run upstream's own test suites against the patched
tree, check the documents against the code, and then repeat the rig regression
from a pristine base. Upstream had not moved, so there was nothing to rebase.
It found two defects and a limitation nobody had written down, all now dealt
with.

| What | Result |
|---|---|
| Code review of the 2026-10-29 fixes | the new 400 for an unparseable Update is safe: the SMF ignores a non-2xx Update (`gsm-sm.c`) and keeps the session. What it costs was undocumented, and now is: limitation 13 in §11 |
| `chf_metrics_final()` | left the spec tables pointing at freed specs. Harmless for a process about to exit, but a second init in the same process would have used them; it now clears them (`66031a474`) |
| C suites under ASan + UBSan | all 7 suites and `chf-cdr-decode` clean, with a deliberate canary first proving the sanitizers were live. LeakSanitizer does not run on macOS arm64, so leaks were not checked |
| Upstream's test suites, patched tree | on 5GC, registration, slice, VoNR, both EIR suites and handover pass; on EPC, attach, VoLTE, CSFB, non-3GPP and `310014`. `transfer` and `transfer-error` fail and EPC `handover` times out, **identically on a pristine `51ee7ca07`**, and only under the `MALLOC_PERTURB_` meson sets: unperturbed, all three pass on both trees. They are upstream heap-content bugs, not ours |
| Documents against code | 49 function names and 65 file paths cited, none missing; metric names and config keys agree with the code |
| WebUI | 159 tests, and the 9 opt-in tests against the rig's MongoDB: 6/6 TMF, 3/3 REST. The REST three fail on the model without the fix below and pass with it |
| Patch set, applied on the VM | all eight (`007e6e90b`) on a pristine `51ee7ca07`, no fuzz, then built and installed |
| Heartbeat condition | 13 NFs up, **0 CHF errors** |
| ChargingNotify | 2 sent, 2 acknowledged |
| Slice isolation | catch-all **0**; `slice1sd1` 63,064,524 of 60 MB, `slice1sd2` 42,076,546 of 40 MB, both `volumeLimit` |
| CDRs | 2 JSON + 1 aggregated BER; **2 of 2** matched their BER record |
| Live TC-12 | PASS |
| Over-the-wire API suite | 43/44 on the first pass — TC-P6-1 got a transient `000` (no HTTP answer) from the WebUI — then **44 / 44** on the rerun |
| Shutdown with a populated metrics table | 3 labeled series live, SIGTERM, exit **0**, no cores |
| Errors | CHF **0**, SMF 8 (the PCF `sm-policies` delete race), UPF 1, AMF 284 — the documented residuals |

**The WebUI defect.** A subscriber created through `POST /api/db/ChfSubscriber`
without a `bucketId` was stored without one. That resource is addressed by
`bucketId`, so the subscriber could not be read, edited or deleted by its SUPI
— every such request answered 404 — until the next WebUI restart, whose
start-up migration backfills the id. The CHF Quota page sends no `bucketId`,
so a bucket created there was stuck until a restart, and so was every
subscriber `test-chf-api.sh` Phase 6 created: its cleanup DELETE had been
answering 404 on every run, behind an `|| true`, and the rig's
`chf.subscribers` had accumulated 26 of them. The model now assigns the id at
validation, by the rule the TMF API and the migration already use — the SUPI
for a catch-all, `<supi>-<12 hex>` for a scoped bucket — and an explicit id is
kept. Phase 6's cleanup now prints the status of a DELETE that fails rather
than discarding it; it is still cleanup, so it does not fail the run.

That fix is in the patches (`4b02bd16c`) and was proven on the rig's MongoDB by
the opt-in REST tests, A/B against the model without it. It is **not** in the
WebUI the rig is running, which was deployed before it and has not been
redeployed; until it is, the 404 and the leak persist there. The 26 leaked
documents are still in the rig's `chf.subscribers` (SUPIs `imsi-999701…` and
`imsi-999702…`), all test data.

**Two hazards the rig itself presented, neither the CHF's.** Unattended
upgrades ran during the regression and restarted `mongod` four times
mid-run while it upgraded OpenSSL, libcurl, zlib, OpenSSH, sudo and systemd
among others; a kernel upgrade is pending a reboot. And upstream's test suites
provision a subscriber with the IMSI of the rig's own, `999700000000001`, and
delete it when they finish: running them against the rig's MongoDB removed
the rig's subscriber. It was restored from a `mongodump` taken before the suites
ran. Upstream's suites should be run against a database of their own.

**The 51ee7ca07 regression (2026-10-29)** is the rig run session 59 postponed.
Upstream had not moved since, so there was nothing to rebase, and it ran the
way §5.6 documents: the VM reset to a pristine `51ee7ca07`, the eight committed
patch files applied there with checksums matching the commit, then built and
installed. That base brought in upstream's `ogs_hash` key-ownership change,
which broke the CHF in three places (§13.6), so the double free in
`chf_metrics_final()` had to be checked on the rig rather than trusted to
`METR-5`.

The run then found two more CHF defects, both through the over-the-wire suite
once it could run at all, and both fixed before the final pass. Everything in
the table below comes from a clean rebuild of the committed fixes, patches
`e03133f29`. One string changed after that - the error label for an
unparseable request, renamed from `bad_request` to the `parse` the metrics
plan already documented - so the final patches, `d5fcf705d`, were rebuilt on
the VM from a pristine base and re-run for what that string touches: the unit
suite, the API suite at 44/44, and a scrape showing
`chf_errors_total{kind="parse"} 2` with no `bad_request` series.

| What | Result |
|---|---|
| Patch set, applied on the VM | all eight on a pristine `51ee7ca07`, no fuzz, checksums matching the commit |
| Build and unit suite | whole tree clean; 7 suites / **79 cases** plus `chf-cdr-decode` |
| Heartbeat condition | 13 NFs up, CHF alive through eight heartbeat intervals, **0 CHF errors** |
| Slice isolation | catch-all **0**; `slice1sd1` 63,002,688 of 60 MB, `slice1sd2` 42,057,666 of 40 MB, both `volumeLimit` |
| Encodings agree | **147 of 147** JSON CDRs matched their BER record — every record written that day, API-suite sessions included, so zero-volume and `normalRelease` records were covered as well as the rig's two |
| Live TC-12 | PASS |
| ChargingNotify | 2 sent, 2 acknowledged, 0 failed — run first, while the quota was fresh and the sessions live |
| Over-the-wire API suite | **44 / 44** |
| Shutdown with a populated metrics table | 3 labeled series live, SIGTERM, exit **0**, no cores — `chf_metrics_final()` walked keys without the double free |
| Errors | CHF **0**, SMF **0**, UPF 5, AMF 295 — the documented residuals; the AMF's count tracks the 297 bucket selections less the two that succeeded |

**The two defects.** *An exhausted session stayed exhausted after a recharge.*
`final_unit` is set-only, and the Update handler's fresh-read re-base raised
the ceiling without clearing it, despite a comment claiming the re-base made
any special case unnecessary. Every later response still carried a
FinalUnitIndication. *An Update whose body did not parse was answered 200.*
`lib/sbi` dispatches it with no ChargingDataRequest, and the handler read that
as zero usage, so it granted a fresh slice and silently dropped whatever the
SMF had reported.

The first is fixed by `chf_quota_revive()`, which clears the flag only on the
genuine transition, so a session that stays exhausted is not re-counted on
every Update. `QU-19` pins it in the unit suite and TC-10f over the wire. The
second now gets a 400. A Release with an unparseable body still releases,
because refusing it would orphan the session, but it now logs the lost final
report. TC-ERR-3 pins the 400. Each test fails against the binary without its
fix.

**How far the first fix reaches on this rig, stated plainly.** Create sets the
final unit only for a zero quota, and an Update sets it only once usage reaches
the ceiling, which means the grant that carries the FUI is zero. This SMF
terminates on FUI for every action (§11, limitation 2), so an exhausted session
is gone by the time anyone recharges it. On this core the fix therefore matters
in the race between FUI and teardown, and over the wire. It matters fully once
REDIRECT or RESTRICT_ACCESS keep the session up — which is precisely the "top
up to lift the restriction" flow, and the one that would otherwise fail.

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
  private directory.
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

1. **One rating group per session.** A session's usage counts against one bucket under one
   rating group, hard-coded to 1, whichever QoS flow it uses. PCC charging keys are not
   read, so charging different services within a session differently is not possible. On a
   session the CHF does not charge, each flow keeps its own URR, as upstream.
2. **REDIRECT and RESTRICT_ACCESS are signalled but not enforced.** The CHF
   sends the chosen `finalUnitAction`; the SMF tears the session down for all
   three. There is no redirect server or restricted filter. One consequence
   worth knowing: because an exhausted session is torn down as soon as the
   FinalUnitIndication arrives, a top-up cannot revive it on this core. The
   CHF side of that is done - since 2026-10-29 a recharge clears the final
   unit on the next Update (`chf_quota_revive()`) - so enforcing either action
   in the SMF is all it would take to make "top up to lift the redirect" work.
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
   With several CHFs on one database, each reads every row once and reaches the
   sessions it holds. Rows are deleted five minutes after the first read, so
   every CHF must poll within that time: give them the same `poll_seconds`.
   Until 2026-11-14 the first CHF to poll deleted the rows it read, and sessions
   on another CHF never heard.
7. **Multi-device overspend up to one slice per device.** Two devices on one
   plan can each be granted a slice before either reports.
8. **Mid-session provisioning only picks up the catch-all.** A *scoped* bucket
   created while a session is running applies from that subscriber's next
   session.
9. **Session-pool ceiling is preallocated** at `max.ue × 4`; raising it costs
   memory at start-up, and every NF must be raised together. A full pool answers
   500 `INSUFFICIENT_RESOURCES`, and the SMF takes that as a CHF that cannot charge:
   an ordinary session is refused with `NETWORK_FAILURE`, and `ims`, `sos` and
   `mcptt` are set up uncharged. Which sessions meet the full pool depends on the
   order their requests arrive. The rig has shown both: `internet` refused
   (2026-11-07), and `internet` charged while the other three ran uncharged
   (2026-11-13).
10. **No OAuth2, and TLS barely run.** The SBI transport is whatever Open5GS is
   configured for. The CHF has a certificate and starts HTTPS with it, and the
   certificate verifies against the CA. An SMF talking to a CHF over TLS has not been
   run, and neither has OAuth2.
11. **Home-routed roaming is not tested.** The roaming dimension is populated
    from the serving/home PLMN comparison, but no HR-roaming rig exists here.
12. **Not certified**, against either 3GPP conformance or the TMF CTK.
13. **A failed Update loses the interval it reported.** The SMF advances its
    reported-usage watermark when it *builds* an Update, not when the CHF
    answers - the same point upstream's Gy path advances it - so every octet is
    counted exactly once however PFCP reports and CHF responses interleave. The
    cost is that a request that fails is not re-sent: a CHF that is restarting,
    unreachable, or answering 4xx/5xx leaves that interval unbilled, and the
    session carries on with its last grant (the SMF logs the failure and does
    not tear the session down). TS 32.291's `invocationSequenceNumber` would let
    a CHF de-duplicate a retry, which is what fixing this would need. Since
    2026-10-29 a body the CHF cannot parse gets 400 rather than a 200 that
    dropped the usage just the same - so the loss is now visible on both sides,
    not new.
14. **Losing the UPF loses what it had not reported.** When the UPF does not
    answer a deletion, the SMF sends the CHF Release with the usage it has so
    far, because otherwise the CHF session would never close. The interval since
    the UPF's last report goes unbilled. Since upstream's `926550203` a UPF that
    loses its SMF deletes that SMF's sessions as soon as heartbeats fail, rather
    than holding them until the SMF returns, so after an N4 outage long enough
    to fail heartbeats that usage is gone on both sides.
    A UPF that restarts loses it the same way. On the rig, the SMF released both
    sessions, the UE set them up again at once, and the 3 MB pulled before the
    restart was billed as 0. The new sessions are charged from their first byte.
    Until 2026-11-07 the CHF never heard that the replaced sessions had ended:
    no CDR, and each held a slot in its session pool.
15. **A CHF that stops answering costs a wait, and can leave a row behind.** The SMF
    gives up on a Create after the SBI client wait, about 10 s: an ordinary session is
    refused with `NETWORK_FAILURE`, and `ims`, `sos` and `mcptt` are set up uncharged.
    Until 2026-11-01 it hung instead. If the CHF comes back, it still processes the late
    Create and leaves a row in `chf.sessions` that no SMF will ever release, seen on the
    rig as 4 orphan rows after thawing a frozen CHF.
16. **With `ctf.enabled: auto`, no CHF means no charging.** Once the NRF drops a CHF, 8 s
    after it froze on the rig, new sessions are set up as if charging were not configured:
    42 MB flowed with 0 bytes charged and no session at the CHF. Such a session stays
    uncharged after the CHF returns, since it has nothing to report against. That favours
    service over revenue. `ctf.enabled: yes` chooses the other way and refuses them. Under
    `yes`, reading the code and not run: a session already charged when its CHF goes is
    released at its next usage report, except `ims`, `sos` and `mcptt`.
17. **Only IMSI subscribers can be provisioned.** The WebUI and the TMF API accept a
    bucket only for `imsi-` plus 15 digits. The CHF itself accepts any well-formed SUPI,
    so a subscriber with another kind, such as an NAI, always gets `default_quota`, or
    is refused under `unprovisioned: reject`.
18. **A SIM swap does not wait for the old SIM's sessions.** They are sent
    `ABORT_CHARGING`, and what they report after the swap, including their final
    report, is in their CDRs but is not taken from the moved balance: at most one
    grant per session. The swap moves balances only. The new SIM is added to the
    subscriber database as usual, and the old SUPI, left without a bucket, gets
    `default_quota` until it is removed there. A session the new SIM already has on
    the default quota moves to its catch-all bucket only (limitation 8).


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
packet. Also done since: the TS 32.298 record in BER and JSON, the generated
TS 32.291 models, CHF selection by slice, `ims`, `sos` and `mcptt` kept out of quota
management, `ctf.enabled: yes`, dedicated QoS flows counted, and the packaging that
puts the CHF beside the other NFs (§1).

**Small, and still open:**

- **Build and install the Debian package.** Its file list was checked against a build,
  but the package itself has never been built.
- **Run the SMF and the CHF over TLS, and with OAuth2.** The CHF serves HTTPS with its
  certificate; no SMF has talked to it that way.
- **A `chf:` section for `configs/examples/`,** once roaming with a CHF has been tested.
- **Provisioning for non-IMSI SUPIs** (limitation 17).
- **Tests for the SMF's charging state machine.** The SMF has no unit tests, so every check
  of it is a rig run or a reading of the code.
- **The declared meson minimum.** `src/chf` and `tests/chf` use features from 0.46 and
  0.47, and the project declares 0.43.

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
the honest measure here — almost nothing is deleted. They are `git apply
--numstat` totals as of 2026-11-13; earlier versions of this table counted the
`+++` header lines too, and some rows had not been recounted since the phase
grew.

| # | Patch | Files | Added | What it contains | Depends on |
|---|---|---|---|---|---|
| 1 | `chf-phase-1-generated-code` | 565 | 76,603 | Everything machine-generated, and the two spec bundles that generate it: the TS 32.291 models from openapi-generator, and the TS 32.298 CDR codec from asn1c. Read the two `generator.sh` scripts and the `patched/` diffs; skip the output | — |
| 2 | `chf-phase-2-shared-libs` | 10 | 430 | Shared libraries: a CHF's NRF profile carries `supiRangeList` and discovery matches a SUPI against it; the charging payloads on `ogs_sbi_message_t`; PFCP gains Quota Holding Time on Update URR | 1 |
| 3 | `chf-phase-3-chf-complete` | 81 | 17,172 | The CHF network function itself, its config, its CDR writer in both encodings, the generated Python decoder, and its tests. Also its packaging, its place in the test harness and its user guide. Nothing else outside `src/chf/`, `tests/chf/` and `configs/` but the registrations | 1, 2 |
| 4 | `chf-phase-4-smf-selector` | 2 | 299 | SMF: which charging interface a session uses, the CHF's own accounting state, and counting a charged session's flows on one URR | 2 |
| 5 | `chf-phase-5-smf-nchf-client` | 8 | 1,744 | SMF: the Nchf client — request building, grant handling, URR programming, the ChargingNotify handler, and usage taken from PFCP reports | 1, 2, 4 |
| 6 | `chf-phase-6-smf-wiring` | 9 | 624 | SMF: the state machine — when Create/Update/Release are sent, the ChargingNotify endpoint, release on exhaustion, refusal with back-off | 5 |
| 7 | `chf-phase-7-webui` | 53 | 16,723 | Provisioning: TM Forum APIs and a SIM swap, the two CHF pages, the start-up migration, the ChargingNotify queue. 8,469 of those lines are `package-lock.json` | 3 |
| 8 | `chf-phase-8-upf-quota-holding` | 2 | 151 | UPF: the Quota Holding Time idle timer, so an unused grant comes back to the cycle | 2 |

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
the SMF's state machine, the WebUI, the UPF. A fix made late to the CHF goes into phase 3
next to the code it fixes, however long after phase 3 was first written. The
patches are therefore always a description of the *current* system, never a
history of how it got there — that is what the git log is for.

**Every changed file belongs to exactly one phase.** No file is split across
two patches. This is checked mechanically on every regeneration, and it is what
makes a patch reviewable on its own: you never have to hold half a file in your
head while reading another patch to find the rest.

**Ordered so each phase stands on the one before.** Phase 1 supplies the
generated models before anything parses into them; phase 2 adds discovery and
the message payloads before phase 3 uses them; phase 5 adds the Nchf client
before phase 6 calls it. A reviewer reading in order never meets a call to something
that does not exist yet, and no row of the table above points forwards. Phases 7 and 8 are leaves — nothing depends on either — so their
order between themselves carries no meaning.

One consequence worth stating plainly: phases are not independently *runnable*.
Phase 1 alone gives you models nothing uses; phases 1–3 give you a CHF that
nothing talks to; phases 1–5 give you a core that behaves as upstream, CHF or no CHF;
phases 1–6 give you a working charged core with no provisioning UI and no idle-quota
reclaim. Each of those steps works, and was checked with live traffic, but they are
units of review, not release increments. [patches/README.md](../patches/README.md) goes
through it patch by patch.

### 13.3 What is checked on every regeneration

The patches are generated from the branch, never edited by hand, and four
invariants are verified each time:

1. **Coverage** — the set of files changed since the base equals the set of
   files across the eight patches. Currently 730 files, 0 mismatches.
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
| 1 | Is the generator wired the way upstream wires the other specs, and do the schema renames leave every other NF's models untouched? | Core maintainer — 565 files, but only the `generator.sh` lines and the `patched/` spec edits are hand-written |
| 2 | Is the shared library change safe for every NF, not just the CHF? | Core maintainer — smallest patch, highest blast radius |
| 3 | Is the charging logic right — quota arithmetic, cycle handling, the records? | Charging / BSS |
| 4–6 | Does the SMF do the right thing at the right moment, and is the EPC path untouched? | SMF / session maintainer |
| 7 | Are the APIs and the UI correct, and can they corrupt the CHF's counters? | Web / BSS integration |
| 8 | Does the new idle timer measure and report what it claims, and can it disturb a session that is busy? | UPF / user-plane maintainer |

**Generated code is quarantined.** Phase 1 is by far the largest patch and the
least to read: 565 files, of which all but the `generator.sh` line and the
`patched/` spec diff come out of openapi-generator. Keeping it apart is what
lets phase 2 — the hand-written shared-library change every NF links — stay at
430 lines and get the close reading it deserves.

**Blast radius is visible from the size.** Phase 2 is 430 lines and touches code
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
feature upstream lacks. A single 730-file branch offers only accept or
reject.

**Rebasing stays honest.** When upstream moves, the branch is replanted and the
patches regenerated and re-verified against the new base. The latest replant,
onto `39a8c771f` on 2026-11-11, moved four upstream commits in the MME and the AMF
with no conflicts, and **not one patch file changed** — not even a hunk offset.
That is the cleanest form of the signal that upstream changed nothing this work
depends on. The one before it, onto `5ff0dc56f`, moved twenty-seven commits, also
without a conflict, and still needed a change: upstream had started validating
SUPIs in every NF, and the CHF had no such check. A clean replant says the patches
still apply. It does not say they are still right, which is what §13.6 is about.

### 13.5 Applying and re-verifying

```bash
# apply to a clean checkout of the recorded base (copy patches/ out first: the base has none)
for p in patches/chf-phase-*.patch; do git apply --whitespace=nowarn "$p"; done

# what the regeneration checks: coverage, duplication, apply, byte-compare
git diff --name-only <base> HEAD \
  | grep -vE '^(patches/|docs/CHF-|CHF_(DEVELOPMENT_PLAN|TECHNICAL_OVERVIEW)\.md$)' \
  | sort > /tmp/changed
cat patches/*.patch | grep '^diff --git' | awk '{print substr($3,3)}' | sort > /tmp/in-patches
comm -3 /tmp/changed /tmp/in-patches    # must be empty
```

**`--whitespace=nowarn` is not cosmetic, and `--whitespace=fix` must not be
used.** Applied without the flag, phase 1 reports whitespace warnings — five
lines, then `squelched 1048 whitespace errors` and `1053 lines add whitespace
errors`. They are expected, and they are confined to phase 1; phases 2 through
8 are silent. Phase 1 is the generated-code phase, and every offending line
comes from something we do not write by hand. These counts are per line, from
`git apply --check --whitespace=error-all`:

| Origin | Lines |
|---|---:|
| `lib/sbi/openapi/` — openapi-generator output | 599 |
| `cdr-r19.6.0/standard/` — pristine 3GPP Forge modules | 290 |
| `lib/asn1c/cdr/` — `asn1c` output and its runtime skeletons | 122 |
| `cdr-r19.6.0/modified/` — `closure.py` output | 23 |
| `lib/sbi/support/` — 3GPP text carried over in `patched/` and `modified/` | 18 |
| `cdr-r19.6.0/patched/` — ours, but copied verbatim from the spec | 1 |

The one in `cdr-r19.6.0/patched/` is a comment copied with its trailing space.
Keeping it is what makes "copied verbatim apart from the comma" true and keeps a
diff against `standard/` showing only the intended change. The 18 in
`lib/sbi/support/` are the same kind of thing: a TS 28.541 `$ref` line that
already ended in spaces, and the descriptions in the TS 29.571 definitions copied
into the TS 32.291 file, each counted once in `patched/` and once in `modified/`.

Three modes, and only one is right:

- `--whitespace=nowarn` (what the command above uses): exits 0, silent, tree
  byte-identical to the branch.
- **default (`warn`)**: exits 0 and applies correctly — the warnings are
  noise, not a failure. Verified: all eight patches exit 0 and all 730 files
  come out byte-identical.
- `--whitespace=error`, or `apply.whitespace=error` in the user's git config:
  **exits 128 and phase 1 does not apply.** If a clean checkout refuses the
  patch, check that setting first.
- `--whitespace=fix`: exits 0 and **silently rewrites 470 files**, stripping
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

**It happened again on 2026-10-26, three ways at once**, which is why this
section exists rather than being a note on one commit. Upstream's
`d6e4125e5` made hash tables copy and own their keys and `8f4d0aa86` replaced
the chained tables with Robin Hood hashing. Its own commit message says it
updated the SBI and metrics callers "to stop allocating and freeing hash
keys" — and `src/chf` is a metrics caller that nothing updates. The rebase
was conflict-free. What it left behind:

| Where | What the contract change did to it |
|---|---|
| `chf_metrics_final()` | Took each key from `ogs_hash_this_key()` and freed it after removing the entry. Correct while the table stored our pointer; now that is the table's own copy and the removal already frees it, so this was a **second** free — heap corruption on CHF shutdown |
| `chf_metrics_inst_labeled_add()` | Inserted `ogs_memdup(&key, …)`, which the old contract required. The table copies now, so that allocation was leaked per labeled series |
| `add_pdu_session_info()` | Called `ogs_hashfunc_default()`, which `8f4d0aa86` deleted outright — the only one of the three that failed to compile |

**The honest correction to the paragraph above:** "the next change to it fails
a test instead of crashing a daemon" is true of the pool-id contract, which
`SBI-17` pins, and is not a general guarantee. No test caught any of these
three. The compiler caught one. The other two were found by reading the
upstream commits — and at the time the double free was **unreachable from
the unit suite**, which started no metrics context, a property
`tests/chf/chf-metrics-test.c` documents deliberately because every other
suite depends on instrumentation being a no-op without one. So the suite as
it stood could not see the worst of the three, and a green suite after a
replant that touches `lib/core` or `lib/sbi` should not be mistaken for
safety.

**That particular blind spot is now closed.** `METR-5` starts a real metrics
context, populates the labeled table, and calls `chf_metrics_final()` with
keys in it. Reinstating the old teardown makes it abort in
`chf_metrics_final()` under talloc's double-free check, so the case is known
to catch the defect rather than merely to cover the line. It runs last in its
suite and leaves no context behind, because the four cases before it require
that none is running and the suites after it instrument global metrics.

Closing it needed two things worth knowing. The spec pool is sized from
`ogs_app()->metrics.max_specs`, which a daemon gets from config and a test
does not, so `tests/chf/abts-main.c` sets it as it already sets the other
pool sizes. And one init/final per process is all the stack supports: a
second `chf_metrics_init()` segfaults, because
`prom_collector_registry_destroy()` frees the default registry while
clearing only its own local parameter, leaving the library's global dangling
for the next `prom_collector_registry_default_init()` to accept as already
initialised. That is a prometheus-client-c limitation, not a CHF one, and
`METR-5` documents it instead of working around it.

The practical rule this adds: **read the upstream commits that touch
`lib/core` and `lib/sbi`, especially their commit messages.** This one
announced exactly which callers it had updated, and the CHF's absence from
that list was the whole finding. `git log --oneline <old>..<new> -- lib/core
lib/sbi` is a cheaper diagnostic than any amount of rig time.

**The 2026-11-01 replant widened that rule.** The commit that mattered on
`b60aad44e` touches neither directory. `5c4d307ff` adds one `else` to
`src/smf/smf-sm.c`, and that `else` changes what `e->h.sbi.data` holds on the
SBI client path: 0 where it used to be a transaction ID, which is always in
range. Git merged it silently. Our `wait_5gc_nchf_create` reads that value with
no range check on every Create of a non-roaming session. It holds only because
the stream lookup is a hash lookup that returns NULL for 0, and nothing would
have caught it short of a rig run if the lookup had asserted, since libsmf has
no unit tests. So the command to read is now
`git log --oneline <old>..<new> -- lib/core lib/sbi lib/pfcp src/smf src/upf`.

**It happened again on 2026-11-06, with nothing to compile against.** `3e007ddf0` moved graceful
shutdown onto each NF's worker thread and changed every SBI NF upstream maintains. The CHF's old shutdown still
compiled, because every function it called still existed; it just kept the race the commit removes. Only
reading the commit, and then `src/chf/init.c` beside `src/udr/init.c`, showed it.

**The 2026-11-04 replant added a question, and widened that command again.** Everything
above asks whether upstream broke something the CHF relies on. `5c437e9c2` broke nothing: it
fixes a bug in the PCF, UDM and AMF, narrowing `pduSessionId` to a `uint8_t` unchecked, and
the CHF had the same bug. It also touches none of the directories in that command, and turned
up only because the whole log was read. So read all of `git log <old>..<new>`, messages
included, and of every fix upstream makes to its own NFs ask whether `src/chf` makes the same
mistake, since nothing will update it.

**The invariants compile nothing, and the usual builds only ever saw one
configuration.** Building each patch in turn for the first time, on 2026-11-01, showed
two things they could never catch. Phase 4 alone did not build the SMF, because
`n4-handler.c` includes a header from phase 5, which the documents had been denying
("every dependency points backwards"); `n4-handler` then moved to phase 5, which makes
that claim true. And the CHF did not build at all against mongo-c-driver 2.x, although `lib/dbi` supports it and every other
NF built there: every earlier build had used 1.x. So on a machine with only 2.x, phase
3 was the one that broke the tree. A build against each driver, and a build after each
patch, are cheap checks worth repeating when either is in doubt.

**A test that cannot run hides regressions as well as missing them.** The
2026-10-29 run turned up a second kind of silent failure, unrelated to
upstream. `tests/chf/test-chf-api.sh` is not a meson test, because it needs a
live CHF, and it had stopped working: every request it sent predated the R19
model's mandatory members. While it was broken, the CHF's handling of a
recharge after exhaustion regressed and nothing noticed, because TC-10f, the
one case that exercises it, never got that far. Session 54 found the same
script rotted in its CDR assertions. The rule that follows is cheap: run it on
every rig regression, and treat a run that cannot get past TC-1 as a failure
of the regression, not as a skipped test.

**A test listed as not run is where the next defect waits.** The rig records had
carried "not run: a UPF restart under a charged session" for three rounds. The
first time it ran, on 2026-11-07, it found CHF sessions that were never released.
The SMF path that dropped them is upstream's own handling of a Create for a
session ID it still holds, which a UE reaches only after the network releases its
sessions with reactivation requested. Nothing short of running that sequence would
have reached it.

**It happened again on 2026-11-09, and this time it was billing.** `8d6c52518` made
every NF upstream maintains validate a SUPI before using it. The CHF took any string:
`imsi-`, sixteen digits, even an empty one, each got a 201 and the default quota, and
would have reached a CDR as the subscriber. Nothing conflicted and nothing failed to
compile. It was found the way the rule above says, by reading the log and asking whether
`src/chf` makes the mistake upstream had just fixed in its own NFs.

**A run that exits 0 has not necessarily tested anything.** Three times in one week
a rig run passed, or was about to, while exercising less than it claimed:

- the gNB advertised one slice, so the second session was refused and the slice
  isolation test passed with nothing to isolate;
- the API suite's default address had moved, so against the rig's CHF it would have
  skipped every case;
- a done-marker left by an earlier `meson test` made the next one look finished the
  moment it started.

Each was caught by a number that should not have been what it was: a bucket at 0, a
count of cases, timings equal to the hundredth. So a result is read for what it
exercised, not only for its exit status: two tunnels up, both slices non-zero, the
number of cases run, and a CHF seen running.

---

## 14. Appendix — where things live

| Path | Contents |
|---|---|
| `src/chf/` | The CHF: `nchf-handler.c` (the service), `context.c` (quota and bucket logic), `db-handler.c` (MongoDB), `cdr-record.c` and `cdr-json.c` (the TS 32.298 record and its JSON form), `cdr-path.c` (filing), `metrics.c`, `sbi-path.c`, `chf-sm.c`, `init.c` |
| `src/smf/nchf-build.c`, `nchf-handler.c` | The SMF's charging client: request building, grant handling, URR programming |
| `src/smf/context.c` | Which charging interface a session uses (`smf_select_online_charging()`), and `ctf` parsing |
| `src/smf/n4-handler.c` | CHF accounting from PFCP reports, kept apart from Gy's |
| `src/smf/smf-sm.c` | Routing of CHF responses and timeouts, the `charging-notify` callback, and the Release for a replaced session |
| `src/smf/gsm-sm.c`, `namf-handler.c`, `gsm-build.c` | Release on exhaustion, refusal with back-off |
| `src/chf/notify-path.c` | ChargingNotify: the queue poller and the outbound request |
| `configs/systemd/open5gs-chfd.service.in`, `debian/open5gs-chf.install`, `configs/open5gs/tls/chf.*` | The systemd unit, the Debian package and the demo TLS certificate |
| `tests/app/5gc-init.c`, `tests/app/app-init.c`, `configs/*.yaml.in` | Where the test harness starts a CHF, and the section each test config gives it |
| `docs/_docs/guide/04-chf.md` | The user's guide |
| `lib/sbi/` | CHF NF profile and SUPI-range discovery |
| `lib/pfcp/`, `src/upf/context.c` | Quota Holding Time: the IE on Update URR, and the UPF's idle timer |
| `webui/server/tmf/` | The TM Forum APIs, and the SIM swap (`sim-swap.js`) |
| `webui/src/{components,containers}/Chf*` | The CHF Quota and CHF Sessions pages |
| `tests/chf/` | Unit suites, plus `test-chf-api.sh` for a live CHF, `test-dedicated-flow.sh` for what UERANSIM cannot reach, and `test-notify-two-chfs.sh` for several CHFs on one queue |
| `lib/sbi/context.c` (`ogs_sbi_dnn_is_well_known()`) | Which DNNs are outside quota management, shared by the CHF and the SMF |
| `lib/sbi/openapi/model/charging_*` | TS 32.291 models from openapi-generator |
| `lib/asn1c/cdr/`, `lib/asn1c/support/cdr-r19.6.0/` | The TS 32.298 CDR codec from asn1c, and the bundle that generates it |
| `docs/CHF-Metrics.md`, `docs/CHF-TMF-API.md` | Every metric, and the northbound API |
| `lib/sbi/support/r19-20260402-openapitools-7.20.0/` | The spec bundle: `standard/` → `patched/` → `transform.py` → `modified/` → `generator.sh` |
| `patches/` | The eight phases, applied to upstream in order — generated models first. `README.md` says what each contains and whether Open5GS works after it |

The patch set and how it is split is described in §13.
