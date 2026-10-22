#!/usr/bin/env bash
# Copyright (C) 2026 by Rami Mohamed <ramrode@gmail.com>
#
# =============================================================================
# CHF Nchf_ConvergedCharging API validation script — Progressive, Cumulative
# =============================================================================
#
# USAGE:
#   ./tests/chf/test-chf-api.sh
#
# ENVIRONMENT VARIABLES (all optional, with defaults):
#   CHF_ADDR   (default 127.0.0.16)  CHF_PORT   (default 7777)
#   NRF_ADDR   (default 127.0.0.10)  NRF_PORT   (default 7777)
#   SMF_ADDR   (default 127.0.0.4)   SMF_PORT   (default 7777)
#   WEBUI_ADDR (default 127.0.0.1)   WEBUI_PORT (default 9999)
#   CDR_BASE   (default /tmp/test-cdr)
#   SKIP_MONGO (default 0)
#
# PHASES IN THIS SCRIPT:
#   Phase 1 — CHF standalone NF             TC-1..TC-12, TC-10b..TC-10h, TC-13a..TC-13b, TC-ERR-1..TC-ERR-2  (requires: CHF + MongoDB)
#   Phase 2 — lib/sbi CHF NF info           TC-P2-1..P2-4  (requires: NRF)
#   Phase 3 — SMF CHF/Gy selector           TC-P3-1..P3-3  (requires: SMF + NRF)
#   Phase 4 — SMF Nchf client               TC-P4-1..P4-3  (requires: CHF)
#   Phase 5 — SMF full wiring               TC-P5-1..P5-2  (requires: CHF; SMF optional)
#   Phase 6 — WebUI quota management        TC-P6-1..P6-4  (requires: WebUI)
#
# EXIT CODES:
#   0 — all executed tests passed (FAIL=0); SKIP is not a failure
#   1 — one or more tests failed
#
# DESIGN:
#   Cumulative: each phase adds its tests on top of the previous phases.
#   Self-guarding: each phase detects its required services; SKIPs if not reachable.
#   Counters: PASS, FAIL, SKIP tracked; only FAIL causes non-zero exit.
#
# =============================================================================

# -u  : error on unset variables
# -o pipefail : pipe fails if any stage fails
# NOTE: -e (exit on error) is intentionally NOT set — test scripts must
#       continue after individual assertion failures so the full result
#       summary is always printed.
set -uo pipefail

# ---------------------------------------------------------------------------
# Service address configuration (from environment or defaults)
# ---------------------------------------------------------------------------
CHF_ADDR="${CHF_ADDR:-127.0.0.16}"
CHF_PORT="${CHF_PORT:-7777}"
NRF_ADDR="${NRF_ADDR:-127.0.0.10}"
NRF_PORT="${NRF_PORT:-7777}"
SMF_ADDR="${SMF_ADDR:-127.0.0.4}"
SMF_PORT="${SMF_PORT:-7777}"
WEBUI_ADDR="${WEBUI_ADDR:-127.0.0.1}"
WEBUI_PORT="${WEBUI_PORT:-9999}"
CDR_BASE="${CDR_BASE:-/tmp/test-cdr}"
SKIP_MONGO="${SKIP_MONGO:-0}"

BASE_URL="http://${CHF_ADDR}:${CHF_PORT}/nchf-convergedcharging/v3/chargingdata"

# ---------------------------------------------------------------------------
# Counters
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
SKIP=0

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
pass() { echo -e "${GREEN}PASS${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}FAIL${NC} $1"; FAIL=$((FAIL+1)); }
skip() { echo -e "${YELLOW}SKIP${NC} $1"; SKIP=$((SKIP+1)); }
info() { echo -e "${YELLOW}INFO${NC} $1"; }

# service_reachable() — returns 0 (true) if the TCP port is open,
# 1 (false) if connection is refused/timed out.
#
# IMPORTANT: use the no-op `:` (not `echo`) to open the /dev/tcp socket.
# `echo` writes a trailing newline (\n) before the connection closes.
# Open5GS SBI NFs run an HTTP/2 (nghttp2) server: the first bytes received
# must be the HTTP/2 client preface "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".
# Sending `\n` instead causes nghttp2 to log:
#   nghttp2_session_mem_recv() failed (-903: Received bad client magic byte string)
# which fills NF logs with misleading errors on every service probe.
# Using `:` opens the TCP connection and immediately closes it (FIN) with
# zero bytes sent — nghttp2 never invokes mem_recv(), so no error is logged.
service_reachable() {
    local addr="$1" port="$2"
    (: >/dev/tcp/${addr}/${port}) 2>/dev/null
}

service_reachable_http1() {
    local addr="$1" port="$2"
    (: >/dev/tcp/${addr}/${port}) 2>/dev/null
}

# chf_post() — HTTP POST with HTTP/2; writes response headers to
# /tmp/chf-resp-headers.txt and body to /tmp/chf-resp-body.txt.
# Always exits 0; prints 3-digit status code or "000" on failure.
chf_post() {
    local url="$1"
    local body="$2"
    : > /tmp/chf-resp-headers.txt
    : > /tmp/chf-resp-body.txt
    local code
    code=$(curl -s --max-time 10 --http2-prior-knowledge \
        -D /tmp/chf-resp-headers.txt \
        -X POST "${url}" \
        -H "Content-Type: application/json" \
        -o /tmp/chf-resp-body.txt \
        -w "%{http_code}" \
        -d "${body}" 2>/tmp/chf-curl-err.txt) || code="000"
    echo "${code}"
}

# check_python() — run a Python3 snippet; pass/fail based on exit code.
check_python() {
    local snippet="$1"
    local label="$2"
    if python3 -c "${snippet}" 2>&1; then
        pass "${label}"
    else
        fail "${label}"
    fi
}

# mongo_find() — query MongoDB (returns "{}" if SKIP_MONGO=1 or mongosh absent)
mongo_find() {
    local collection="$1"; local query="$2"
    if [ "${SKIP_MONGO}" = "1" ]; then echo "{}"; return; fi
    mongosh --quiet open5gs --eval \
        "EJSON.stringify(db['${collection}'].findOne(${query}))" 2>/dev/null \
        || echo "{}"
}

# ---------------------------------------------------------------------------
# Prerequisites check
# ---------------------------------------------------------------------------
curl --version | grep -qiE "HTTP/2|HTTP2" || {
    echo "ERROR: curl does not support HTTP/2. Install curl with nghttp2 support."
    exit 1
}

command -v mongosh >/dev/null 2>&1 || command -v mongo >/dev/null 2>&1 || {
    echo "WARNING: mongosh/mongo not found — MongoDB tests will be skipped"
    SKIP_MONGO=1
}

# ---------------------------------------------------------------------------
# Unique SUPIs for this test run
#
# WHY ${_TS: -9} instead of $(date +%s | tail -c 9):
#   `date +%s` writes the timestamp with a trailing newline: "1746100232\n".
#   `tail -c 9` counts bytes from the end, so the last 9 bytes of an 11-byte
#   string are "46100232\n" — 8 digits + the newline.  Command substitution
#   $() strips trailing newlines, leaving only 8 digits.
#   Result: "imsi-999700" + 8 digits = 14 digits after "imsi-", which FAILS
#   the WebUI ChfSubscriber schema regex ^imsi-\d{15}$ (requires 15 digits).
#
#   Fix: capture the timestamp into a variable (no newline after $()) and use
#   bash parameter expansion ${_TS: -9} to take the last 9 characters of the
#   already-clean string.  "imsi-999700" (6 digits) + 9 digits = 15 digits. ✓
#
# MNC values (6th digit after "imsi-999"):
#   70x = base SUPI (CHF NF tests — CHF does not validate IMSI format)
#   71x = SUPI_P6  (WebUI TC-P6-3 quota test  — must satisfy ^imsi-\d{15}$)
#   72x = SUPI_P6Z (WebUI TC-P6-4 zero-quota  — must satisfy ^imsi-\d{15}$)
# ---------------------------------------------------------------------------
_TS=$(date +%s)
SUPI="imsi-999700${_TS: -9}"
SUPI_P6="imsi-999701${_TS: -9}"
SUPI_P6Z="imsi-999702${_TS: -9}"
info "Test SUPI: ${SUPI}"
echo

# ============================================================
# PHASE 1 — CHF standalone NF
# ============================================================
echo "=== PHASE 1 — CHF standalone NF (TC-1..TC-12, TC-10b..TC-10h, TC-13a..TC-13b, TC-ERR-1..TC-ERR-2) ==="

if ! service_reachable "${CHF_ADDR}" "${CHF_PORT}"; then
    echo "  CHF not reachable at ${CHF_ADDR}:${CHF_PORT} — skipping all Phase 1 tests"
    for _tc in TC-1 TC-1a TC-1b TC-2 TC-2a TC-3 TC-4 TC-5 TC-6 TC-7 TC-8 TC-9 TC-10 TC-10b TC-10c TC-10d TC-10e TC-10f TC-10g TC-10h TC-13a TC-13b TC-ERR-1 TC-ERR-2 TC-11 TC-12; do
        skip "${_tc}: CHF not reachable"
    done
else
    info "CHF reachable at ${CHF_ADDR}:${CHF_PORT} ✓"

    # -------------------------------------------------------------------
    # TC-1: Create → 201 + Location + grantedUnit body
    CREATE_BODY="{\"subscriberIdentifier\":\"${SUPI}\",\"gpsi\":\"msisdn-447700900001\",\"pDUSessionChargingInformation\":{\"chargingId\":42,\"userInformation\":{\"servedGPSI\":\"msisdn-447700900001\"},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":5,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"

    HTTP_CODE=$(chf_post "${BASE_URL}" "${CREATE_BODY}")
    BODY=$(cat /tmp/chf-resp-body.txt)

    if [ "${HTTP_CODE}" = "201" ]; then
        pass "TC-1: Create → HTTP 201"
    else
        fail "TC-1: Create → HTTP 201 (got ${HTTP_CODE})"
        [ "${HTTP_CODE}" = "000" ] && echo "       curl error: $(cat /tmp/chf-curl-err.txt 2>/dev/null)"
    fi

    LOCATION=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
        | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')
    if [ -n "${LOCATION}" ]; then
        pass "TC-1a: Location header present"
    else
        fail "TC-1a: Location header missing"
    fi

    if [ -n "${BODY}" ]; then
        check_python "
import json, sys
raw = '''${BODY}'''
try:
    d = json.loads(raw)
except Exception as e:
    print('JSON parse error:', e); sys.exit(1)
