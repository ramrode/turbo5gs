/*
 * CHF subscriber quota profile.
 *
 * Collection: open5gs.chf.subscribers  (same DB as the rest of Open5GS)
 *
 * Quota model (unified total):
 *   totalQuotaBytes  — single total (UL+DL) data allowance in bytes.
 *                       CHF grants grantedUnit.totalVolume so the UPF
 *                       deducts BOTH UL and DL octets from one counter,
 *                       ensuring UL+DL never exceeds the configured limit.
 *
 *   validityPeriod   — billing cycle length: 'daily' | 'weekly' | 'monthly'
 *                       | 'custom'.  The WebUI converts this to validitySeconds
 *                       before persisting; the C layer reads validitySeconds.
 *
 *   validitySeconds  — canonical period length in seconds (authoritative for C).
 *                       Auto-populated from validityPeriod when not 'custom'.
 *
 *   autoRenew        — when true the CHF resets accumulated usage and re-grants
 *                       the full quota at the start of each new period.
 *                       When false the session is terminated (FUI) on expiry.
 *
 *   finalUnitAction  — action when quota is VOLUME-exhausted mid-period.
 *                       TS 32.291 §7.3: TERMINATE | REDIRECT | RESTRICT_ACCESS.
 *
 * 3GPP references:
 *   TS 23.255 §5.2   — CHF subscriber management
 *   TS 32.291 §6.3.1 — ChargingDataRequest: grantedUnit drives the quota
 *   TS 32.291 §6.3.2.2 — TIME_LIMIT / VOLUME_LIMIT triggers
 *   TS 32.291 §7.3   — FinalUnitIndication actions
 *
 * Copyright (C) 2026 by Rami Mohamed <ramrode@gmail.com>
 */

'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ChfSubscriber = new Schema(
  {
    /*
     * SUPI — Subscription Permanent Identifier (TS 23.003 §2.2B).
     * Format: "imsi-<15-digit IMSI>"  e.g. "imsi-001010000000001"
     * Also accepts full 5G SUPI with IMSI type indicator.
     */
    /*
     * Bucket id.  A subscriber's catch-all bucket - the one with no scope,
     * which is what a plain per-SUPI plan is - uses the SUPI itself, so
     * everything written before buckets existed keeps working and keeps
     * its URL.  A scoped bucket gets a generated id.
     */
    bucketId: {
      $type: String,
      unique: true,
      sparse: true,
      index: true
    },

    /*
     * What this bucket applies to.  An absent member is open and matches
     * anything; a bucket with no scope at all is the catch-all.  The CHF
     * reads these in src/chf/db-handler.c and matches them against the
     * ChargingDataRequest (TS 32.291): the slice from
     * networkSlicingInfo.sNSSAI, the DNN from dnnId, the home network from
     * hPlmnId and roaming from userInformation.roamerInOut.
     */
    scope: {
      snssai: {
        sst: { $type: Number, min: 0, max: 255 },
        sd:  { $type: String, match: /^[0-9a-fA-F]{6}$/ }
      },
      dnn:     { $type: String },
      hplmn:   { $type: String, match: /^\d{3}-\d{2,3}$/ },
      roaming: { $type: String, enum: ['home', 'inBound', 'outBound'] }
    },

    /*
     * Which bucket wins when several cover one session: highest first.
     * Equal numbers keep the older bucket.
     */
    priority: { $type: Number, default: 0 },

    supi: {
      $type: String,
      index: true,
      required: true,
      /*
       * TS 23.003 §2.2B: IMSI is exactly 15 digits.
       * The Edit.js form enforces the same '^imsi-\\d{15}$' pattern.
       */
      match: /^imsi-\d{15}$/
    },

    /*
     * Per-SUPI quota profile applied to every 5GC PDU session.
     * The CHF NF reads this on Create and issues grantedUnit accordingly.
     */
    quota: {
      /*
       * Total data allowance in bytes (UL + DL combined).
       * The CHF grants this as grantedUnit.totalVolume; the UPF deducts
       * both uplink and downlink bytes from a single counter so the
       * subscriber can never consume more than this value in total.
       * Default: 10 GiB (10 × 1 073 741 824 bytes).
       */
      totalQuotaBytes: { $type: Number, default: 10737418240 },

      /*
       * Billing cycle: how long one grant period lasts.
       *   'daily'   →  86 400 s  (24 hours)
       *   'weekly'  → 604 800 s  (7 days)
       *   'monthly' → 2 592 000 s (30 days)
       *   'custom'  → validitySeconds below
       * The WebUI converts this enum to validitySeconds before saving.
       */
      validityPeriod: {
        $type: String,
        enum: ['daily', 'weekly', 'monthly', 'custom'],
        default: 'monthly'
      },

      /*
       * Period length in seconds — authoritative value read by the C layer.
       * Auto-derived from validityPeriod by the WebUI; editable for 'custom'.
       * Default 2 592 000 s = 30-day month.
       */
      validitySeconds: { $type: Number, default: 2592000 },

      /*
       * Auto-renew on period expiry.
       *   true  — on period expiry the CHF resets the per-session usage
       *           counters and re-grants the full totalQuotaBytes for the
       *           next period.  The subscriber gets a recurring allowance.
       *   false — on period expiry the session is terminated (FUI TERMINATE
       *           or whatever finalUnitAction is set to).  No renewal.
       */
      autoRenew: { $type: Boolean, default: true },

      /*
       * Action when the volume quota is exhausted BEFORE the period expires.
       * TS 32.291 §7.3:
       *   TERMINATE        — terminate the PDU session (default, safest)
       *   REDIRECT         — redirect traffic to a captive portal
       *   RESTRICT_ACCESS  — allow only a restricted service set
       */
      finalUnitAction: {
        $type: String,
        enum: ['TERMINATE', 'REDIRECT', 'RESTRICT_ACCESS'],
        default: 'TERMINATE'
      }
    },

    /*
     * Billing-cycle usage counter.
     *
     * Written exclusively by the CHF NF (src/chf/db-handler.c): every UL+DL
     * delta the SMF reports is added with an atomic $inc, and the pair is
     * reset when a new cycle opens.  Because it lives on the subscriber
     * rather than the session, it survives session teardown — which is what
     * makes "remaining this cycle" meaningful across reconnects.
     *
     * The WebUI only READS these fields; they are not part of the edit form.
     */
    /*
     * TMF666 billing account this bucket is charged to (TMF654
     * Bucket.partyAccount).  Optional; not read by the CHF.
     */
    billingAccountId: { $type: String, index: true },

    usage: {
      /* Start of the current billing cycle. */
      periodStart:   { $type: Date },

      /* Cumulative UL+DL bytes consumed since periodStart, all sessions. */
      consumedBytes: { $type: Number, default: 0 },

      /* Top-ups bought for this cycle via TMF654 topupBalance; the CHF
       * zeroes them when it opens a new cycle. */
      topupBytes:    { $type: Number, default: 0 },

      /* Last time the CHF touched the counter. */
      updatedAt:     { $type: Date }
    }
  },
  {
    /* Use $type instead of type to avoid conflict with Mongoose reserved key */
    typeKey: '$type',

    /* Map to the CHF subscribers collection, not the default "chfsubscribers" */
    collection: 'chf.subscribers'
  }
);

module.exports = mongoose.model('ChfSubscriber', ChfSubscriber);
