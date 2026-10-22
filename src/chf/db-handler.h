/*
 * Copyright (C) 2026 by Rami Mohamed <ramrode@gmail.com>
 *
 * This file is part of Open5GS.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * CHF MongoDB data-access layer.
 *
 * Collections (all in the same database as the rest of Open5GS):
 *   chf.subscribers  — per-SUPI quota profiles
 *   chf.sessions     — active charging session records
 *   chf.cdrs         — CDR index entries (file path + metadata)
 *
 * 3GPP ref: TS 23.255 §6 — CHF interaction with OCS/data stores
 */

#ifndef CHF_DB_HANDLER_H
#define CHF_DB_HANDLER_H

#include "context.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ */
/* Lifecycle — call after ogs_dbi_init() / before ogs_dbi_final()     */
/* ------------------------------------------------------------------ */

/* Open the three CHF-specific collections.
 * Returns OGS_OK on success, OGS_ERROR if MongoDB is not available. */
int  chf_db_init(void);

/* Destroy collection handles. */
void chf_db_final(void);

/* ------------------------------------------------------------------ */
/* Subscriber quota                                                     */
/* TS 32.291 §6.3.1.2 — quota lookup on Create                        */
/* ------------------------------------------------------------------ */

/* Look up subscriber quota from chf.subscribers by SUPI.
 * On success *quota is filled from the DB document.
 * Returns OGS_OK if found, OGS_RETRY if the SUPI is not provisioned, and
 * OGS_ERROR if MongoDB could not be read - which says nothing about whether
 * the SUPI is provisioned.
 *
 * DB document shape:
 *   { supi, quota: { volume_bytes, validity_seconds, final_unit_action } }
 */


/* ------------------------------------------------------------------ */
/* Session CRUD                                                         */
/* TS 23.255 §6 — session lifecycle in MongoDB                         */
/* ------------------------------------------------------------------ */

/* Insert a new session document in chf.sessions.
 * Called immediately after chf_sess_add() on Create.
 *
 * Document shape:
 *   { charging_data_ref, supi, gpsi, dnn, psi,
 *     ul_octets, dl_octets, duration,
 *     granted_quota_total,
 *     created_at, updated_at }
 */
/*
 * Billing-cycle usage counter on chf.subscribers.usage.
 *
 * chf_db_add_usage() adds a reported UL+DL delta with an atomic $inc, so
 * concurrent sessions for one SUPI cannot lose an update.  It returns
 * OGS_RETRY when the SUPI is not provisioned (no document matched) or the
 * collection is unavailable — the caller then falls back to per-session
 * accounting.
 *
 * chf_db_start_usage_period() zeroes the counter and stamps periodStart to
 * now, opening a cycle on the subscriber's first session and on auto-renew.
 *
 * chf_db_open_usage_period() stamps periodStart only when no cycle is open,
 * keeping the counter.  It is for a session that started before its SUPI
 * was provisioned: its usage since then is already counted.
 */
int chf_db_add_usage(const char *bucket_id, uint64_t delta_bytes);
int chf_db_start_usage_period(const char *bucket_id);
int chf_db_open_usage_period(const char *bucket_id);

/*
 * Buckets (see chf_bucket_t in context.h).
 *
 * chf_db_load_buckets() returns every bucket a SUPI holds, oldest first,
 * or OGS_ERROR when MongoDB could not be read.  chf_db_get_bucket_quota()
 * re-reads one bucket by id: OGS_OK, OGS_RETRY when it is gone, or
 * OGS_ERROR on a read failure.
 */
int chf_db_load_buckets(const char *supi, chf_bucket_t *buckets, int max);
int chf_db_get_bucket_quota(const char *bucket_id, chf_quota_t *quota);

/*
 * Notification queue (chf.notifications).
 *
 * Nothing but the CHF talks Nchf, so a top-up or a bar applied through the
 * TMF API cannot reach a live session by itself.  The billing side leaves a
 * row here instead and the CHF picks it up on its poll timer, which keeps
 * the two apart: no inbound admin endpoint on the CHF, no MongoDB change
 * stream (which needs a replica set), and a queue that survives a CHF that
 * is down when the top-up lands.
 *
 * Document shape, written by webui/server/tmf:
 *   { _id, supi, bucketId, type: "REAUTHORIZATION"|"ABORT_CHARGING",
 *     reason, createdAt }
 *
 * chf_db_read_notifications() reads up to max rows oldest first and returns
 * how many, 0 when there is nothing to do, or OGS_ERROR when MongoDB could
 * not be read.  chf_db_delete_notifications() removes the rows that have
 * been delivered - delivery is at-most-once, which is the right way round:
 * a notification only ever asks the SMF to report, and a missed one costs
 * at worst the delay the feature exists to remove.
 */
#define CHF_MAX_NOTIFY_BATCH 64

typedef struct chf_notification_s {
    char id[25];            /* ObjectId, 24 hex characters              */
    char supi[CHF_MAX_BUCKET_ID_LEN];
    char bucket_id[CHF_MAX_BUCKET_ID_LEN]; /* empty: any of the SUPI's  */
    char reason[32];        /* free text from the billing side, logged  */
    bool abort_charging;    /* else REAUTHORIZATION                     */
} chf_notification_t;

int chf_db_read_notifications(chf_notification_t *out, int max);
int chf_db_delete_notifications(const chf_notification_t *list, int count);

int chf_db_session_create(chf_sess_t *sess);

/* Update usage counters and timestamp in an existing chf.sessions document.
 * Called on every Update request after accumulating usage in sess.
 *
 * Sets: ul_octets, dl_octets, duration, updated_at
 */
int chf_db_session_update(chf_sess_t *sess);

/* Delete the session document from chf.sessions.
 * Called on Release before removing the in-memory chf_sess_t.
 */
int chf_db_session_delete(chf_sess_t *sess);

/* ------------------------------------------------------------------ */
/* CDR index                                                            */
/* TS 23.255 §7 — CDR record management                               */
/* ------------------------------------------------------------------ */

/* Insert a CDR index entry in chf.cdrs.
 * cdr_file_path is the absolute path of the JSON CDR file on disk.
 * Pass NULL if the CDR file has not been written yet (Phase 1e will use this).
 *
 * Document shape:
 *   { charging_data_ref, supi, file_path, created_at }
 */
int chf_db_cdr_insert(chf_sess_t *sess, const char *cdr_file_path);

#ifdef __cplusplus
}
#endif

#endif /* CHF_DB_HANDLER_H */