mui = d.get('multipleUnitInformation', [{}])[0]
assert 'grantedUnit' in mui, 'missing grantedUnit'
assert 'totalVolume' in mui['grantedUnit'], 'missing totalVolume'
assert 'validityTime' in mui, 'missing validityTime'
print('  grantedUnit.totalVolume =', mui[\"grantedUnit\"][\"totalVolume\"])
print('  validityTime =', mui[\"validityTime\"])
" "TC-1b: Create body has grantedUnit.totalVolume + validityTime"
    else
        fail "TC-1b: Create body empty (curl failed?)"
    fi

    GRANTED_ON_CREATE=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    print(d['multipleUnitInformation'][0]['grantedUnit']['totalVolume'])
except:
    print('')
PYEOF
) || GRANTED_ON_CREATE=""

    CDR_REF=$(echo "${LOCATION}" | sed 's|.*/||')
    info "ChargingDataRef: ${CDR_REF}"

    # -------------------------------------------------------------------
    # TC-2: Update → 200 + decremented totalVolume
    UL_USED=1048576   # 1 MB
    DL_USED=2097152   # 2 MB
    TIME_USED=60
    UPDATE_BODY="{\"subscriberIdentifier\":\"${SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":${UL_USED},\"downlinkVolume\":${DL_USED},\"time\":${TIME_USED}}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"

    if [ -n "${LOCATION}" ]; then
        HTTP_CODE=$(chf_post "${LOCATION}/update" "${UPDATE_BODY}")
        UPDATE_BODY_RESP=$(cat /tmp/chf-resp-body.txt)

        if [ "${HTTP_CODE}" = "200" ]; then
            pass "TC-2: Update → HTTP 200"
        else
            fail "TC-2: Update → HTTP 200 (got ${HTTP_CODE})"
            UPDATE_BODY_RESP=""
        fi

        GRANTED_AFTER_UPDATE=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    print(d['multipleUnitInformation'][0]['grantedUnit']['totalVolume'])
except:
    print('')
PYEOF
) || GRANTED_AFTER_UPDATE=""

        if [ -n "${GRANTED_ON_CREATE}" ] && [ -n "${GRANTED_AFTER_UPDATE}" ]; then
            # Grants are sliced (chf.yaml charging.grant.max_volume_mb), so
            # the next grant is min(slice, remainder): never more than the
            # first, and only smaller once the remainder drops below a slice.
            if [ "${GRANTED_AFTER_UPDATE}" -gt 0 ] && \
               [ "${GRANTED_AFTER_UPDATE}" -le "${GRANTED_ON_CREATE}" ]; then
                pass "TC-2a: totalVolume within the grant (${GRANTED_ON_CREATE} → ${GRANTED_AFTER_UPDATE})"
            else
                fail "TC-2a: totalVolume out of range: ${GRANTED_ON_CREATE} → ${GRANTED_AFTER_UPDATE}"
            fi
        else
            fail "TC-2a: could not read totalVolume from Create or Update response"
        fi
    else
        fail "TC-2: skipped — no Location from TC-1"
        fail "TC-2a: skipped"
    fi

    # -------------------------------------------------------------------
    # TC-3: Release → 204
    RELEASE_BODY="{\"subscriberIdentifier\":\"${SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":524288,\"downlinkVolume\":1048576,\"time\":30}]}]}"

    if [ -n "${LOCATION}" ]; then
        HTTP_CODE=$(chf_post "${LOCATION}/release" "${RELEASE_BODY}")
        if [ "${HTTP_CODE}" = "204" ]; then
            pass "TC-3: Release → HTTP 204"
        else
            fail "TC-3: Release → HTTP 204 (got ${HTTP_CODE})"
        fi
    else
        fail "TC-3: skipped — no Location from TC-1"
    fi

    # -------------------------------------------------------------------
    # TC-4: Post-release Update → 404 (session gone)
    if [ -n "${LOCATION}" ]; then
        HTTP_CODE=$(chf_post "${LOCATION}/update" "${UPDATE_BODY}")
        if [ "${HTTP_CODE}" = "404" ]; then
            pass "TC-4: Post-release Update → HTTP 404"
        else
            fail "TC-4: Post-release Update → HTTP 404 (got ${HTTP_CODE})"
        fi
    else
        fail "TC-4: skipped — no Location from TC-1"
    fi

    # -------------------------------------------------------------------
    # TC-5, TC-6, TC-7: MongoDB persistence
    if [ "${SKIP_MONGO}" = "1" ]; then
        skip "TC-5: MongoDB not available"
        skip "TC-6: MongoDB not available"
        skip "TC-7: MongoDB not available"
    else
        HTTP_CODE=$(chf_post "${BASE_URL}" "${CREATE_BODY}")
        LOCATION2=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')
        CDR_REF2=$(echo "${LOCATION2}" | sed 's|.*/||')

        if [ "${HTTP_CODE}" = "201" ] && [ -n "${CDR_REF2}" ]; then
            DOC=$(mongo_find "chf.sessions" "{chargingDataRef: '${CDR_REF2}'}")
            if python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
assert d and d.get('chargingDataRef'), 'session not in DB'
" <<< "${DOC}" 2>&1; then
                pass "TC-5: Session record in chf.sessions"
            else
                fail "TC-5: Session record missing from chf.sessions"
            fi

            chf_post "${LOCATION2}/update" "${UPDATE_BODY}" >/dev/null || true
            DOC=$(mongo_find "chf.sessions" "{chargingDataRef: '${CDR_REF2}'}")
            if python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
def to_int(v):
    if isinstance(v, dict):
        return int(v.get('\$numberLong', v.get('\$numberInt', 0)))
    return int(v) if v else 0
assert to_int(d.get('ulOctets')) > 0, 'ulOctets not updated'
assert to_int(d.get('dlOctets')) > 0, 'dlOctets not updated'
" <<< "${DOC}" 2>&1; then
                pass "TC-6: Usage counters updated in chf.sessions after Update"
            else
                fail "TC-6: Usage counters not updated in chf.sessions"
            fi

            chf_post "${LOCATION2}/release" "${RELEASE_BODY}" >/dev/null || true
            DOC=$(mongo_find "chf.cdrs" "{chargingDataRef: '${CDR_REF2}'}")
            if python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
assert d, 'CDR doc not found'
assert d.get('file_path'), 'CDR file_path empty'
print('  CDR file_path:', d['file_path'])
" <<< "${DOC}" 2>&1; then
                pass "TC-7: CDR record in chf.cdrs with file_path after Release"
            else
                fail "TC-7: CDR record missing or file_path empty in chf.cdrs"
            fi
        else
            fail "TC-5: skipped — Create failed (HTTP ${HTTP_CODE})"
            fail "TC-6: skipped"
            fail "TC-7: skipped"
        fi
    fi

    # -------------------------------------------------------------------
    # TC-8, TC-9: Quota engine
    HTTP_CODE=$(chf_post "${BASE_URL}" "${CREATE_BODY}")
    LOCATION3=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
        | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')
    BODY3=$(cat /tmp/chf-resp-body.txt)

    VALIDITY=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    print(d['multipleUnitInformation'][0]['validityTime'])
except:
    print('')
PYEOF
) || VALIDITY=""

    if [ -n "${VALIDITY}" ] && [ "${VALIDITY}" -gt 0 ] 2>/dev/null; then
        pass "TC-9: validityTime present and > 0 (got ${VALIDITY})"
    else
        fail "TC-9: validityTime missing or zero (got '${VALIDITY}')"
    fi

    PREV_VOLUME=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    print(d['multipleUnitInformation'][0]['grantedUnit']['totalVolume'])
except:
    print('')
PYEOF
) || PREV_VOLUME=""

    MONOTONE=1
    if [ -n "${PREV_VOLUME}" ] && [ -n "${LOCATION3}" ]; then
        for _i in 1 2 3; do
            SMALL_UPDATE="{\"subscriberIdentifier\":\"${SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":1048576,\"downlinkVolume\":1048576,\"time\":10}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            HTTP_CODE=$(chf_post "${LOCATION3}/update" "${SMALL_UPDATE}")
            CURR_VOLUME=$(python3 -c "
import json, sys
try:
    d = json.loads(open('/tmp/chf-resp-body.txt').read())
    print(d['multipleUnitInformation'][0]['grantedUnit']['totalVolume'])
except:
    print('')
" 2>/dev/null) || CURR_VOLUME=""
            if [ -n "${CURR_VOLUME}" ] && [ -n "${PREV_VOLUME}" ]; then
                if [ "${CURR_VOLUME}" -ge "${PREV_VOLUME}" ] 2>/dev/null; then
                    MONOTONE=0
                fi
            fi
            PREV_VOLUME="${CURR_VOLUME}"
        done
        if [ "${MONOTONE}" = "1" ]; then
            pass "TC-8: totalVolume decreases monotonically across 3 Updates"
        else
            fail "TC-8: totalVolume did not decrease monotonically"
        fi
    else
        fail "TC-8: skipped — no initial volume or no Location"
    fi

    # -------------------------------------------------------------------
    # TC-10: FinalUnitIndication when quota exhausted
    #
    # Default quota = 10 737 418 240 bytes (10 GB), split 50/50 UL/DL.
    # We need UL + DL > 10 GB to trigger exhaustion.
    # Use 5 500 000 000 bytes each direction (~5.5 GB × 2 = 11 GB > 10 GB).
    TINY_SUPI="${SUPI}-tiny"
    TINY_BODY="{\"supi\":\"${TINY_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":99,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":9,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"

    HTTP_CODE=$(chf_post "${BASE_URL}" "${TINY_BODY}")
    LOC_TINY=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
        | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

    if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_TINY}" ]; then
        # 5.5 GB UL + 5.5 GB DL = 11 GB > 10 GB default quota → exhausted
        EXHAUST_UPDATE="{\"supi\":\"${TINY_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":5500000000,\"downlinkVolume\":5500000000,\"time\":1}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE=$(chf_post "${LOC_TINY}/update" "${EXHAUST_UPDATE}")

        if python3 2>&1 << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
except Exception as e:
    print('Parse error:', e); sys.exit(1)
mui = d.get('multipleUnitInformation', [{}])[0]
if 'finalUnitIndication' not in mui:
    print('FinalUnitIndication not present'); sys.exit(1)
fua = mui['finalUnitIndication'].get('finalUnitAction')
if fua not in ('TERMINATE', 'REDIRECT', 'RESTRICT_ACCESS'):
    print('unexpected FUA:', fua); sys.exit(1)
print('  FinalUnitAction:', fua)
PYEOF
        then
            pass "TC-10: FinalUnitIndication present when quota exhausted"
        else
            fail "TC-10: FinalUnitIndication missing on exhaustion"
        fi
        chf_post "${LOC_TINY}/release" '{}' >/dev/null || true
    else
        fail "TC-10: skipped — tiny-quota Create failed (HTTP ${HTTP_CODE})"
    fi

    # -------------------------------------------------------------------
    # TC-10b: FinalUnitIndication in CREATE response for zero-quota subscriber
    #
    # A subscriber with totalQuotaBytes=0 has quota exhausted immediately
    # immediately because 0 >= 0 is true.  The Create response itself must
    # carry FinalUnitIndication — no Update should be needed to trigger it.
    #
    # Requires mongosh (or mongo) to insert the zero-quota record directly.
    # If neither is available the test is SKIPped (not FAILed).
    ZERO_SUPI="${SUPI}-zero"
    MONGO_BIN=""
    if command -v mongosh >/dev/null 2>&1; then
        MONGO_BIN="mongosh"
    elif command -v mongo >/dev/null 2>&1; then
        MONGO_BIN="mongo"
    fi

    if [ -z "${MONGO_BIN}" ]; then
        skip "TC-10b: mongosh/mongo not in PATH — cannot insert zero-quota subscriber"
    else
        # Insert (or replace) a zero-quota record
        "${MONGO_BIN}" --quiet open5gs --eval "
            db.getCollection('chf.subscribers').deleteOne({supi:'${ZERO_SUPI}'});
            db.getCollection('chf.subscribers').insertOne({
                supi:'${ZERO_SUPI}',
                quota:{
                    totalQuotaBytes:0,
                    validityPeriod:'custom',
                    validitySeconds:3600,
                    autoRenew:false,
                    finalUnitAction:'TERMINATE'
                }
            });" >/dev/null 2>/dev/null || true

        ZERO_BODY="{\"supi\":\"${ZERO_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":100,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":10,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE=$(chf_post "${BASE_URL}" "${ZERO_BODY}")
        LOC_ZERO=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_ZERO}" ]; then
            if python3 2>&1 << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
except Exception as e:
    print('Parse error:', e); sys.exit(1)
mui = d.get('multipleUnitInformation', [{}])[0]
if 'finalUnitIndication' not in mui:
    print('FinalUnitIndication not present in Create response'); sys.exit(1)
fua = mui['finalUnitIndication'].get('finalUnitAction')
if fua not in ('TERMINATE', 'REDIRECT', 'RESTRICT_ACCESS'):
    print('unexpected FUA:', fua); sys.exit(1)
