# CHF patches

Eight patches that add a 5G Charging Function (CHF) to Open5GS. They apply in
order to upstream commit `39a8c771f`, and are generated from the development
branch, never edited by hand.

```sh
cp -r patches /tmp/chf-patches     # the base commit has no patches/ directory
git checkout --detach 39a8c771f
for p in /tmp/chf-patches/chf-phase-*.patch; do git apply --whitespace=nowarn "$p"; done
```

Keep `--whitespace=nowarn`: patch 1 carries pristine 3GPP files and generated code
whose trailing whitespace is part of the result. Do not use `--whitespace=fix`.

This page is for whoever maintains Open5GS or carries these patches. It says what
the set changes, what it leaves alone, what it depends on, how far it has been
tested, and how to keep it current. For the design, compliance and limitations, see
[`docs/CHF-Technical-Overview.md`](../docs/CHF-Technical-Overview.md); section 13
explains why the set is split this way. Every metric is in
[`docs/CHF-Metrics.md`](../docs/CHF-Metrics.md), and the northbound API in
[`docs/CHF-TMF-API.md`](../docs/CHF-TMF-API.md). For installing and running a CHF, see the
user guide, [`docs/_docs/guide/04-chf.md`](../docs/_docs/guide/04-chf.md).

**Contents**

