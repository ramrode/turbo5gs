/*
 * ChargingNotify queue — what the billing side wants a live session to hear
 * now rather than at its next usage report.
 *
 * Collection: chf.notifications.  The CHF NF polls it (see
 * src/chf/notify-path.c), turns each row into a TS 32.291
 * ChargingNotifyRequest to every session drawing from the bucket, and
 * deletes the row.
 *
 * A queue rather than a call: the WebUI does not speak Nchf and the CHF has
 * no inbound admin endpoint, MongoDB change streams need a replica set, and
 * a row written while the CHF is down is still delivered when it returns.
 *
 * Nothing here is read back by the WebUI, so the documents are write-only
 * from this side; the CHF deletes them by their ObjectId.
 *
 * Copyright (C) 2026 by Rami Mohamed <ramrode@gmail.com>
 */

'use strict';

const mongoose = require('mongoose');

const Notification = new mongoose.Schema(
  {
    /* Unique per row, so a repeat is a new notification rather than an
     * overwrite.  The CHF deletes by ObjectId and never reads this; it is
     * here so one row can be told from another. */
    id: { type: String, required: true, unique: true },
    /* Whose sessions to reach. */
    supi: { type: String, required: true, index: true },
    /* Which of that subscriber's buckets; absent means all of them. */
    bucketId: String,
    /* REAUTHORIZATION: report now and take a fresh grant.
     * ABORT_CHARGING: this session may not continue. */
    type: {
      type: String,
      required: true,
      enum: ['REAUTHORIZATION', 'ABORT_CHARGING'],
    },
    /* Free text, logged by the CHF: 'topup', 'plan-change', ... */
    reason: String,
    createdAt: { type: Date, default: Date.now },
  },
  {
    collection: 'chf.notifications',
    id: false,
    versionKey: false,
  }
);

module.exports = mongoose.model('ChfNotification', Notification);