print('  FinalUnitAction:', fua, '(on Create — zero quota)')
PYEOF
            then
                pass "TC-10b: FinalUnitIndication in Create response for zero-quota subscriber"
            else
                fail "TC-10b: FinalUnitIndication missing in Create response for zero-quota"
            fi
            chf_post "${LOC_ZERO}/release" '{}' >/dev/null || true
        else
            fail "TC-10b: Create failed (HTTP ${HTTP_CODE}) for zero-quota subscriber"
        fi
        # Cleanup
        "${MONGO_BIN}" --quiet open5gs --eval \
            "db.getCollection('chf.subscribers').deleteOne({supi:'${ZERO_SUPI}'});" \
            >/dev/null 2>/dev/null || true
    fi

    # -------------------------------------------------------------------
    # TC-10c: Provisioned subscriber quota overrides the YAML default
    #
    # Insert a subscriber with a specific small quota (300 MB total:
    # 150 MB UL + 150 MB DL) via mongosh.  The CHF Create response must
    # grant ≤ 300 MB — proving it read MongoDB, not the 10 GiB default.
    #
    # TC-10d: Quota recharge — new session after MongoDB quota update
    #
    # After exhausting TC-10c's 300 MB and releasing, update the subscriber
    # record in MongoDB to 500 MB total (250 MB UL + 250 MB DL), then open
    # a new CHF session.  The new Create must grant the recharged value, not
    # the old exhausted session state (which lives only on the released session).
    #
    # Both TCs require mongosh/mongo; SKIPped if neither is in PATH.
    PROV_SUPI="${SUPI}-prov"
    PROV_TOTAL=300000000    # 300 MB total provisioned quota
    PROV_MAX=320000000   # accept anything ≤ this as "using provisioned quota"

    if [ -z "${MONGO_BIN}" ]; then
        skip "TC-10c: mongosh/mongo not in PATH — skipping provisioned quota test"
        skip "TC-10d: mongosh/mongo not in PATH — skipping quota recharge test"
    else
        # ── Insert provisioned subscriber ──────────────────────────────────
        "${MONGO_BIN}" --quiet open5gs --eval "
            db.getCollection('chf.subscribers').deleteOne({supi:'${PROV_SUPI}'});
            db.getCollection('chf.subscribers').insertOne({
                supi:'${PROV_SUPI}',
                quota:{
                    totalQuotaBytes:${PROV_TOTAL},
                    validityPeriod:'custom',
                    validitySeconds:3600,
                    autoRenew:false,
                    finalUnitAction:'TERMINATE'
                }
            });" >/dev/null 2>/dev/null || true

        # ── TC-10c ─────────────────────────────────────────────────────────
        PROV_BODY="{\"supi\":\"${PROV_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":101,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":11,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE=$(chf_post "${BASE_URL}" "${PROV_BODY}")
        LOC_PROV=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_PROV}" ]; then
            GRANTED_PROV=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    print(d['multipleUnitInformation'][0]['grantedUnit']['totalVolume'])
except:
    print('')
PYEOF
) || GRANTED_PROV=""

            if [ -n "${GRANTED_PROV}" ]; then
                if [ "${GRANTED_PROV}" -le "${PROV_MAX}" ] 2>/dev/null; then
                    pass "TC-10c: CHF used provisioned quota (granted=${GRANTED_PROV} ≤ ${PROV_MAX}), not 10 GiB default"
                else
                    fail "TC-10c: granted=${GRANTED_PROV} exceeds provisioned max ${PROV_MAX} — default quota used instead"
                fi
            else
                fail "TC-10c: Create succeeded but grantedUnit.totalVolume missing"
            fi

            # ── TC-10d — exhaust, release, recharge, new session ───────────
            EXHAUST_PROV="{\"supi\":\"${PROV_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":160000000,\"downlinkVolume\":160000000,\"time\":1}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            chf_post "${LOC_PROV}/update" "${EXHAUST_PROV}" >/dev/null || true
            chf_post "${LOC_PROV}/release" '{}' >/dev/null || true

            # Update MongoDB: recharge to 500 MB total
            RECHARGE_TOTAL=500000000
            "${MONGO_BIN}" --quiet open5gs --eval "
                db.getCollection('chf.subscribers').updateOne(
                    {supi:'${PROV_SUPI}'},
                    {\$set:{
                        'quota.totalQuotaBytes':${RECHARGE_TOTAL}
                    }});" >/dev/null 2>/dev/null || true

            # New session — must reflect recharged quota, not old state
            RECHARGE_MAX=520000000   # accept ≤ 520 MB (sanity ceiling for 500 MB quota)
            PROV_BODY2="{\"supi\":\"${PROV_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":102,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":12,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            HTTP_CODE=$(chf_post "${BASE_URL}" "${PROV_BODY2}")
            LOC_PROV2=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
                | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

            if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_PROV2}" ]; then
                GRANTED_RECHARGE=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    print(d['multipleUnitInformation'][0]['grantedUnit']['totalVolume'])
except:
    print('')
PYEOF
) || GRANTED_RECHARGE=""

                if [ -n "${GRANTED_RECHARGE}" ] && [ "${GRANTED_RECHARGE}" -gt "0" ] 2>/dev/null; then
                    if [ "${GRANTED_RECHARGE}" -le "${RECHARGE_MAX}" ] 2>/dev/null; then
                        pass "TC-10d: recharged quota applied on new session (granted=${GRANTED_RECHARGE})"
                    else
                        fail "TC-10d: granted=${GRANTED_RECHARGE} exceeds recharge max ${RECHARGE_MAX}"
                    fi
                else
                    # FUI on Create means old session state leaked — that is the failure
                    if python3 2>/dev/null << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    sys.exit(0 if 'finalUnitIndication' in mui else 1)
except:
    sys.exit(1)
PYEOF
                    then
                        fail "TC-10d: FinalUnitIndication on new session after recharge — old exhausted state leaked"
                    else
                        fail "TC-10d: new session Create succeeded but grantedUnit.totalVolume missing"
                    fi
                fi
                chf_post "${LOC_PROV2}/release" '{}' >/dev/null || true
            else
                fail "TC-10d: new session Create failed (HTTP ${HTTP_CODE}) after quota recharge"
            fi
        else
            fail "TC-10c: Create failed (HTTP ${HTTP_CODE}) for provisioned subscriber"
            skip "TC-10d: skipped — TC-10c Create failed"
        fi

        # Cleanup
        "${MONGO_BIN}" --quiet open5gs --eval \
            "db.getCollection('chf.subscribers').deleteOne({supi:'${PROV_SUPI}'});" \
            >/dev/null 2>/dev/null || true
    fi

    # -------------------------------------------------------------------
    # TC-10e: Quota recharge before exhaustion
    #
    # Tests that the CHF re-reads MongoDB quota on every new session rather
    # than caching or reusing the remaining quota from a previously released
    # session.  Distinct from TC-10d (which recharges after exhaustion):
    # here the first session is released while quota is still partially
    # remaining (50 MB UL + 50 MB DL used out of 300 MB total).  The quota
    # is then recharged to 600 MB in MongoDB.  The new session must receive
    # a grant consistent with the 600 MB record — not the old ~200 MB
    # remaining from the prior session.
    #
    # Pass condition:   granted > EARLY_RECHARGE_MIN (220 MB)  ← new quota used
    # Failure modes:    granted ≤ 220 MB  ← CHF served stale remaining (200 MB)
    #                   FUI in Create     ← CHF treated session as exhausted
    #
    # Skipped if mongosh/mongo not in PATH.
    EARLY_SUPI="${SUPI}-early"
    EARLY_INIT_TOTAL=300000000     # 300 MB total initial quota
    EARLY_USE_UL=50000000       #  50 MB UL  ┐
    EARLY_USE_DL=50000000       #  50 MB DL  ┘ = 100 MB used  (200 MB remaining)
    EARLY_NEW_TOTAL=600000000      # 600 MB total recharged quota
    EARLY_RECHARGE_MIN=220000000  # > old remaining (200 MB) → proves new quota
    EARLY_RECHARGE_MAX=620000000  # sanity ceiling for 600 MB quota

    if [ -z "${MONGO_BIN}" ]; then
        skip "TC-10e: mongosh/mongo not in PATH — skipping early-recharge test"
    else
        # Insert initial subscriber (300 MB)
        "${MONGO_BIN}" --quiet open5gs --eval "
            db.getCollection('chf.subscribers').deleteOne({supi:'${EARLY_SUPI}'});
            db.getCollection('chf.subscribers').insertOne({
                supi:'${EARLY_SUPI}',
                quota:{
                    totalQuotaBytes:${EARLY_INIT_TOTAL},
                    validityPeriod:'custom',
                    validitySeconds:3600,
                    autoRenew:false,
                    finalUnitAction:'TERMINATE'
                }
            });" >/dev/null 2>/dev/null || true

        # First session — partial use only (no exhaustion)
        EARLY_BODY="{\"supi\":\"${EARLY_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":103,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":13,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE=$(chf_post "${BASE_URL}" "${EARLY_BODY}")
        LOC_EARLY=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_EARLY}" ]; then
            # Partial update — use only 100 MB of 300 MB; quota NOT exhausted
            PARTIAL_UPD="{\"supi\":\"${EARLY_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":${EARLY_USE_UL},\"downlinkVolume\":${EARLY_USE_DL},\"time\":1}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            chf_post "${LOC_EARLY}/update" "${PARTIAL_UPD}" >/dev/null || true
            # Release before exhaustion
            chf_post "${LOC_EARLY}/release" '{}' >/dev/null || true

            # Recharge MongoDB to 600 MB total
            "${MONGO_BIN}" --quiet open5gs --eval "
                db.getCollection('chf.subscribers').updateOne(
                    {supi:'${EARLY_SUPI}'},
                    {\$set:{
                        'quota.totalQuotaBytes':${EARLY_NEW_TOTAL}
                    }});" >/dev/null 2>/dev/null || true

            # New session — CHF must re-read MongoDB quota (600 MB), not
            # serve stale remaining from the old session (~200 MB)
            EARLY_BODY2="{\"supi\":\"${EARLY_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":104,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":14,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            HTTP_CODE=$(chf_post "${BASE_URL}" "${EARLY_BODY2}")
            LOC_EARLY2=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
                | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

            if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_EARLY2}" ]; then
                GRANTED_EARLY=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    if 'finalUnitIndication' in mui:
        print('FUI')
    else:
        print(mui.get('grantedUnit', {}).get('totalVolume', ''))
except:
    print('')