- [The set at a glance](#the-set-at-a-glance)
- [What changes for an existing deployment](#what-changes-for-an-existing-deployment)
- [Does Open5GS still work after each patch?](#does-open5gs-still-work-after-each-patch)
- [Reviewing the patches](#reviewing-the-patches)
- [What the patches rely on in Open5GS](#what-the-patches-rely-on-in-open5gs)
- [Packaging, tests and what is left out](#packaging-tests-and-what-is-left-out)
- [Third-party material](#third-party-material)
- [Bringing it into Open5GS](#bringing-it-into-open5gs)
- [Keeping the set current](#keeping-the-set-current)
- [Turning it off](#turning-it-off)
- [The patches](#the-patches)

## The set at a glance

| | |
|---|---|
| **Base** | `39a8c771f` (Open5GS main) |
| **Size** | 730 files: 649 new, 81 changed. 113,746 lines added, 3,546 removed |
| **Generated** | Patch 1 is 565 of those files: 542 generated C files, and the specification inputs, generator scripts and build lists behind them |
| **Written by hand** | CHF about 8,800 lines, its tests 7,500, SMF 2,700, `lib/` 440, UPF 150, WebUI 5,500 plus 2,700 of tests |
| **New process** | `open5gs-chfd`, laid out like the other SBI NFs: one worker thread, one state machine. SBI on `127.0.0.30:7777`, Prometheus on port 9090 |
| **New dependencies** | No new C library. It needs MongoDB, through the same `db_uri` setting as the other NFs. The WebUI gains `jest` for its tests, and `prom-client` as an optional extra |
| **Database** | Four new collections for the CHF: `chf.subscribers`, `chf.sessions`, `chf.cdrs`, `chf.notifications`. Four for the WebUI's TM Forum APIs: `tmf.individuals`, `tmf.billingAccounts`, `tmf.topupBalances`, `tmf.simSwaps`. `subscribers` and the other existing collections are not touched |
| **On disk** | CDR files under `log/open5gs/cdr`, by day. Nothing deletes them |
| **Switch** | `ctf.enabled` in `smf.yaml`: `auto` (the default), `yes` or `no`. This is upstream's existing key, and it also governs Gy |
| **Packaging** | Like the other NFs: a systemd unit, a Debian package, test configs, a place in the test harness, a TLS certificate and a user guide. See [Packaging, tests and what is left out](#packaging-tests-and-what-is-left-out) |
| **Last tested** | On this base: the complete set on the rig, with the CHF in upstream's test harness, and macOS, on 2026-11-13; the ChargingNotify change of 2026-11-14 on macOS only; the live run after every patch on 2026-11-11. See [How this was checked](#how-this-was-checked) |

## What changes for an existing deployment

Applying the patches does not start charging. A source build starts no CHF, the `open5gs`
Debian package does not pull one in, and with none registered at the NRF the default
`ctf.enabled: auto` charges nothing. These are the things that do change:

1. **Charging starts by itself when a CHF registers.** The SMF subscribes to CHF status at
   the NRF. Under `auto`, every new 5GC session is charged as soon as a CHF is known, with
   no SMF configuration. A SUPI with no provisioned bucket gets `default_quota` from
   `chf.yaml`, 10 GB, and a warning in the log. `unprovisioned: reject` refuses those
   sessions instead.
2. **Every 5GC session takes a slightly different route, charged or not.** PFCP Session
   Establishment used to be sent from inside `smf_npcf_smpolicycontrol_handle_create()`.
   The caller in `gsm-sm.c` now sends it, because the CHF Create has to come first. With no
   charging, the messages and their order are the same.
3. **A 5GC usage rule now counts uplink too.** Upstream attaches the 100 MB volume-threshold
   URR to the downlink PDR only. The patches attach it to the uplink PDR as well, on every
   5GC QoS flow, so that report now arrives after 100 MB in both directions together.
   Without charging, nothing acts on it.
4. **A 5GC session can now be refused for charging reasons.** An exhausted balance gets 5GSM
   cause 26 and a 60 s back-off. A CHF that refuses or never answers gets `NETWORK_FAILURE`.
   `ims`, `sos` and `mcptt` are exempt and are set up anyway. The AMF logs each refusal at
   ERROR level, which is upstream's logging, so expect one line per refused retry.
5. **EPC and Gy stay on their own path.** `smf_select_online_charging()` sends every EPC
   session to Gy, and no added or removed line touches `sess->gy`, which is checked on
   every regeneration. Two small things differ:
   - `ctf.enabled` now governs both interfaces, so `no` turns off Gy and the CHF together.
   - A 5GC session on `ims`, `sos` or `mcptt` no longer enters the Gy block of the usage
     report handler. Otherwise `ctf.enabled: yes` with no Gy peer would release it on its
     first report.
6. **The WebUI changes in ways unrelated to charging.** Server start-up moves from `co` to
   `async`. CSRF checks are skipped for requests with a JWT Bearer token. `GET /metrics`
   is new and unauthenticated. The npm scripts set `NODE_OPTIONS=--openssl-legacy-provider`.
   A start-up migration rewrites `chf.subscribers` only.
7. **The generated SBI library grows.** Patch 1 adds models and changes none of the existing
   ones, so no message an existing NF builds or reads is affected. See
   [The regenerated models](#the-regenerated-models).
8. **Upstream's 5G test suites now run with charging on.** The harness starts a CHF from the
   test config, so their sessions go through it. `no_chf: true` under `global.parameter`
   leaves it out.

## Does Open5GS still work after each patch?

**Yes, after every one of them.** You can stop at any patch. Between patches 3 and 5 a
running CHF has no effect, so sessions work but are not charged.

| After patch | Whole tree builds | Core with no CHF running | Core with a CHF running |
|---|---|---|---|
| 1 | Yes | Works as upstream | No CHF exists yet |
| 2 | Yes | Works as upstream | No CHF exists yet |
| 3 | Yes | Works as upstream | The CHF runs and answers direct requests; the SMF never calls it |
| 4 | Yes | Works as upstream | Same as patch 3 |
| 5 | Yes | Works as upstream | Same as patch 3: the SMF finds the CHF but opens no charging sessions |
| 6 | Yes | Works as upstream | **Charging works end to end,** with no WebUI and no idle-quota return |
| 7 | Yes | Works as upstream | Adds provisioning through the WebUI and TMF APIs |
| 8 | Yes | Works as upstream | The complete set |

The patches are still units of review rather than releases. Only the complete set has
had the full regression below.

### How this was checked

**On `39a8c771f`, the current base, on 2026-11-13, with these patches.** Upstream had not
moved since the round of 2026-11-11, which gave the same results. Since then patch 7 has
gained the SIM swap endpoint and patch 3's user guide a few lines on it, and the whole round
was run again on them. On 2026-11-14 the CHF's ChargingNotify reader changed in patch 3, so
that several CHFs can share the queue. That change has been tested on macOS, with a new
test that runs two CHFs, but not yet on the rig.

- **Build and unit tests, after every patch, on macOS.** The patches were applied one at a
  time to a clean base, with mongo-c-driver 2.5. After each: the whole tree built, and
  `core`, `crypt` and `unit` passed, plus the CHF's own tests from patch 3 on.
- **The complete set, on a two-VM rig with UERANSIM.** Per-slice quotas, ChargingNotify,
  refusal with 5GSM cause 26, `ims`/`sos`/`mcptt` handling, a frozen CHF, `ctf.enabled: yes`,
  a real dedicated QoS flow, three UPF restarts under charged sessions, a full CHF session
  pool, CDRs in both encodings, the API suite at 55/55, a clean shutdown, and 0 CHF errors.
  The full pool has now been seen both ways: with `internet` refused, and with `internet`
  taking the last slot while `ims`, `sos` and `mcptt` came up uncharged.
- **A SIM swap with the UE.** With its two sessions up, the UE's three buckets were moved to
  another SUPI and back through the TMF API. The counters travelled both ways. The old
  sessions were released by `ABORT_CHARGING`. Sessions the UE then set up on the default quota
  moved to the catch-all on `REAUTHORIZATION`. The usage the released sessions reported after
  the swap was in their CDRs and not in the balance, as documented.
- **Upstream's 14 suites, with the CHF in their harness:** all 14 passed. The whole `vonr`
  binary, charged by the harness's CHF, passed with 51 CDRs, and `test-dedicated-flow.sh`
  passed 10 of 10.
- **The CHF and the WebUI, on macOS.** The CHF's tests under ASan and UBSan, built on driver
  1.30: 0 reports. The API suite against a local CHF and MongoDB: 29 passed, 0 failed, 25
  skipped because there is no `mongosh`, SMF or WebUI there. Ten SIGTERM cycles with a
  request in flight: all clean, and each request answered 503. A full session pool: 500
  `INSUFFICIENT_RESOURCES`, and the CHF kept running. A fresh database: the intended
  indexes, with no warning. The WebUI's 178 tests, and its 16 opt-in tests against a real
  MongoDB. A SIM swap end to end against a local CHF, with requests in place of the SMF.
  `tests/chf/test-notify-two-chfs.sh`: 18 of 18, also with the CHFs built with ASan and UBSan.
  On the CHF from before 2026-11-14 it fails 9 or 10 of them.

**Also on `39a8c771f`, on 2026-11-11: the live run after every patch.** The patches were
applied one at a time to a clean base on the rig. After each: the whole tree built, upstream's
`registration`, `slice`, `vonr` and `attach` tests ran, and a UE brought up two PDU sessions
and pulled 126 MB. From patch 3 on, those tests had the CHF in their harness, and the live run
was repeated with a CHF running.

- With a CHF running, patches 3 to 5 sent it no charging requests.
- From patch 6 the CHF charged the session and cut it off at its quota. The errors logged
  then were the AMF reporting the refused retries and GTP-U error indications from the UPF.
- With no CHF, the one error at any step was the known PCF delete race, at patch 5.
- Of the 32 test runs, one did not pass: `registration` at patch 5 hung and was killed after
  150 s. It did not happen again: 10 of 10 on a rebuilt patch-5 tree, and 5 of 5 on the
  complete set.

**A plain `meson test`, with no suite named,** which is what `meson-ci.yml` runs. On this base
it ran twice on the rig. The CHF's tests and every 5G suite passed both times, but neither run
was clean:

- Both times, upstream's `core` unit suite timed out in `timer-test`. Its line 70 found two
  timers fired where it expected one, because the poll woke late. Run alone it passed 2 of 5.
  Nothing in the patch set touches `lib/core` or `tests/core`, and it passed on 2026-11-09.
- In the second run, `transfer` aborted when its simulated gNB could not reach the second AMF.
  `transfer-error` then failed at once, on ports the aborted test still held. Under the same
  `MALLOC_PERTURB_=25`, `transfer` passed 5 of 5 with the CHF in its harness and 5 of 5
  without.

On `5ff0dc56f`, on 2026-11-09, the same command passed 23 of 23.

Two recent defects are worth knowing about. A UPF restart showed that when a new
Create for the same PDU session ID replaced a session, the old session never sent its CHF
Release. Reading upstream's SUPI validation showed that the CHF had none: any string, even an
empty one, got a 201 and the default quota. Both are fixed.

`vonr`, `non3gpp`, `transfer`, `transfer-error` and EPC `handover` can fail under the memory
scrambling meson turns on (`MALLOC_PERTURB_`, random on each run). All pass without it.

What was not run at the intermediate steps: the WebUI (only its unit tests, at patch 7),
and failures such as a CHF that hangs or a UPF that restarts. Those were tested on the
complete set.

## Reviewing the patches

| Patch | New files | Changed files | Lines added | Lines removed | Depends on |
|---|---|---|---|---|---|
| 1 generated code | 551 | 14 | 76,603 | 123 | — |
| 2 shared libraries | 0 | 10 | 430 | 2 | 1 |
| 3 the CHF | 49 | 32 | 17,172 | 2 | 1, 2 |
| 4 SMF selector | 0 | 2 | 299 | 11 | 2 |
| 5 SMF client | 4 | 4 | 1,744 | 1 | 1, 2, 4 |
| 6 SMF wiring | 0 | 9 | 624 | 13 | 5 |
| 7 WebUI | 45 | 8 | 16,723 | 3,389 | 3 |
| 8 UPF | 0 | 2 | 151 | 5 | Nothing to build; 2 and 6 for it to have any effect |

Each file belongs to exactly one patch, and every dependency points backwards, so a
reviewer reading in order never meets a call to something that does not exist yet.

### Where to spend the time

| Attention | Files | Why |
|---|---|---|
| Closely | `src/smf/gsm-sm.c`, `src/smf/smf-sm.c` (patch 6) | The session state machine: a new state between policy association and PFCP establishment, and every teardown path. A missed path leaves a charging session open, which is the defect the last rig round found |
| Closely | `src/smf/n4-handler.c` (patch 5) | Usage reports become billing here. It runs on every report, charged or not |
| Closely | `src/upf/context.c` (patch 8) | Changes the callback every time-based URR uses |
| Closely | `lib/sbi/context.c`, `nnrf-*.c`, `message.c` (patch 2) | Every NF links them. The changes are additive, and gated on the CHF NF type or a charging payload |
| Normal | `src/chf/nchf-handler.c`, `db-handler.c`, `context.c` (patch 3) | Quota decisions. New code with no effect on anything else |
| Normal | `webui/server/index.js`, `webui/server/routes/` (patch 7) | Existing server start-up and CSRF handling |
| Normal | `webui/server/tmf/bucket-map.js`, `balance.js`, `sim-swap.js` (patch 7) | They move balances. A top-up writes the CHF's live counter conditionally, and a SIM swap is all or nothing across several documents without a transaction |
| Skim | The rest of `src/chf`, `tests/chf`, `webui/src` | Follows the existing layouts |
| Not line by line | `lib/sbi/openapi`, `lib/asn1c/cdr`, `webui/package-lock.json` | Generated. Read the inputs instead: the `patched/` directories and `generator.sh`, a few hundred lines |

New files are untracked after applying, so a plain `git diff` shows only the changes to
existing upstream files:

```sh
git diff --stat -- . ':(exclude)lib/sbi/openapi' ':(exclude)webui/package-lock.json'
git diff -- src/smf
```

### Changes to existing upstream code

Every hand-written upstream file the set changes, leaving out generated models. "With no
CHF" means a deployment that has applied the patches and runs no CHF.

| Patch | File | Lines | What changes | With no CHF |
|---|---|---|---|---|
| 2 | `lib/pfcp/build.c`, `xact.h` | +10 −1 | A modify flag (bit 35) and the Quota Holding Time IE on Update URR, which upstream never sent | Nothing sets the flag |
| 2 | `lib/sbi/context.c`, `.h` | +146 −1 | `chfInfo`, discovery by SUPI, and the list of well-known DNNs | The new checks apply only to CHF instances |
| 2 | `lib/sbi/nnrf-build.c`, `nnrf-handler.c` | +156 | Build and parse `chfInfo` in the NF profile | Only a CHF's profile has one |
| 2 | `lib/sbi/message.c`, `.h`, `types.h`, `ogs-sbi.h` | +118 | Charging payloads, the SUPI discovery parameter, resource names | Not reached |
| 3 | `src/meson.build`, `tests/meson.build`, `configs/open5gs/meson.build`, `lib/app/ogs-app.h` | +6 | Register the CHF | One more daemon and test binary are built |
| 3 | `configs/open5gs/smf.yaml.in` | +6 | Commented-out `ctf` example | None |
| 3 | `configs/*.yaml.in`, all twelve | +147 | A `chf:` section beside the BSF's, with CDRs off, and a commented `no_chf` | The harness starts it |
| 3 | `lib/app/ogs-config.c`, `.h` | +7 | The `no_chf` parameter, and counting `chf` config sections | Used by the harness only |
| 3 | `tests/app/5gc-init.c`, `app-init.c` | +16 | Start and stop a CHF, for a config that has a section | Upstream's 5G suites run with one |
| 3 | `configs/systemd/meson.build`, `configs/open5gs/tls/meson.build`, `misc/make-certs.sh` | +4 −1 | List the unit and the certificate | One more unit and certificate are installed |
| 3 | `debian/control` | +23 −1 | The `open5gs-chf` package, which `open5gs` only `Suggests` | Not installed by `open5gs` |
| 3 | `misc/netconf.sh`, `.github/workflows/meson-ci.yml` | +2 | A loopback alias for `127.0.0.30` on macOS and FreeBSD | None |
| 3 | `docs/_docs/guide/01-quickstart.md`, `docs/_docs/platform/`, `docs/_pages/docs.md` | +6 | List the CHF, its address and the guide | None |
| 4 | `src/smf/context.c`, `.h` | +299 −11 | The charging selector, `ctf` parsing, per-session state, and one URR per charged session | Uplink is counted too, as above |
| 5 | `src/smf/n4-handler.c`, `.h` | +258 | Usage reports go to the CHF; a report during deletion is answered and its usage kept | The Gy block differs as described above |
| 5 | `src/smf/sbi-path.c` | +11 −1 | NRF subscription for CHF status; a caller can set the reject cause | One more NRF subscription. The cause stays `NETWORK_FAILURE` unless set |
| 5 | `src/smf/meson.build` | +4 | New sources | None |
| 6 | `src/smf/gsm-sm.c` | +356 −7 | The new state, PFCP establishment after the CHF, release on exhaustion, and CHF Release on teardown | The PFCP request is sent from here. The Release is a no-op with no CHF association |
| 6 | `src/smf/smf-sm.c`, `.h` | +168 | Route CHF responses and timeouts, the `charging-notify` callback, and the replaced-session Release | The new branches are not reached |
| 6 | `src/smf/npcf-handler.c` | +14 −3 | Stops sending PFCP establishment itself | `gsm-sm.c` sends it |
| 6 | `src/smf/pfcp-path.c` | +9 −1 | A URR-only modification may have no SBI stream | Not reached |
| 6 | `src/smf/pfcp-sm.c` | +21 | CHF Release when a PFCP deletion times out | No-op with no association |
| 6 | `src/smf/namf-handler.c` | +25 | Finish the teardown if the AMF will not carry a quota-exhausted Release Command | Not reached |
| 6 | `src/smf/n4-build.c` | +4 −2 | The Quota Holding Time flag in the URR-modify masks | Nothing sets the flag |
| 6 | `src/smf/gsm-build.c` | +27 | T3396 back-off on an establishment reject | Only when a caller asks for one |
| 7 | `webui/server/index.js` | +38 −6 | Start-up, migration, `/metrics`, conditional CSRF | Applies, as above |
| 7 | `webui/server/routes/db.js`, `routes/index.js` | +80 −1 | CHF and TMF routes, behind the existing JWT check | New routes only |
| 7 | `webui/package.json` | +16 −3 | Test scripts, dev and optional dependencies, `NODE_OPTIONS` | Applies |
| 7 | `webui/package-lock.json` | +8,469 −3,378 | `jest` and its tree: 379 packages added, 1 removed, 12 version bumps | Dev only |
| 7 | `webui/src/components/`, `containers/App.js` | +27 −1 | Two pages and their menu entries | Visible, and empty |
| 8 | `src/upf/context.c`, `.h` | +151 −5 | The Quota Holding Time timer, and time-based reports that state which timer fired | The timer runs only if the SMF programs one |

Patch 1 also changes 14 non-model files: two `meson.build` files, `generator.sh`, ten YAML
files (five specifications, each in `patched/` and `modified/`), and the asn1c support
README.

### The regenerated models

The C generator flattens every specification into one `OpenAPI_*` namespace, and each
specification's output overwrites any file of the same name. TS 32.291 is generated last,
so anything it reached under a name already in use would replace that model. Each such
definition has a `Charging*` name in `patched/`, so patch 1 adds 199 models (398 files) and
changes none. Every existing model is byte-identical to upstream's. After a regeneration,
`git diff --diff-filter=M <base> -- lib/sbi/openapi/model` must print nothing.

| Definition | From | How it is kept apart |
|---|---|---|
| `NotificationType`, `RedirectAddressType`, `QosMonitoringReport`, `TSCAssistanceInformation` | TS 32.291 | Renamed in place |
| `Trigger` | TS 32.291 | Charging messages use `ChargingTrigger`, with a 64-bit `volumeLimit64`. `Trigger` stays as published because TS 29.502 reaches it through `RoamingChargingProfile` |
| `GeographicalCoordinates` | TS 28.538 | Renamed in place. It would otherwise take the bare name and push TS 29.572's to `_1`, which rewrites the ten-model geographic family |
| `PlmnId`, `Tai` | TS 28.623 | `ChargingPlmnId` and `ChargingTai` sit beside the originals, which other SA5 files still reference |
| `ServiceExperienceInfo`, `PduSessionInfo`, `LocationInfo`, `GeoDistributionInfo` | TS 29.520 | Copied into the TS 32.291 file as `Charging*`, because other NFs' runs use the originals |
| `UserLocation`, `N3gaLocation`, `TransportProtocol` | TS 29.571 | Copied the same way. `UserLocation` and `N3gaLocation` are copied only because they lead to `TransportProtocol`: TS 29.571's has `UDP`, and the model upstream ships is TS 29.510's, which does not |

The copies are separate C types. A charging message carries an
`OpenAPI_charging_user_location_t`, not an `OpenAPI_user_location_t`, so code that fills one
in has to build that type. The only one the hand-written code uses today is
`OpenAPI_charging_trigger_t`.

## What the patches rely on in Open5GS

These are the seams. Git reports only overlapping lines, and several of these have changed
upstream without a conflict.

| When upstream changes… | Check | Because |
|---|---|---|
| A path that frees a 5GC session (`SMF_SESS_CLEAR`, `smf_sess_remove`, a new state) | That a session with a CHF association has sent `smf_nchf_send_release()` first | Six places send it today. A path that misses it leaves the session open at the CHF: no CDR, and a pool slot held until the CHF restarts. `f44961889` added such a path, safe only because that state had already sent its Release |
| How PFCP establishment is triggered | `smf_gsm_state_wait_5gc_sm_policy_association()` and the new `smf_gsm_state_wait_5gc_nchf_create()` | `smf_npcf_smpolicycontrol_handle_create()` no longer sends it, so each path out of policy association has to |
| What happens to an outbound SBI transaction when its inbound stream closes | `smf_gsm_state_wait_5gc_nchf_create()` and everything it calls | Upstream cancelled these from `68ab28cd8` and stopped again at `6ebfdc93f`. A CHF Create can now be answered after the AMF's stream has gone, so that path has to accept a NULL stream, which it does |
| What `e->h.sbi.data` holds on an SBI event | `wait_5gc_nchf_create` in the SMF, and every SBI event in `src/chf` | Changed twice. Upstream's "avoid stale pointers in NF timers" made the CHF segfault on its first NF heartbeat. `5c4d307ff` merged silently, and it holds only because a hash lookup returns NULL for 0 |
| Something done to every NF | `src/chf`, by hand | Nothing updates a new NF. It has needed porting from `3e007ddf0` (graceful shutdown), `9c930ba5e` (pool-full cause), `5c437e9c2` (`pduSessionId` range) and `8d6c52518` (SUPI validation) |
| PFCP usage reporting, or the report handler | `n4-handler.c`, and `src/upf/context.c` for the timers | Billing is exactly what these report |
| `OGS_PFCP_MODIFY_*` flags in `lib/pfcp/xact.h` | That bit 35 is still free | The patches take it |
| `generator.sh`, or a specification generated after TS 32.291 | That the charging models still come out as written | The last run wins, as above |
| `lib/asn1c/common/asn_internal.h` | The CDR codec's copy | `lib/asn1c/cdr` keeps its own BER-enabled runtime, and its generator copies this one file. Sharing `common` would link and then fail at run time, because `asn_config.h` differs |
| A new test config in `configs/*.yaml.in` | That it has a `chf:` section, or that going without one is deliberate | The harness starts a CHF only for a config with a section, so a new config would run uncharged without saying so |
| `webui/server/index.js` start-up | The migration call and the conditional CSRF | If CORS is ever added, the CSRF exemption for Bearer tokens must be revisited, as its comment says |

The rule that follows: read the whole `git log <old>..<new>`, messages included, even when
nothing conflicts. For each fix upstream makes to its own NFs, ask whether `src/chf` makes
the same mistake. Section 13.6 of the overview has the history.

The CHF makes its MongoDB calls synchronously on its one worker thread, as the UDR does, so
a slow database stalls it. The measured capacity is in section 9 of the overview.

## Packaging, tests and what is left out

The CHF has what an upstream NF such as the BSF has:

| What | Where | Notes |
|---|---|---|
| A systemd unit | `configs/systemd/open5gs-chfd.service.in` | The BSF's, with the names changed |
| A Debian package | `debian/open5gs-chf.install`, `debian/control` | Also carries `open5gs-chf-cdr-decode`, so it depends on `python3` |
| Test configs | All twelve `configs/*.yaml.in` | A `chf:` section beside the BSF's. CDRs are off, so a test run leaves no billing files |
| A place in the test harness | `tests/app/5gc-init.c`, `tests/app/app-init.c`, `lib/app/ogs-config.*` | Started like the BSF, with `no_chf` to leave it out. As for the EIR, a config with no section starts none. The EPC-only harness doesn't start one, as it doesn't start a BSF |
| TLS certificates | `configs/open5gs/tls/chf.*`, `misc/make-certs.sh` | A demo key and certificate like the others, signed by the CA in that directory |
| A user guide | `docs/_docs/guide/04-chf.md` | Configuration, the APIs, reading CDRs and troubleshooting. Linked from the docs index and the quickstart |
| An address of its own | `127.0.0.30` | Used by nothing else. `127.0.0.16`, its old address, is the AF's in `configs/vonr.yaml.in` and nine example configs |

**One deliberate difference from the BSF.** The `open5gs` metapackage lists `open5gs-chf`
under `Suggests`, as it does `open5gs-eir`, and not under `Depends`. An SMF charges every 5G
session once a CHF registers, so a CHF pulled in by `apt install open5gs`, or by an upgrade,
would start charging every subscriber on the default 10 GB. Installing `open5gs-chf` starts
the service, as for any other NF. To make it part of the default install, move the line to
`Depends`.

`meson test` with no suite named, which is what `meson-ci.yml` runs, covers the CHF twice: the
`chf` suite needs only `python3`, and the 5G suites now have a CHF in their harness.
`tests/chf/test-chf-api.sh` needs a live CHF and MongoDB, so it is not a meson test. Nor is
`tests/chf/test-notify-two-chfs.sh`, which starts two CHFs, and needs MongoDB and the WebUI's
`npm install`.

Left out, or not yet run:

- `configs/examples/` has no `chf:` section, because roaming with a CHF is untested.
- TLS: the CHF starts HTTPS with its certificate, and the certificate verifies against the
  CA. An SMF talking to a CHF over TLS has not been run, and neither has OAuth2.
- `src/chf/meson.build` and `tests/chf/meson.build` use `install_mode` and `depends`, which
  need meson 0.47 and 0.46. The project declares 0.43. Meson warns and carries on.

What the CHF itself does not do is in section 11 of the overview. The main ones: one rating
group per session, CDRs written but never transferred, only IMSI subscribers provisionable,
and home-routed roaming not tested.

## Third-party material

Upstream's [CLA page](../docs/_pages/cla.md), section 4, asks a submission to identify any
third-party material, its source, and the applicable licence or permission.

| Material | Where | Source | Terms |
|---|---|---|---|
| TS 32.298 ASN.1 modules, 3 files, verbatim | `lib/asn1c/support/cdr-r19.6.0/standard/` | 3GPP Forge, `sa5/CH`, branch `Rel-19`, commit `3e24b9aa` | 3GPP's. The files carry no licence text. They are the same kind of material as the NGAP and S1AP modules already in `lib/asn1c/support/` |
| ASN.1 derived from those | `…/patched/`, `…/modified/` | Trimmed from the above, with one comma corrected | As above |
| asn1c runtime and generated CDR codec, 144 files | `lib/asn1c/cdr/` | `mouse07410/asn1c`, commit `b7926896`, the fork and commit the NGAP and S1AP codecs already use | 84 runtime files carry Lev Walkin's BSD notice. The generated files carry none |
| TS 32.291, TS 28.538, TS 28.541 and TS 28.623 OpenAPI edits | `lib/sbi/support/r19-…/modified/`, `patched/` | Edits to the 3GPP YAML already in upstream | 3GPP's |
| Generated SBI models, 398 new files | `lib/sbi/openapi/` | openapi-generator 7.20.0, already upstream's tool | As upstream's existing models |
| `jest` 29.7 and its dependency tree, 379 packages | `webui/package-lock.json` | npm, development only | `jest` is MIT. The tree has not been audited package by package |
| `prom-client` ^15.1.3 | `webui/package.json`, optional | npm | Apache-2.0. Not in the lock file or installed by default |

The TM Forum APIs (TMF632, TMF654, TMF666) are implemented from their published
descriptions. No TM Forum specification or schema file is copied in.

Everything else is original to this work. The new C, meson and Python files carry the
project's AGPL-3.0 header and the author's copyright line, except
`lib/asn1c/support/cdr-r19.6.0/closure.py`, which has no header. New WebUI files are mixed,
as upstream's are.

## Bringing it into Open5GS

The patches are units of review, so they can become pull requests in this order:

| Step | Patches | Notes |
|---|---|---|
| 1 | 1 and 2 | Nothing calls them |
| 2 | 3 | The CHF on its own, with its packaging, its place in the test harness and its guide |
| 3 | 4, 5 and 6 | One review. Patches 4 and 5 do nothing without 6. This is the only step that changes existing session behaviour |
| 4 | 8 | The UPF timer. It applies and builds on a clean base with no other patch, and upstream's unit tests pass. Nothing runs the timer until an SMF programs a Quota Holding Time |
| 5 | 7 | The WebUI. Independent of the SMF. Its changes to existing behaviour are worth splitting out |

Before any of that, the contributor signs the CLA, and the table above goes with the
submission.

Some pieces are useful without a CHF and could go first:

- The Quota Holding Time IE on Update URR, in `lib/pfcp/build.c`, which upstream never sends.
- Answering a PFCP Session Report that arrives during deletion, in `n4-handler.c` and
  `gsm-sm.c`. Upstream's `smf_gsm_state_wait_pfcp_deletion()` logs it as a message it cannot
  handle and sends nothing back, and TS 29.244 requires a response.

## Keeping the set current

The patches are regenerated from the development branch, which keeps the full history.
Each patch is `git diff <base> HEAD -- <the files it owns>`, using the ownership table in
section 5.3 of `CHF_DEVELOPMENT_PLAN.md`. A fix goes into the patch that owns the file,
however late it is made, so the patches describe the current system and not how it got
there. Do not edit a patch by hand.

Five checks run on every regeneration:

1. **Coverage:** every changed file is in a patch.
2. **No duplication:** no file is in two patches.
3. **Applies:** all eight apply to a pristine base, in order, with no fuzz.
4. **Reproduces:** the patched tree is byte-identical to the branch.
5. **Gy isolation:** no added or removed line touches `sess->gy`.

`docs/CHF-*.md`, `patches/` and `CHF_DEVELOPMENT_PLAN.md` are development records and are
never in a patch. The user guide in `docs/_docs/guide/` is part of patch 3. A patch whose
only change after a rebase is its blob hashes and hunk offsets is the sign that upstream
changed nothing it depends on. These checks say nothing about behaviour: section 13.6 of
the overview lists what they cannot catch.

If you have only the patches, make a commit stack and let git do the rebase:

```sh
cp -r patches /tmp/chf-patches
git checkout --detach 39a8c771f
for p in /tmp/chf-patches/chf-phase-*.patch; do
    git apply --whitespace=nowarn "$p" && git add -A && git commit -qm "$(basename "$p" .patch)"
done
git rebase <new-base>
```

Tried from `3e007ddf0` to `422c5b31d`, this gave 8 commits and 698 files, and the rebase
stopped once: in patch 6, at the same two regions of `src/smf/smf-sm.c` where the development
branch conflicted.

## Turning it off

- **Keep the code and stop charging:** set `ctf.enabled: no` under `smf:` in `smf.yaml`,
  restart the SMF, and stop the CHF. This also turns off Gy.
- **Remove it:** `git apply -R` the patches in reverse order, last patch first, and re-run
  `npm install` in `webui/`. On this base that returned a test tree to the pristine commit
  with nothing left over. The `chf.*` collections and the CDR directory stay behind. Nothing else uses them,
  so they can be dropped.

## The patches

### 1. `chf-phase-1-generated-code` (565 files, 76,603 lines added)

**Contains:** machine-written code and the specifications it is generated from.
That is the TS 32.291 charging models in `lib/sbi/openapi`, and the TS 32.298 CDR
codec in `lib/asn1c/cdr` with its input bundle in `lib/asn1c/support`.

**Impact:** the libraries grow, but nothing calls the new code yet. No existing
generated model changes, because the definitions that would have collided have
`Charging*` names. See [The regenerated models](#the-regenerated-models).

**After it:** Open5GS works as before.

### 2. `chf-phase-2-shared-libs` (10 files, 430 lines added)

**Contains:** additions to `lib/sbi` and `lib/pfcp`. A CHF's NRF profile can carry
its SUPI ranges and slices, discovery can match on them, SBI messages can carry
the charging payloads, and PFCP can send a Quota Holding Time on Update URR. Also the
list of well-known DNNs (`ims`, `sos`, `mcptt`), which the CHF and the SMF share.

**Impact:** almost entirely additive. The only existing lines that change add a
flag to a PFCP check and drop a comment. Nothing uses the additions until a CHF
exists.

**After it:** Open5GS works as before.

### 3. `chf-phase-3-chf-complete` (81 files, 17,172 lines added)

**Contains:** the CHF itself in `src/chf`: quota and bucket logic, the
Nchf_ConvergedCharging service, the CDR writer in both encodings, ChargingNotify
and metrics. It keeps `ims`, `sos` and `mcptt` out of quota management, with their CDRs
behind `charging.well_known_dnn.cdr`. Also its tests in `tests/chf`, its config
`chf.yaml`, a CDR decoder tool, a systemd unit, a Debian package, a TLS certificate, a
section in every test config, its place in the test harness, and a user guide.

**Impact:** adds the `open5gs-chfd` daemon, which needs MongoDB. No other network function
behaves differently. The 32 existing files it changes are build lists, test configs, the
harness, packaging lists and documentation, and `smf.yaml` for a commented-out example.

**After it:** Open5GS works as before. The harness starts a CHF, but no SMF talks to it
yet. The CHF can also run on its own and answer direct requests
(`tests/chf/test-chf-api.sh`).

### 4. `chf-phase-4-smf-selector` (2 files, 299 lines added)

**Contains:** the SMF's decision about which charging interface a session uses,
including the `ctf.bypass_well_known_dnn` toggle, and its per-session accounting state.
A session's usage rule now counts uplink as well as downlink, and on a session the CHF
charges, a dedicated QoS flow counts against the default flow's usage rule.

**Impact:** nothing calls the selector yet, so no session is charged and each QoS flow
keeps its own usage rule, as upstream. The UPF's default 100 MB usage report now counts
both directions, but with no charging in use nothing is billed or enforced from it.

**After it:** Open5GS works as before.

### 5. `chf-phase-5-smf-nchf-client` (8 files, 1,744 lines added)

**Contains:** the SMF's charging client: building requests, handling grants, programming
the usage rules, handling ChargingNotify, and taking usage from PFCP reports. The SMF
also subscribes to CHF status at the NRF.

**Impact:** with no CHF registered, the selector chooses no charging and sessions follow
upstream's path. With one registered, nothing opens a charging session until patch 6, so
a usage report has nothing to report against and is ignored.

**After it:** Open5GS works as before, with or without a CHF running. Sessions are not
charged.

### 6. `chf-phase-6-smf-wiring` (9 files, 624 lines added)

**Contains:** the SMF state machine: Create before the session is set up, Update on
usage reports, Release with the final usage, the ChargingNotify endpoint, release
on exhaustion, and refusal with 5GSM cause 26 and a back-off. If the CHF refuses or never
answers a Create, or `ctf.enabled: yes` requires one and there is none, an ordinary session
is refused, while `ims`, `sos` and `mcptt` are set up uncharged. A session replaced by a new
Create for the same PDU session ID still sends its Release.

**Impact:** charging goes live on its own as soon as a CHF registers with the NRF. If the
NRF has no CHF at all, sessions run uncharged under the default `ctf.enabled: auto`, and are
refused under `yes`. With no CHF and `auto`, sessions take the same path as upstream, though
the PFCP request now starts from the state machine.

**After it:** a working charged core. Subscribers get the default quota from
`chf.yaml` unless buckets are written to MongoDB by hand. Idle sessions report only
when their validity time ends.

### 7. `chf-phase-7-webui` (53 files, 16,723 lines added)

**Contains:** provisioning in the WebUI: TM Forum APIs (TMF632, TMF666, TMF654), a SIM
swap that moves a subscriber's buckets to a new SUPI, the CHF Quota and CHF Sessions
pages, a start-up migration, and the ChargingNotify queue. 8,469 of the added lines are
`package-lock.json`.

**Impact:** nothing in the core changes. The WebUI needs `npm install` again. Four
existing behaviours change: the server start-up is rewritten, CSRF checks are
skipped for requests with a JWT Bearer token, the npm scripts set
`NODE_OPTIONS=--openssl-legacy-provider`, and an unauthenticated `GET /metrics` is added.

**After it:** the core is unaffected, and quotas can be provisioned, topped up and moved
to a new SIM without touching MongoDB directly.

### 8. `chf-phase-8-upf-quota-holding` (2 files, 151 lines added)

**Contains:** the Quota Holding Time idle timer in the UPF. An idle session reports
its usage once, instead of holding it until the grant ends. Time-based reports also
now state their own trigger.

**Impact:** the timer only runs when the SMF asks for it, which means on sessions
the CHF charges. Sessions with no time-based usage rule see no change.

**After it:** the complete set.