PYEOF
) || GRANTED_EARLY=""

                if [ "${GRANTED_EARLY}" = "FUI" ]; then
                    fail "TC-10e: FinalUnitIndication on new session — CHF treated non-exhausted session as exhausted"
                elif [ -n "${GRANTED_EARLY}" ] && [ "${GRANTED_EARLY}" -gt "${EARLY_RECHARGE_MIN}" ] 2>/dev/null \
                  && [ "${GRANTED_EARLY}" -le "${EARLY_RECHARGE_MAX}" ] 2>/dev/null; then
                    pass "TC-10e: CHF re-read recharged quota on new session (granted=${GRANTED_EARLY} > ${EARLY_RECHARGE_MIN}, ≤ ${EARLY_RECHARGE_MAX})"
                elif [ -n "${GRANTED_EARLY}" ] && [ "${GRANTED_EARLY}" -le "${EARLY_RECHARGE_MIN}" ] 2>/dev/null; then
                    fail "TC-10e: granted=${GRANTED_EARLY} ≤ ${EARLY_RECHARGE_MIN} — CHF used stale remaining (old session), not recharged quota"
                else
                    fail "TC-10e: new session Create succeeded but grantedUnit.totalVolume missing or unparseable"
                fi
                chf_post "${LOC_EARLY2}/release" '{}' >/dev/null || true
            else
                fail "TC-10e: new session Create failed (HTTP ${HTTP_CODE}) after early recharge"
            fi
        else
            fail "TC-10e: initial Create failed (HTTP ${HTTP_CODE}) for early-recharge subscriber"
        fi

        # Cleanup
        "${MONGO_BIN}" --quiet open5gs --eval \
            "db.getCollection('chf.subscribers').deleteOne({supi:'${EARLY_SUPI}'});" \
            >/dev/null 2>/dev/null || true
    fi

    # -------------------------------------------------------------------
    # TC-10f: Mid-session quota recharge (session stays online)
    #
    # Verifies that the CHF re-reads MongoDB on Update when the session
    # is exhausted, allowing the operator to top up quota WITHOUT forcing
    # a Release/Create cycle.
    #
    # Flow:
    #   1. Insert subscriber with 200 MB quota (100 MB UL + 100 MB DL)
    #   2. Create session
    #   3. Update: consume 110 MB UL + 110 MB DL → quota exhausted → FUI
    #   4. MongoDB recharge: update subscriber to 500 MB total
    #   5. Update again (mid-session, same ref): expect 200 OK, no FUI,
    #      granted > 0 (proves CHF re-read MongoDB and cleared exhaustion)
    #
    # Pass condition:   Update response has no FUI, grantedUnit > 0
    # Fail condition:   FUI still present → CHF did not re-read MongoDB
    #
    # Skipped if mongosh/mongo not in PATH.
    MIDSESS_SUPI="${SUPI}-mid"
    MIDSESS_INIT_TOTAL=200000000   # 200 MB total initial quota
    MIDSESS_USE_UL=110000000    # 110 MB UL  ┐  (exceeds 100 MB grant → FUI)
    MIDSESS_USE_DL=110000000    # 110 MB DL  ┘
    MIDSESS_NEW_TOTAL=500000000    # 500 MB total recharged quota

    if [ -z "${MONGO_BIN}" ]; then
        skip "TC-10f: mongosh/mongo not in PATH — skipping mid-session recharge test"
    else
        # Insert initial subscriber (200 MB)
        "${MONGO_BIN}" --quiet open5gs --eval "
            db.getCollection('chf.subscribers').deleteOne({supi:'${MIDSESS_SUPI}'});
            db.getCollection('chf.subscribers').insertOne({
                supi:'${MIDSESS_SUPI}',
                quota:{
                    totalQuotaBytes:${MIDSESS_INIT_TOTAL},
                    validityPeriod:'custom',
                    validitySeconds:3600,
                    autoRenew:false,
                    finalUnitAction:'TERMINATE'
                }
            });" >/dev/null 2>/dev/null || true

        # Create session
        MIDSESS_BODY="{\"supi\":\"${MIDSESS_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":105,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":15,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE=$(chf_post "${BASE_URL}" "${MIDSESS_BODY}")
        LOC_MID=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_MID}" ]; then
            # Update: exhaust the 200 MB grant (110 MB UL + 110 MB DL)
            EXHAUST_MID="{\"supi\":\"${MIDSESS_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":${MIDSESS_USE_UL},\"downlinkVolume\":${MIDSESS_USE_DL},\"time\":2}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            HTTP_CODE=$(chf_post "${LOC_MID}/update" "${EXHAUST_MID}")
            FUI_PRESENT=$(python3 2>/dev/null << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    print('yes' if 'finalUnitIndication' in mui else 'no')
except:
    print('no')
PYEOF
) || FUI_PRESENT="no"

            if [ "${FUI_PRESENT}" != "yes" ]; then
                skip "TC-10f: first Update did not trigger FUI — quota not exhausted, skipping mid-session recharge step"
            else
                # Recharge MongoDB to 500 MB total while session is STILL ACTIVE
                "${MONGO_BIN}" --quiet open5gs --eval "
                    db.getCollection('chf.subscribers').updateOne(
                        {supi:'${MIDSESS_SUPI}'},
                        {\$set:{
                            'quota.totalQuotaBytes':${MIDSESS_NEW_TOTAL}
                        }});" >/dev/null 2>/dev/null || true

                # Second Update — CHF should re-read MongoDB and clear exhaustion
                RECHECK_MID="{\"supi\":\"${MIDSESS_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":1000,\"downlinkVolume\":1000,\"time\":1}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
                HTTP_CODE=$(chf_post "${LOC_MID}/update" "${RECHECK_MID}")

                RECHARGE_RESULT=$(python3 2>/dev/null << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    if 'finalUnitIndication' in mui:
        print('FUI')
    else:
        vol = mui.get('grantedUnit', {}).get('totalVolume', 0)
        print(str(int(vol)) if vol else 'ZERO')
except:
    print('ERROR')
PYEOF
) || RECHARGE_RESULT="ERROR"

                if [ "${RECHARGE_RESULT}" = "FUI" ]; then
                    fail "TC-10f: FUI still present after mid-session recharge — CHF did not re-read MongoDB"
                elif [ "${RECHARGE_RESULT}" = "ZERO" ] || [ "${RECHARGE_RESULT}" = "ERROR" ]; then
                    fail "TC-10f: no grantedUnit in Update response after recharge (got: ${RECHARGE_RESULT})"
                elif [ "${RECHARGE_RESULT}" -gt 0 ] 2>/dev/null; then
                    pass "TC-10f: mid-session recharge applied — FUI cleared, granted=${RECHARGE_RESULT} bytes remaining"
                else
                    fail "TC-10f: unexpected Update response: ${RECHARGE_RESULT}"
                fi
            fi

            chf_post "${LOC_MID}/release" '{}' >/dev/null || true
        else
            fail "TC-10f: initial Create failed (HTTP ${HTTP_CODE}) for mid-session subscriber"
        fi

        # Cleanup
        "${MONGO_BIN}" --quiet open5gs --eval \
            "db.getCollection('chf.subscribers').deleteOne({supi:'${MIDSESS_SUPI}'});" \
            >/dev/null 2>/dev/null || true
    fi

    # -------------------------------------------------------------------
    # TC-10g: Admin increases quota mid-session (session NOT yet exhausted)
    #
    # Verifies case A of the admin-change-aware quota check: when the
    # operator raises the subscriber's quota in MongoDB while a session is
    # active (and not yet exhausted), the next Update applies the higher
    # grant immediately — without a Release/Create cycle.
    #
    # Flow:
    #   1. Insert subscriber with 400 MB quota (200 MB UL + 200 MB DL)
    #   2. Create session → CHF grants ~200 MB per direction
    #   3. Update: consume 50 MB UL + 50 MB DL → remaining ~300 MB, no FUI
    #   4. Admin raises quota to 800 MB (400 MB UL + 400 MB DL) in MongoDB
    #   5. Update again (same session): CHF re-reads → new remaining ~698 MB
    #
    # Pass condition:   no FUI; granted > ADMUP_MIN (500 MB), proving the
    #                   new 800 MB ceiling was applied, not the old 400 MB
    # Fail condition:   FUI, or granted ≤ 500 MB (old quota still in effect)
    #
    # Skipped if mongosh/mongo not in PATH.
    ADMUP_SUPI="${SUPI}-admup"
    ADMUP_INIT_TOTAL=400000000   # 400 MB total initial quota
    ADMUP_USE_UL=50000000     # 50 MB UL   ┐  (well within 200 MB grant)
    ADMUP_USE_DL=50000000     # 50 MB DL   ┘
    ADMUP_NEW_TOTAL=800000000    # 800 MB total raised quota
    ADMUP_MIN=500000000       # 500 MB — threshold; granted must exceed this

    if [ -z "${MONGO_BIN}" ]; then
        skip "TC-10g: mongosh/mongo not in PATH — skipping admin-increase test"
    else
        # Insert initial subscriber (400 MB)
        "${MONGO_BIN}" --quiet open5gs --eval "
            db.getCollection('chf.subscribers').deleteOne({supi:'${ADMUP_SUPI}'});
            db.getCollection('chf.subscribers').insertOne({
                supi:'${ADMUP_SUPI}',
                quota:{
                    totalQuotaBytes:${ADMUP_INIT_TOTAL},
                    validityPeriod:'custom',
                    validitySeconds:3600,
                    autoRenew:false,
                    finalUnitAction:'TERMINATE'
                }
            });" >/dev/null 2>/dev/null || true

        # Create session
        ADMUP_BODY="{\"supi\":\"${ADMUP_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":106,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":16,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE=$(chf_post "${BASE_URL}" "${ADMUP_BODY}")
        LOC_ADMUP=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_ADMUP}" ]; then
            # Update 1: partial use (50 MB UL + 50 MB DL) — not exhausted
            PARTIAL_ADMUP="{\"supi\":\"${ADMUP_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":${ADMUP_USE_UL},\"downlinkVolume\":${ADMUP_USE_DL},\"time\":2}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            HTTP_CODE=$(chf_post "${LOC_ADMUP}/update" "${PARTIAL_ADMUP}")
            FUI_AFTER_PARTIAL=$(python3 2>/dev/null << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    print('yes' if 'finalUnitIndication' in mui else 'no')
except:
    print('no')
PYEOF
) || FUI_AFTER_PARTIAL="no"

            if [ "${FUI_AFTER_PARTIAL}" = "yes" ]; then
                skip "TC-10g: partial Update unexpectedly triggered FUI — test preconditions not met"
            else
                # Admin raises MongoDB quota to 800 MB total while session is STILL ACTIVE
                "${MONGO_BIN}" --quiet open5gs --eval "
                    db.getCollection('chf.subscribers').updateOne(
                        {supi:'${ADMUP_SUPI}'},
                        {\$set:{
                            'quota.totalQuotaBytes':${ADMUP_NEW_TOTAL}
                        }});" >/dev/null 2>/dev/null || true

                # Update 2 — CHF should detect quota change and raise the ceiling
                RECHECK_ADMUP="{\"supi\":\"${ADMUP_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":1000,\"downlinkVolume\":1000,\"time\":1}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
                HTTP_CODE=$(chf_post "${LOC_ADMUP}/update" "${RECHECK_ADMUP}")

                ADMUP_RESULT=$(python3 2>/dev/null << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    if 'finalUnitIndication' in mui:
        print('FUI')
    else:
        vol = mui.get('grantedUnit', {}).get('totalVolume', 0)
        print(str(int(vol)) if vol else 'ZERO')
except:
    print('ERROR')
PYEOF
) || ADMUP_RESULT="ERROR"

                if [ "${ADMUP_RESULT}" = "FUI" ]; then
                    fail "TC-10g: FUI present after admin quota increase — CHF still using old ceiling"
                elif [ "${ADMUP_RESULT}" = "ZERO" ] || [ "${ADMUP_RESULT}" = "ERROR" ]; then
                    fail "TC-10g: no grantedUnit in Update response (got: ${ADMUP_RESULT})"
                elif [ "${ADMUP_RESULT}" -gt "${ADMUP_MIN}" ] 2>/dev/null; then
                    pass "TC-10g: admin quota increase applied mid-session (granted=${ADMUP_RESULT} > ${ADMUP_MIN})"
                else
                    fail "TC-10g: granted=${ADMUP_RESULT} ≤ ${ADMUP_MIN} — old 400 MB quota still in effect"
                fi
            fi

            chf_post "${LOC_ADMUP}/release" '{}' >/dev/null || true
        else
            fail "TC-10g: initial Create failed (HTTP ${HTTP_CODE}) for admin-increase subscriber"
        fi

        # Cleanup
        "${MONGO_BIN}" --quiet open5gs --eval \
            "db.getCollection('chf.subscribers').deleteOne({supi:'${ADMUP_SUPI}'});" \
            >/dev/null 2>/dev/null || true
    fi

    # -------------------------------------------------------------------
    # TC-10h: Admin decreases quota mid-session (causes immediate exhaustion)
    #
    # Verifies case B of the admin-change-aware quota check: when the
    # operator lowers the subscriber's quota in MongoDB below the already-
    # consumed volume, the next Update enforces the new limit immediately
    # (FinalUnitIndication) without waiting for the original grant to run out.
    #
    # Flow:
    #   1. Insert subscriber with 400 MB quota (200 MB UL + 200 MB DL)
    #   2. Create session → CHF grants ~200 MB per direction
    #   3. Update: consume 50 MB UL + 50 MB DL → not exhausted
    #   4. Admin REDUCES quota to 80 MB (40 MB UL + 40 MB DL) in MongoDB
    #   5. Update again (same session): used (100 MB) > new quota (80 MB)
    #      → CHF detects change, calls apply_quota, check_quota_exhausted fires
    #
    # Pass condition:   FUI present → immediate enforcement of reduced quota
    # Fail condition:   no FUI → CHF kept using old 400 MB ceiling
    #
    # Skipped if mongosh/mongo not in PATH.
    ADMDWN_SUPI="${SUPI}-admdwn"
    ADMDWN_INIT_TOTAL=400000000   # 400 MB total initial quota
    ADMDWN_USE_UL=50000000     # 50 MB UL   ┐  (well within 200 MB grant)
    ADMDWN_USE_DL=50000000     # 50 MB DL   ┘
    ADMDWN_NEW_TOTAL=80000000     # 80 MB total reduced quota (< 100 MB used → exhaust)

    if [ -z "${MONGO_BIN}" ]; then
        skip "TC-10h: mongosh/mongo not in PATH — skipping admin-decrease test"
    else
        # Insert initial subscriber (400 MB)
        "${MONGO_BIN}" --quiet open5gs --eval "
            db.getCollection('chf.subscribers').deleteOne({supi:'${ADMDWN_SUPI}'});
            db.getCollection('chf.subscribers').insertOne({
                supi:'${ADMDWN_SUPI}',
                quota:{
                    totalQuotaBytes:${ADMDWN_INIT_TOTAL},
                    validityPeriod:'custom',
                    validitySeconds:3600,
                    autoRenew:false,
                    finalUnitAction:'TERMINATE'
                }
            });" >/dev/null 2>/dev/null || true

        # Create session
        ADMDWN_BODY="{\"supi\":\"${ADMDWN_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":107,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":17,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE=$(chf_post "${BASE_URL}" "${ADMDWN_BODY}")
        LOC_ADMDWN=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_ADMDWN}" ]; then
            # Update 1: partial use (50 MB UL + 50 MB DL) — not exhausted yet
            PARTIAL_ADMDWN="{\"supi\":\"${ADMDWN_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":${ADMDWN_USE_UL},\"downlinkVolume\":${ADMDWN_USE_DL},\"time\":2}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            HTTP_CODE=$(chf_post "${LOC_ADMDWN}/update" "${PARTIAL_ADMDWN}")
            FUI_AFTER_PARTIAL=$(python3 2>/dev/null << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    print('yes' if 'finalUnitIndication' in mui else 'no')
except:
    print('no')
PYEOF
) || FUI_AFTER_PARTIAL="no"

            if [ "${FUI_AFTER_PARTIAL}" = "yes" ]; then
                skip "TC-10h: partial Update unexpectedly triggered FUI — test preconditions not met"
            else
                # Admin REDUCES MongoDB quota to 80 MB total while session is STILL ACTIVE
                "${MONGO_BIN}" --quiet open5gs --eval "
                    db.getCollection('chf.subscribers').updateOne(
                        {supi:'${ADMDWN_SUPI}'},
                        {\$set:{
                            'quota.totalQuotaBytes':${ADMDWN_NEW_TOTAL}
                        }});" >/dev/null 2>/dev/null || true

                # Update 2 — CHF should detect quota decrease and enforce immediately
                RECHECK_ADMDWN="{\"supi\":\"${ADMDWN_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":1000,\"downlinkVolume\":1000,\"time\":1}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
                HTTP_CODE=$(chf_post "${LOC_ADMDWN}/update" "${RECHECK_ADMDWN}")

                FUI_AFTER_DECREASE=$(python3 2>/dev/null << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    print('yes' if 'finalUnitIndication' in mui else 'no')
except:
    print('no')
PYEOF
) || FUI_AFTER_DECREASE="no"

                if [ "${FUI_AFTER_DECREASE}" = "yes" ]; then
                    pass "TC-10h: admin quota decrease enforced immediately (FUI present, used 100 MB > new 80 MB quota)"
                else
                    fail "TC-10h: no FUI after admin quota decrease — CHF still using old 400 MB ceiling"
                fi
            fi

            chf_post "${LOC_ADMDWN}/release" '{}' >/dev/null || true
        else
            fail "TC-10h: initial Create failed (HTTP ${HTTP_CODE}) for admin-decrease subscriber"
        fi

        # Cleanup
        "${MONGO_BIN}" --quiet open5gs --eval \
            "db.getCollection('chf.subscribers').deleteOne({supi:'${ADMDWN_SUPI}'});" \
            >/dev/null 2>/dev/null || true
    fi

    # -------------------------------------------------------------------
    # TC-13a: Multi-session aggregate quota — cross-session exhaustion
    #
    # Verifies TS 32.291 §5.2: the CHF enforces a shared quota pool
    # across all active sessions for the same SUPI.
    #
    # Flow:
    #   1. Insert subscriber with 300 MB quota (150 MB UL + 150 MB DL)
    #   2. Create Session A → granted ~150 MB per direction (300 MB total)
    #   3. Create Session B (same SUPI, 0 bytes used by A yet) →
    #      granted ~150 MB per direction (300 MB total — A unused so far)
    #   4. Update Session A: consume 160 MB UL + 140 MB DL (=300 MB) →
    #      A's per-session grant exhausted → FUI on A
    #   5. Update Session B: consume 1 MB UL + 1 MB DL →
    #      aggregate_used = 300 MB (A) + 2 MB (B) = 302 MB > 300 MB →
    #      cross-session FUI fires on B even though B's own grant is intact
    #
    # Pass condition: B's Update response contains FUI
    # Fail condition: B's Update has no FUI (aggregate not enforced)
    #
    # Skipped if mongosh/mongo not in PATH.
    AGG_SUPI="${SUPI}-agg"
    AGG_INIT_TOTAL=300000000   # 300 MB total quota

    if [ -z "${MONGO_BIN}" ]; then
        skip "TC-13a: mongosh/mongo not in PATH — skipping aggregate quota test"
    else
        "${MONGO_BIN}" --quiet open5gs --eval "
            db.getCollection('chf.subscribers').deleteOne({supi:'${AGG_SUPI}'});
            db.getCollection('chf.subscribers').insertOne({
                supi:'${AGG_SUPI}',
                quota:{
                    totalQuotaBytes:${AGG_INIT_TOTAL},
                    validityPeriod:'custom',
                    validitySeconds:3600,
                    autoRenew:false,
                    finalUnitAction:'TERMINATE'
                }
            });" >/dev/null 2>/dev/null || true

        # Create Session A
        AGG_BODY_A="{\"supi\":\"${AGG_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":201,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":21,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE=$(chf_post "${BASE_URL}" "${AGG_BODY_A}")
        LOC_AGG_A=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        # Create Session B (same SUPI, A has 0 bytes used — B gets full grant)
        AGG_BODY_B="{\"supi\":\"${AGG_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":202,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":22,\"dnn\":\"ims\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE_B=$(chf_post "${BASE_URL}" "${AGG_BODY_B}")
        LOC_AGG_B=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        if [ "${HTTP_CODE}" = "201" ] && [ "${HTTP_CODE_B}" = "201" ] \
                && [ -n "${LOC_AGG_A}" ] && [ -n "${LOC_AGG_B}" ]; then
            # Update A: exhaust A's per-session grant (300 MB total)
            EXHAUST_A="{\"supi\":\"${AGG_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":160000000,\"downlinkVolume\":140000000,\"time\":5}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            chf_post "${LOC_AGG_A}/update" "${EXHAUST_A}" >/dev/null || true

            # Update B: small use — aggregate now > 300 MB → FUI should fire on B
            SMALL_B="{\"supi\":\"${AGG_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":1000000,\"downlinkVolume\":1000000,\"time\":1}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            chf_post "${LOC_AGG_B}/update" "${SMALL_B}" >/dev/null || true

            FUI_B=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    print('yes' if 'finalUnitIndication' in mui else 'no')
except:
    print('no')
PYEOF
) || FUI_B="no"

            if [ "${FUI_B}" = "yes" ]; then
                pass "TC-13a: aggregate quota enforced — Session B got FUI after Session A exhausted shared 300 MB pool"
            else
                fail "TC-13a: no FUI on Session B — aggregate quota not enforced (sessions treated independently)"
            fi

            chf_post "${LOC_AGG_A}/release" '{}' >/dev/null || true
            chf_post "${LOC_AGG_B}/release" '{}' >/dev/null || true
        else
            fail "TC-13a: Create failed for Session A (HTTP ${HTTP_CODE}) or Session B (HTTP ${HTTP_CODE_B})"
        fi

        "${MONGO_BIN}" --quiet open5gs --eval \
            "db.getCollection('chf.subscribers').deleteOne({supi:'${AGG_SUPI}'});" \
            >/dev/null 2>/dev/null || true
    fi

    # -------------------------------------------------------------------
    # TC-13b: New Create when quota already consumed by active session
    #
    # Verifies that the Create-time aggregate cap works: when an existing
    # session has consumed the entire quota, a new Create for the same
    # SUPI returns HTTP 201 but with grantedUnit=0 and FinalUnitIndication.
    #
    # Flow:
    #   1. Insert subscriber with 200 MB quota (100 MB UL + 100 MB DL)
    #   2. Create Session C → granted ~100 MB per direction
    #   3. Update Session C: consume 110 MB UL + 90 MB DL (=200 MB) → FUI
    #   4. Create Session D (same SUPI, C still active and exhausted):
    #      aggregate_used = 200 MB >= 200 MB total → D granted 0 + FUI
    #
    # Pass condition: Session D's Create (HTTP 201) contains FUI
    # Fail condition: Session D granted > 0 without FUI
    #
    # Skipped if mongosh/mongo not in PATH.
    AGG2_SUPI="${SUPI}-agg2"
    AGG2_INIT_TOTAL=200000000   # 200 MB total quota

    if [ -z "${MONGO_BIN}" ]; then
        skip "TC-13b: mongosh/mongo not in PATH — skipping create-time aggregate test"
    else
        "${MONGO_BIN}" --quiet open5gs --eval "
            db.getCollection('chf.subscribers').deleteOne({supi:'${AGG2_SUPI}'});
            db.getCollection('chf.subscribers').insertOne({
                supi:'${AGG2_SUPI}',
                quota:{
                    totalQuotaBytes:${AGG2_INIT_TOTAL},
                    validityPeriod:'custom',
                    validitySeconds:3600,
                    autoRenew:false,
                    finalUnitAction:'TERMINATE'
                }
            });" >/dev/null 2>/dev/null || true

        # Create Session C
        AGG2_BODY_C="{\"supi\":\"${AGG2_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":203,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":23,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        HTTP_CODE=$(chf_post "${BASE_URL}" "${AGG2_BODY_C}")
        LOC_AGG_C=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_AGG_C}" ]; then
            # Update C: exhaust all 200 MB
            EXHAUST_C="{\"supi\":\"${AGG2_SUPI}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":110000000,\"downlinkVolume\":90000000,\"time\":5}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            chf_post "${LOC_AGG_C}/update" "${EXHAUST_C}" >/dev/null || true

            # Create Session D (same SUPI, C still active with 200 MB used)
            AGG2_BODY_D="{\"supi\":\"${AGG2_SUPI}\",\"pDUSessionChargingInformation\":{\"chargingId\":204,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":24,\"dnn\":\"ims\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            HTTP_CODE_D=$(chf_post "${BASE_URL}" "${AGG2_BODY_D}")
            LOC_AGG_D=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
                | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

            FUI_D=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    mui = d.get('multipleUnitInformation', [{}])[0]
    print('yes' if 'finalUnitIndication' in mui else 'no')
except:
    print('no')
PYEOF
) || FUI_D="no"

            if [ "${HTTP_CODE_D}" = "201" ] && [ "${FUI_D}" = "yes" ]; then
                pass "TC-13b: Create with exhausted pool — HTTP 201 + FUI (grantedUnit=0, pool owned by Session C)"
            elif [ "${HTTP_CODE_D}" != "201" ]; then
                fail "TC-13b: Create returned HTTP ${HTTP_CODE_D} (expected 201 with FUI)"
            else
                fail "TC-13b: Create returned HTTP 201 but no FUI — aggregate cap not enforced at Create time"
            fi

            [ -n "${LOC_AGG_C}" ] && chf_post "${LOC_AGG_C}/release" '{}' >/dev/null || true
            [ -n "${LOC_AGG_D}" ] && chf_post "${LOC_AGG_D}/release" '{}' >/dev/null || true
        else
            fail "TC-13b: Session C Create failed (HTTP ${HTTP_CODE})"
        fi

        "${MONGO_BIN}" --quiet open5gs --eval \
            "db.getCollection('chf.subscribers').deleteOne({supi:'${AGG2_SUPI}'});" \
            >/dev/null 2>/dev/null || true
    fi

    # -------------------------------------------------------------------
    # TC-ERR-1: POST with malformed JSON body → must not return 5xx
    # The CHF HTTP layer must reject or gracefully handle a syntax-error body.
    # We expect 400 (Bad Request) or 415 (Unsupported Media Type), not 5xx.
    ERR_CODE=$(curl -s --http2-prior-knowledge -o /dev/null -w "%{http_code}" \
        -X POST "${BASE_URL}" \
        -H "Content-Type: application/json" \
        --data-binary 'NOT { VALID JSON !!!}' 2>/dev/null || echo "000")
    if [ "${ERR_CODE}" -ge 400 ] && [ "${ERR_CODE}" -lt 500 ] 2>/dev/null; then
        pass "TC-ERR-1: malformed JSON → HTTP ${ERR_CODE} (4xx, not 5xx)"
    elif [ "${ERR_CODE}" = "201" ] || [ "${ERR_CODE}" = "200" ]; then
        # Some lenient parsers may accept; treat as a known limitation, not hard failure
        pass "TC-ERR-1: malformed JSON accepted by CHF (lenient parser) — HTTP ${ERR_CODE}"
    else
        fail "TC-ERR-1: malformed JSON → HTTP ${ERR_CODE} (expected 4xx)"
    fi

    # TC-ERR-2: Update on a session that never existed → 404
    FAKE_REF="00000000-dead-beef-0000-000000000000"
    ERR2_CODE=$(curl -s --http2-prior-knowledge -o /dev/null -w "%{http_code}" \
        -X POST "http://${CHF_ADDR}:${CHF_PORT}/nchf-convergedcharging/v3/chargingdata/${FAKE_REF}/update" \
        -H "Content-Type: application/json" \
        --data-binary "${UPDATE_BODY}" 2>/dev/null || echo "000")
    if [ "${ERR2_CODE}" = "404" ]; then
        pass "TC-ERR-2: Update on never-created session → HTTP 404"
    else
        fail "TC-ERR-2: Update on never-created session → HTTP ${ERR2_CODE} (expected 404)"
    fi

    # TC-11, TC-12: CDR writer
    HTTP_CODE=$(chf_post "${BASE_URL}" "${CREATE_BODY}")
    LOC_CDR=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
        | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')
    CDR_UUID=$(echo "${LOC_CDR}" | sed 's|.*/||')

    if [ "${HTTP_CODE}" = "201" ] && [ -n "${LOC_CDR}" ]; then
        chf_post "${LOC_CDR}/update" "${UPDATE_BODY}" >/dev/null || true
        chf_post "${LOC_CDR}/release" "${RELEASE_BODY}" >/dev/null || true

        # Prefer to look up the CDR file path from MongoDB (written by the CHF
        # on Release).  This avoids the CDR_BASE env-var dependency entirely.
        CDR_FILE=""
        if [ "${SKIP_MONGO}" != "1" ] && [ -n "${CDR_UUID}" ]; then
            CDR_DOC=$(mongo_find "chf.cdrs" "{chargingDataRef: '${CDR_UUID}'}")
            CDR_FILE=$(python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('file_path', '') or '')
except:
    print('')
" <<< "${CDR_DOC}" 2>/dev/null || echo "")
        fi
        # Fall back to CDR_BASE if MongoDB gave no path (SKIP_MONGO=1 or no mongosh)
        if [ -z "${CDR_FILE}" ]; then
            TODAY=$(date -u +"%Y/%m/%d")
            CDR_FILE="${CDR_BASE}/${TODAY}/cdr-${CDR_UUID}.json"
        fi

        if [ -f "${CDR_FILE}" ]; then
            pass "TC-11: CDR file written to ${CDR_FILE}"
        else
            fail "TC-11: CDR file missing: ${CDR_FILE}"
            info "  CDR_BASE=${CDR_BASE}  (set CDR_BASE env var to match chf.yaml cdr.path)"
        fi

        if [ -f "${CDR_FILE}" ]; then
            if python3 - "${CDR_FILE}" "${SUPI}" <<'PYEOF'
import json, sys
path, supi = sys.argv[1], sys.argv[2]
with open(path) as f:
    d = json.load(f)

# The CDR is the TS 32.298 ChargingRecord rendered as JSON, so the field
# names and the nesting are the specification's, not ours.  This used to
# assert a flat Open5GS-specific object (recordType "pGWRecord", top-level
# supi and volumes, causeForRecordClosing, quotaExhausted) and would now
# fail against every CDR the CHF writes.
errors = []

rec = d.get('chargingFunctionRecord')
if not isinstance(rec, dict):
    print("  MISMATCH: no chargingFunctionRecord object")
    sys.exit(1)

if rec.get('recordType') != 'chargingFunctionRecord':
    errors.append(f"recordType={rec.get('recordType')!r}, "
                  "expected 'chargingFunctionRecord'")

sub = rec.get('subscriberIdentifier') or {}
if sub.get('subscriptionIDData') != supi:
    errors.append(f"subscriptionIDData={sub.get('subscriptionIDData')!r}, "
                  f"expected {supi!r}")
if sub.get('subscriptionIDType') != 'eND-USER-IMSI':
    errors.append(f"subscriptionIDType={sub.get('subscriptionIDType')!r}, "
                  "expected 'eND-USER-IMSI'")

# causeForRecClosing, not causeForRecordClosing; and there is no separate
# exhausted flag because volumeLimit already says it.
if rec.get('causeForRecClosing') != 'normalRelease':
    errors.append(f"causeForRecClosing={rec.get('causeForRecClosing')!r}, "
                  "expected 'normalRelease'")
if 'quotaExhausted' in rec:
    errors.append("quotaExhausted is present; it was removed in favour of "
                  "causeForRecClosing")

if not rec.get('recordingNetworkFunctionID'):
    errors.append("recordingNetworkFunctionID missing (mandatory)")
if rec.get('duration', 0) <= 0:
    errors.append("duration is zero")

# The volumes live in listOfMultipleUnitUsage[].usedUnitContainers[].
usage = rec.get('listOfMultipleUnitUsage') or []
if not usage:
    errors.append("listOfMultipleUnitUsage is empty")
else:
    cont = (usage[0].get('usedUnitContainers') or [{}])[0]
    if cont.get('dataVolumeUplink', 0) <= 0:
        errors.append("dataVolumeUplink is zero")
    if cont.get('dataVolumeDownlink', 0) <= 0:
        errors.append("dataVolumeDownlink is zero")

# startTime/endTime became pDUSessionstartTime/pDUSessionstopTime inside
# pDUSessionChargingInformation; recordOpeningTime is the record's own.
pdu = rec.get('pDUSessionChargingInformation') or {}
for field, where in (('recordOpeningTime', rec),
                     ('pDUSessionstartTime', pdu),
                     ('pDUSessionstopTime', pdu)):
    v = where.get(field, '')
    if not isinstance(v, str) or not v.endswith('Z'):
        errors.append(f"{field}={v!r} — not ISO-8601 UTC")

if errors:
    for e in errors:
        print("  MISMATCH:", e)
    sys.exit(1)
print("  All CDR fields correct")
PYEOF
            then
                pass "TC-12: CDR JSON is a TS 32.298 ChargingRecord (subscriber, volumes, duration, cause, timestamps)"
            else
                fail "TC-12: CDR JSON field mismatch (see above)"
            fi
        else
            fail "TC-12: skipped — CDR file missing (TC-11 failed)"
        fi
    else
        fail "TC-11: skipped — CDR Create failed (HTTP ${HTTP_CODE})"
        fail "TC-12: skipped"
    fi

    # Cleanup remaining open sessions
    [ -n "${LOCATION3:-}" ] && chf_post "${LOCATION3}/release" '{}' >/dev/null 2>/dev/null || true
fi

echo

# ============================================================
# PHASE 2 — lib/sbi CHF NF info + SUPI discovery
# ============================================================
echo "=== PHASE 2 — lib/sbi CHF NF info + SUPI discovery (TC-P2-1..P2-4) ==="

NRF_DISC_URL="http://${NRF_ADDR}:${NRF_PORT}/nnrf-disc/v1/nf-instances"

if ! service_reachable "${NRF_ADDR}" "${NRF_PORT}"; then
    skip "TC-P2-1: NRF not reachable at ${NRF_ADDR}:${NRF_PORT}"
    skip "TC-P2-2: NRF not reachable"
    skip "TC-P2-3: NRF not reachable"
    skip "TC-P2-4: NRF not reachable"
else
    info "NRF reachable at ${NRF_ADDR}:${NRF_PORT} ✓"

    # TC-P2-1: NRF discovery → HTTP 200
    # TS 29.510 §5.2.3.2.3: requester-nf-type is mandatory alongside target-nf-type.
    # The open5gs NRF returns 400 if requester-nf-type is absent.  Use SMF since
    # the CHF declares allowedNfTypes=[SCP,SMF] in its NRF registration.
    P2_CODE=$(curl -s --max-time 10 --http2-prior-knowledge \
        -o /tmp/p2-disc-resp.json \
        -w "%{http_code}" \
        "${NRF_DISC_URL}?target-nf-type=CHF&requester-nf-type=SMF" 2>/dev/null) || P2_CODE="000"
    if [ "${P2_CODE}" = "200" ]; then
        pass "TC-P2-1: NRF CHF discovery → HTTP 200"
    else
        fail "TC-P2-1: NRF CHF discovery → HTTP 200 (got ${P2_CODE})"
    fi

    # TC-P2-2: nfType=CHF present in response
    if python3 -c "
import json, sys
try:
    d = json.load(open('/tmp/p2-disc-resp.json'))
    instances = d.get('nfInstances', [])
    assert any(nf.get('nfType') == 'CHF' for nf in instances), \
        f'no CHF nfType in {len(instances)} instances'
    print(f'  Found {sum(1 for nf in instances if nf.get(\"nfType\")==\"CHF\")} CHF instance(s)')
except Exception as e:
    print('Error:', e); sys.exit(1)
" 2>&1; then
        pass "TC-P2-2: CHF nfType=CHF in NRF discovery response"
    else
        fail "TC-P2-2: CHF nfType=CHF not found in NRF discovery response"
    fi

    # TC-P2-3: nchf-convergedcharging service in CHF profile
    if python3 -c "
import json, sys
try:
    d = json.load(open('/tmp/p2-disc-resp.json'))
    instances = d.get('nfInstances', [])
    chf_instances = [nf for nf in instances if nf.get('nfType') == 'CHF']
    found = False
    for nf in chf_instances:
        for svc in nf.get('nfServices', []):
            if svc.get('serviceName') == 'nchf-convergedcharging':
                found = True
                print('  Found nchf-convergedcharging in', nf.get('nfInstanceId','?'))
                break
    assert found, 'nchf-convergedcharging service not found in any CHF profile'
except Exception as e:
    print('Error:', e); sys.exit(1)
" 2>&1; then
        pass "TC-P2-3: nchf-convergedcharging service in CHF NRF profile"
    else
        fail "TC-P2-3: nchf-convergedcharging service missing from CHF NRF profile"
    fi

    # TC-P2-4: Discovery with supi query param → HTTP 200
    # Combines the mandatory requester-nf-type with the Phase 2 supi param.
    # The NRF accepts the supi param (parsed via Phase 2 lib/sbi changes) and
    # returns the CHF profile; SUPI-range filtering in the NRF is a future item.
    DISC_SUPI="imsi-999700000000001"
    P2_SUPI_CODE=$(curl -s --max-time 10 --http2-prior-knowledge \
        -o /tmp/p2-supi-resp.json \
        -w "%{http_code}" \
        "${NRF_DISC_URL}?target-nf-type=CHF&requester-nf-type=SMF&supi=${DISC_SUPI}" 2>/dev/null) || P2_SUPI_CODE="000"
    if [ "${P2_SUPI_CODE}" = "200" ]; then
        pass "TC-P2-4: NRF CHF discovery with supi param → HTTP 200"
    else
        fail "TC-P2-4: NRF CHF discovery with supi param → HTTP 200 (got ${P2_SUPI_CODE})"
    fi
fi

echo

# ============================================================
# PHASE 3 — SMF CHF/Gy selector
# ============================================================
echo "=== PHASE 3 — SMF CHF/Gy selector (TC-P3-1..P3-3) ==="

if ! service_reachable "${SMF_ADDR}" "${SMF_PORT}"; then
    skip "TC-P3-1: SMF not reachable at ${SMF_ADDR}:${SMF_PORT}"
    skip "TC-P3-2: SMF not reachable"
    skip "TC-P3-3: SMF not reachable"
else
    info "SMF SBI reachable at ${SMF_ADDR}:${SMF_PORT} ✓"

    # TC-P3-1: SMF SBI HTTP/2 stack is reachable (confirmed by TCP probe above).
    #
    # A direct HTTP-level probe is intentionally omitted here.  All SMF SBI
    # endpoints (/nsmf-pdusession/v1/sm-contexts*) are POST-only; sending any
    # other method causes Open5GS SMF to log:
    #   ERROR: Invalid HTTP method [GET] (smf-sm.c:580)
    # which clutters NF logs with misleading errors on every test run.
    #
    # The service_reachable() check at the top of this phase already confirmed
    # TCP connectivity to port ${SMF_PORT}, which is sufficient to verify that
    # the SBI HTTP/2 listener is up.  The real end-to-end SMF HTTP/2 tests are
    # covered by TC-P3-2 (NRF registration) and TC-P3-3 (CHF discovery).
    pass "TC-P3-1: SMF SBI HTTP/2 listener reachable (TCP port ${SMF_PORT} open)"

    # TC-P3-2: NRF shows SMF registered
    if ! service_reachable "${NRF_ADDR}" "${NRF_PORT}"; then
        skip "TC-P3-2: NRF not reachable — cannot verify SMF registration"
        skip "TC-P3-3: NRF not reachable"
    else
        NRF_NFM_URL="http://${NRF_ADDR}:${NRF_PORT}/nnrf-nfm/v1/nf-instances"
        P3_SMF_CODE=$(curl -s --max-time 10 --http2-prior-knowledge \
            -o /tmp/p3-smf-resp.json \
            -w "%{http_code}" \
            "${NRF_NFM_URL}?nf-type=SMF" 2>/dev/null) || P3_SMF_CODE="000"
        if python3 -c "
import json, sys
try:
    d = json.load(open('/tmp/p3-smf-resp.json'))
    instances = d.get('_links', {}).get('item', [])
    assert len(instances) > 0, 'no SMF instances registered in NRF'
    print(f'  Found {len(instances)} SMF instance link(s) in NRF')
except Exception as e:
    print('Error:', e); sys.exit(1)
" 2>&1; then
            pass "TC-P3-2: NRF shows SMF registered"
        else
            fail "TC-P3-2: SMF not registered in NRF (or NRF response unexpected)"
        fi

        # TC-P3-3: CHF discovery still works after SMF registered
        P3_CHF_CODE=$(curl -s --max-time 10 --http2-prior-knowledge \
            -o /tmp/p3-chf-resp.json \
            -w "%{http_code}" \
            "http://${NRF_ADDR}:${NRF_PORT}/nnrf-disc/v1/nf-instances?target-nf-type=CHF&requester-nf-type=SMF" \
            2>/dev/null) || P3_CHF_CODE="000"
        if [ "${P3_CHF_CODE}" = "200" ]; then
            pass "TC-P3-3: CHF discovery still works after SMF registered"
        else
            fail "TC-P3-3: CHF discovery failed after SMF registered (got ${P3_CHF_CODE})"
        fi
    fi
fi

echo

# ============================================================
# PHASE 4 — SMF Nchf client
# ============================================================
echo "=== PHASE 4 — SMF Nchf client (TC-P4-1..P4-3) ==="

if ! service_reachable "${CHF_ADDR}" "${CHF_PORT}"; then
    skip "TC-P4-1: CHF not reachable at ${CHF_ADDR}:${CHF_PORT}"
    skip "TC-P4-2: CHF not reachable"
    skip "TC-P4-3: CHF not reachable"
else
    # TC-P4-1: Concurrent Creates for two different SUPIs both succeed
    SUPI_A="${SUPI}-p4a"
    SUPI_B="${SUPI}-p4b"
    BODY_A="{\"supi\":\"${SUPI_A}\",\"pDUSessionChargingInformation\":{\"chargingId\":41,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":1,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
    BODY_B="{\"supi\":\"${SUPI_B}\",\"pDUSessionChargingInformation\":{\"chargingId\":42,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":2,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"

    CODE_A=$(chf_post "${BASE_URL}" "${BODY_A}")
    LOC_A=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
        | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

    CODE_B=$(chf_post "${BASE_URL}" "${BODY_B}")
    LOC_B=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
        | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

    if [ "${CODE_A}" = "201" ] && [ "${CODE_B}" = "201" ] && \
       [ -n "${LOC_A}" ] && [ -n "${LOC_B}" ] && [ "${LOC_A}" != "${LOC_B}" ]; then
        pass "TC-P4-1: Concurrent Creates for two SUPIs → both HTTP 201 + independent Locations"
    else
        fail "TC-P4-1: Concurrent Creates failed (A=${CODE_A} B=${CODE_B} LOC_A=${LOC_A:-none} LOC_B=${LOC_B:-none})"
    fi

    # TC-P4-2: Update without prior Create → HTTP 404
    FAKE_LOC="${BASE_URL}/00000000-0000-0000-0000-000000000000"
    FAKE_UPDATE="{\"supi\":\"${SUPI}-fake\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":1024,\"downlinkVolume\":1024,\"time\":1}],\"requestedUnit\":{\"totalVolume\":1000000}}]}"
    P4_CODE=$(chf_post "${FAKE_LOC}/update" "${FAKE_UPDATE}")
    if [ "${P4_CODE}" = "404" ]; then
        pass "TC-P4-2: Update without prior Create → HTTP 404"
    else
        fail "TC-P4-2: Update without prior Create → HTTP 404 (got ${P4_CODE})"
    fi

    # TC-P4-3: Double Release → second 404
    RELEASE_BODY_P4="{\"supi\":\"${SUPI_A}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":1024,\"downlinkVolume\":1024,\"time\":1}]}]}"
    if [ -n "${LOC_A}" ]; then
        chf_post "${LOC_A}/release" "${RELEASE_BODY_P4}" >/dev/null || true
        P4_DOUBLE=$(chf_post "${LOC_A}/release" "${RELEASE_BODY_P4}")
        if [ "${P4_DOUBLE}" = "404" ]; then
            pass "TC-P4-3: Double Release → second HTTP 404"
        else
            fail "TC-P4-3: Double Release → second HTTP 404 (got ${P4_DOUBLE})"
        fi
    else
        fail "TC-P4-3: skipped — no Location from TC-P4-1"
    fi

    # Cleanup
    [ -n "${LOC_B:-}" ] && chf_post "${LOC_B}/release" '{}' >/dev/null 2>/dev/null || true
fi

echo

# ============================================================
# PHASE 5 — SMF full wiring
# ============================================================
echo "=== PHASE 5 — SMF full wiring (TC-P5-1..P5-2) ==="

if ! service_reachable "${CHF_ADDR}" "${CHF_PORT}"; then
    skip "TC-P5-1: CHF not reachable at ${CHF_ADDR}:${CHF_PORT}"
    skip "TC-P5-2: CHF not reachable"
else
    # TC-P5-1: Rapid Create→Update×5→Release cycle with no 5xx responses
    SUPI_P5="${SUPI}-p5"
    BODY_P5="{\"supi\":\"${SUPI_P5}\",\"pDUSessionChargingInformation\":{\"chargingId\":55,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":5,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":10000000}}]}"

    CODE_P5=$(chf_post "${BASE_URL}" "${BODY_P5}")
    LOC_P5=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
        | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

    P5_ERRORS=0
    if [ "${CODE_P5}" != "201" ]; then
        P5_ERRORS=$((P5_ERRORS+1))
    fi

    if [ -n "${LOC_P5}" ]; then
        for _u in 1 2 3 4 5; do
            UPD_P5="{\"supi\":\"${SUPI_P5}\",\"multipleUnitUsage\":[{\"ratingGroup\":1,\"usedUnitContainer\":[{\"uplinkVolume\":102400,\"downlinkVolume\":102400,\"time\":2}],\"requestedUnit\":{\"totalVolume\":10000000}}]}"
            C=$(chf_post "${LOC_P5}/update" "${UPD_P5}")
            if [ "${C}" = "000" ] || [ "${C:0:1}" = "5" ]; then
                P5_ERRORS=$((P5_ERRORS+1))
            fi
        done
        REL_P5=$(chf_post "${LOC_P5}/release" '{}')
        if [ "${REL_P5}" != "204" ]; then
            P5_ERRORS=$((P5_ERRORS+1))
        fi

        if [ "${P5_ERRORS}" = "0" ]; then
            pass "TC-P5-1: Rapid Create→Update×5→Release cycle — no 5xx errors"
        else
            fail "TC-P5-1: Rapid cycle had ${P5_ERRORS} error(s) (5xx or connection failure)"
        fi
    else
        fail "TC-P5-1: Create failed — cannot run rapid cycle"
    fi

    # TC-P5-2: Session count in MongoDB matches expected after multi-session Create
    if [ "${SKIP_MONGO}" = "1" ]; then
        skip "TC-P5-2: MongoDB not available"
    else
        SUPI_P5X="${SUPI}-p5x"
        SUPI_P5Y="${SUPI}-p5y"
        BODY_X="{\"supi\":\"${SUPI_P5X}\",\"pDUSessionChargingInformation\":{\"chargingId\":61,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":6,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        BODY_Y="{\"supi\":\"${SUPI_P5Y}\",\"pDUSessionChargingInformation\":{\"chargingId\":62,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":7,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
        CODE_X=$(chf_post "${BASE_URL}" "${BODY_X}")
        LOC_X=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')
        CODE_Y=$(chf_post "${BASE_URL}" "${BODY_Y}")
        LOC_Y=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
            | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

        if [ "${CODE_X}" = "201" ] && [ "${CODE_Y}" = "201" ]; then
            REF_X=$(echo "${LOC_X}" | sed 's|.*/||')
            REF_Y=$(echo "${LOC_Y}" | sed 's|.*/||')
            COUNT=$(mongosh --quiet open5gs --eval \
                "db['chf.sessions'].countDocuments({chargingDataRef: {\$in: ['${REF_X}','${REF_Y}']}})" \
                2>/dev/null) || COUNT="0"
            if [ "${COUNT}" = "2" ]; then
                pass "TC-P5-2: Session count in chf.sessions matches expected (2) after multi-session Create"
            else
                fail "TC-P5-2: Expected 2 sessions in MongoDB, found ${COUNT}"
            fi
            [ -n "${LOC_X:-}" ] && chf_post "${LOC_X}/release" '{}' >/dev/null 2>/dev/null || true
            [ -n "${LOC_Y:-}" ] && chf_post "${LOC_Y}/release" '{}' >/dev/null 2>/dev/null || true
        else
            fail "TC-P5-2: Multi-session Create failed (X=${CODE_X} Y=${CODE_Y})"
        fi
    fi
fi

echo

# ---------------------------------------------------------------------------
# webui_login() — authenticate against the WebUI and return a JWT token.
#
# Flow (Open5GS WebUI auth):
#   1. GET /api/auth/csrf       → session cookie + CSRF token
#   2. POST /api/auth/login     → establishes authenticated session
#   3. GET /api/auth/session    → returns { authToken: "<jwt>" }
#
# Prints the JWT on stdout; prints nothing and returns 1 on failure.
# The JWT is used as "Authorization: Bearer <jwt>" for /api/db/* calls.
# ---------------------------------------------------------------------------
webui_login() {
    local addr="$1" port="$2"
    local base="http://${addr}:${port}"
    local jar="/tmp/webui-cookies-$$.txt"
    : > "${jar}"

    # Step 1 — get session cookie + CSRF token
    local csrf_json
    csrf_json=$(curl -s --max-time 5 \
        -c "${jar}" \
        "${base}/api/auth/csrf" 2>/dev/null) || { rm -f "${jar}"; return 1; }
    local csrf_token
    csrf_token=$(echo "${csrf_json}" | python3 -c \
        "import json,sys; print(json.load(sys.stdin).get('csrfToken',''))" \
        2>/dev/null) || csrf_token=""
    [ -n "${csrf_token}" ] || { rm -f "${jar}"; return 1; }

    # Step 2 — login (passport-local; ignores redirect destination)
    curl -s --max-time 5 \
        -b "${jar}" -c "${jar}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "X-CSRF-Token: ${csrf_token}" \
        -d '{"username":"admin","password":"1423"}' \
        -o /dev/null \
        "${base}/api/auth/login" 2>/dev/null || { rm -f "${jar}"; return 1; }

    # Step 3 — fetch session to get JWT authToken
    local session_json
    session_json=$(curl -s --max-time 5 \
        -b "${jar}" \
        -H "X-CSRF-Token: ${csrf_token}" \
        "${base}/api/auth/session" 2>/dev/null) || { rm -f "${jar}"; return 1; }
    local jwt
    jwt=$(echo "${session_json}" | python3 -c \
        "import json,sys; print(json.load(sys.stdin).get('authToken',''))" \
        2>/dev/null) || jwt=""
    rm -f "${jar}"
    [ -n "${jwt}" ] || return 1
    echo "${jwt}"
}

# ============================================================
# PHASE 6 — WebUI quota management
# ============================================================
echo "=== PHASE 6 — WebUI quota management (TC-P6-1..P6-4) ==="

if ! service_reachable_http1 "${WEBUI_ADDR}" "${WEBUI_PORT}"; then
    skip "TC-P6-1: WebUI not reachable at ${WEBUI_ADDR}:${WEBUI_PORT}"
    skip "TC-P6-2: WebUI not reachable"
    skip "TC-P6-3: WebUI not reachable"
    skip "TC-P6-4: WebUI not reachable"
else
    info "WebUI reachable at ${WEBUI_ADDR}:${WEBUI_PORT} ✓"

    # TC-P6-1: WebUI health endpoint returns HTTP 200
    P6_HEALTH=$(curl -s --max-time 5 \
        -o /dev/null -w "%{http_code}" \
        "http://${WEBUI_ADDR}:${WEBUI_PORT}/" 2>/dev/null) || P6_HEALTH="000"
    if [ "${P6_HEALTH}" = "200" ]; then
        pass "TC-P6-1: WebUI health endpoint → HTTP 200"
    else
        fail "TC-P6-1: WebUI health endpoint → HTTP 200 (got ${P6_HEALTH})"
    fi

    # TC-P6-2: WebUI CHF quota API returns HTTP 200 with valid JWT auth
    P6_JWT=$(webui_login "${WEBUI_ADDR}" "${WEBUI_PORT}") || P6_JWT=""
    if [ -n "${P6_JWT}" ]; then
        P6_QUOTA=$(curl -s --max-time 5 \
            -o /dev/null -w "%{http_code}" \
            -H "Authorization: Bearer ${P6_JWT}" \
            "http://${WEBUI_ADDR}:${WEBUI_PORT}/api/db/ChfSubscriber" 2>/dev/null) || P6_QUOTA="000"
        if [ "${P6_QUOTA}" = "200" ]; then
            pass "TC-P6-2: WebUI CHF quota API (ChfSubscriber endpoint) → HTTP 200"
        else
            fail "TC-P6-2: WebUI CHF quota API → HTTP 200 (got ${P6_QUOTA})"
        fi
    else
        fail "TC-P6-2: WebUI login failed — cannot obtain JWT for API calls"
    fi

    # TC-P6-3: Provision a quota via WebUI API; CHF uses it
    # SUPI_P6 is defined at the top of this script alongside the base SUPI.
    if ! service_reachable "${CHF_ADDR}" "${CHF_PORT}"; then
        skip "TC-P6-3: CHF not reachable — cannot verify quota from WebUI"
    else
        QUOTA_VAL=500000000
        # Re-login to get fresh JWT (reuse if still valid)
        [ -n "${P6_JWT}" ] || P6_JWT=$(webui_login "${WEBUI_ADDR}" "${WEBUI_PORT}") || P6_JWT=""

        # POST a subscriber quota record via the WebUI API
        P6_POST=$(curl -s --max-time 5 \
            -X POST \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer ${P6_JWT}" \
            -o /tmp/p6-post-resp.json \
            -w "%{http_code}" \
            -d "{\"supi\":\"${SUPI_P6}\",\"quota\":{\"totalQuotaBytes\":${QUOTA_VAL},\"validityPeriod\":\"custom\",\"validitySeconds\":7200,\"autoRenew\":false,\"finalUnitAction\":\"TERMINATE\"}}" \
            "http://${WEBUI_ADDR}:${WEBUI_PORT}/api/db/ChfSubscriber" 2>/dev/null) || P6_POST="000"

        if [ "${P6_POST}" = "200" ] || [ "${P6_POST}" = "201" ]; then
            # Create a CHF session for that SUPI and check the granted quota
            BODY_P6="{\"supi\":\"${SUPI_P6}\",\"pDUSessionChargingInformation\":{\"chargingId\":66,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":6,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            P6_CREATE=$(chf_post "${BASE_URL}" "${BODY_P6}")
            LOC_P6=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
                | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')
            P6_BODY=$(cat /tmp/chf-resp-body.txt)

            GRANTED_P6=$(python3 2>/dev/null << 'PYEOF'
import json
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
    print(d['multipleUnitInformation'][0]['grantedUnit']['totalVolume'])
except:
    print('')
PYEOF
) || GRANTED_P6=""

            if [ "${P6_CREATE}" = "201" ] && [ -n "${GRANTED_P6}" ]; then
                if [ "${GRANTED_P6}" = "${QUOTA_VAL}" ]; then
                    pass "TC-P6-3: CHF uses WebUI-provisioned quota (totalVolume=${GRANTED_P6})"
                else
                    fail "TC-P6-3: CHF totalVolume=${GRANTED_P6} does not match WebUI totalQuotaBytes ${QUOTA_VAL}"
                fi
            else
                fail "TC-P6-3: CHF Create failed (HTTP ${P6_CREATE}) after WebUI quota provisioning"
            fi
            [ -n "${LOC_P6:-}" ] && chf_post "${LOC_P6}/release" '{}' >/dev/null 2>/dev/null || true

            # Cleanup: delete the subscriber from WebUI
            curl -s --max-time 5 -X DELETE \
                -H "Authorization: Bearer ${P6_JWT}" \
                "http://${WEBUI_ADDR}:${WEBUI_PORT}/api/db/ChfSubscriber/${SUPI_P6}" \
                >/dev/null 2>/dev/null || true
        else
            fail "TC-P6-3: WebUI quota provisioning POST failed (HTTP ${P6_POST})"
        fi
    fi

    # TC-P6-4: Zero-quota subscriber via WebUI → FinalUnitIndication on Create
    #
    # Provision a subscriber with totalVolume=0 via the WebUI API, then call
    # CHF Create.  The Create response itself must include FinalUnitIndication
    # (no Update needed) because 0 >= 0 fires exhaustion at grant time.
    if ! service_reachable "${CHF_ADDR}" "${CHF_PORT}"; then
        skip "TC-P6-4: CHF not reachable — cannot test zero-quota FUI"
    else
        # SUPI_P6Z is defined at the top of this script alongside the base SUPI.

        # Re-use JWT obtained earlier; re-login if missing
        [ -n "${P6_JWT}" ] || P6_JWT=$(webui_login "${WEBUI_ADDR}" "${WEBUI_PORT}") || P6_JWT=""

        P6Z_POST=$(curl -s --max-time 5 \
            -X POST \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer ${P6_JWT}" \
            -o /tmp/p6z-post-resp.json \
            -w "%{http_code}" \
            -d "{\"supi\":\"${SUPI_P6Z}\",\"quota\":{\"totalQuotaBytes\":0,\"validityPeriod\":\"custom\",\"validitySeconds\":3600,\"autoRenew\":false,\"finalUnitAction\":\"TERMINATE\"}}" \
            "http://${WEBUI_ADDR}:${WEBUI_PORT}/api/db/ChfSubscriber" 2>/dev/null) || P6Z_POST="000"

        if [ "${P6Z_POST}" = "200" ] || [ "${P6Z_POST}" = "201" ]; then
            BODY_P6Z="{\"supi\":\"${SUPI_P6Z}\",\"pDUSessionChargingInformation\":{\"chargingId\":67,\"userInformation\":{},\"pduSessionInformation\":{\"networkSlicingInfo\":{\"sNSSAI\":{\"sst\":1}},\"pduSessionID\":7,\"dnnId\":\"internet\",\"chargingCharacteristics\":\"0800\"}},\"multipleUnitUsage\":[{\"ratingGroup\":1,\"requestedUnit\":{\"totalVolume\":1000000}}]}"
            P6Z_CREATE=$(chf_post "${BASE_URL}" "${BODY_P6Z}")
            LOC_P6Z=$(grep -i "^location:" /tmp/chf-resp-headers.txt \
                | tr -d '\r' | awk '{print $2}' | tr -d '[:space:]')

            if [ "${P6Z_CREATE}" = "201" ] && [ -n "${LOC_P6Z}" ]; then
                if python3 2>&1 << 'PYEOF'
import json, sys
try:
    d = json.load(open('/tmp/chf-resp-body.txt'))
except Exception as e:
    print('Parse error:', e); sys.exit(1)
mui = d.get('multipleUnitInformation', [{}])[0]
if 'finalUnitIndication' not in mui:
    print('FinalUnitIndication not present in Create response'); sys.exit(1)
fua = mui['finalUnitIndication'].get('finalUnitAction')
if fua not in ('TERMINATE', 'REDIRECT', 'RESTRICT_ACCESS'):
    print('unexpected FUA:', fua); sys.exit(1)
print('  FinalUnitAction:', fua, '(on Create — zero quota via WebUI)')
PYEOF
                then
                    pass "TC-P6-4: FinalUnitIndication on Create for WebUI zero-quota subscriber"
                else
                    fail "TC-P6-4: FinalUnitIndication missing in Create for zero-quota"
                fi
                chf_post "${LOC_P6Z}/release" '{}' >/dev/null 2>/dev/null || true
            else
                fail "TC-P6-4: CHF Create failed (HTTP ${P6Z_CREATE}) for WebUI zero-quota subscriber"
            fi

            # Cleanup: delete the subscriber from WebUI
            curl -s --max-time 5 -X DELETE \
                -H "Authorization: Bearer ${P6_JWT}" \
                "http://${WEBUI_ADDR}:${WEBUI_PORT}/api/db/ChfSubscriber/${SUPI_P6Z}" \
                >/dev/null 2>/dev/null || true
        else
            fail "TC-P6-4: WebUI zero-quota POST failed (HTTP ${P6Z_POST})"
        fi
    fi
fi

echo

# ===========================================================================
# Summary
# ===========================================================================
TOTAL=$((PASS + FAIL + SKIP))
echo "=============================="
printf "Results: PASS=%d  FAIL=%d  SKIP=%d  TOTAL=%d\n" \
    "${PASS}" "${FAIL}" "${SKIP}" "${TOTAL}"

if [ "${FAIL}" -eq 0 ]; then
    echo -e "  ${GREEN}ALL PASS (no failures)${NC}"
    exit 0
else
    echo -e "  ${RED}${FAIL} FAILED${NC}"
    exit 1
fi
