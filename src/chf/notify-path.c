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
 * ChargingNotify sender — see notify-path.h for what this is for.
 *
 * JSON is built with cJSON, as everywhere else in the CHF: TS 32.291 has
 * no OpenAPI codegen in this tree.
 */

#include "notify-path.h"
#include "db-handler.h"
#include "metrics.h"

static ogs_timer_t *t_notify_poll = NULL;

/* ------------------------------------------------------------------ */
/* Delivery                                                             */
/* ------------------------------------------------------------------ */

/*
 * The SMF answers 204 No Content and then reports; anything else means the
 * change will not reach that session until its next report.  Nothing is
 * retried: the queue row is gone by now, and the notification only ever
 * asks for a report the session would make anyway, just later.
 */
static int notify_response_cb(
        int status, ogs_sbi_response_t *response, void *data)
{
    ogs_sbi_message_t message;
    int rv;

    if (status != OGS_OK) {
        ogs_warn("ChargingNotify was not delivered [%d]", status);
        chf_metrics_inst_global_inc(CHF_METR_CTR_NOTIFY_FAILED);
        return OGS_ERROR;
    }

    ogs_assert(response);

    rv = ogs_sbi_parse_response(&message, response);
    if (rv != OGS_OK) {
        ogs_error("ChargingNotify: cannot parse the SMF's response");
        chf_metrics_inst_global_inc(CHF_METR_CTR_NOTIFY_FAILED);
        ogs_sbi_message_free(&message);
        ogs_sbi_response_free(response);
        return OGS_ERROR;
    }

    if (message.res_status != OGS_SBI_HTTP_STATUS_NO_CONTENT &&
            message.res_status != OGS_SBI_HTTP_STATUS_OK) {
        ogs_warn("ChargingNotify refused by the SMF [status:%d]",
                message.res_status);
        chf_metrics_inst_global_inc(CHF_METR_CTR_NOTIFY_FAILED);
    }

    ogs_sbi_message_free(&message);
    ogs_sbi_response_free(response);
    return OGS_OK;
}

/*
 * ChargingNotifyRequest (TS 32.291 §6.3.4):
 *   {
 *     "notificationType": "REAUTHORIZATION" | "ABORT_CHARGING",
 *     "reauthorizationDetails": [{ "ratingGroup": <uint32> }]
 *   }
 *
 * reauthorizationDetails names what to re-authorise.  This CHF works one
 * rating group per session, so it names that one - which is what the SMF
 * reports against anyway.  It is meaningless for ABORT_CHARGING and left
 * out there.
 *
 * Filled into caller-owned storage; the caller then releases the list
 * with build_notify_finalize().
 */
struct chf_notify_storage {
    OpenAPI_charging_notify_request_t req;
    OpenAPI_reauthorization_details_t details;
    OpenAPI_list_t *details_list;
};

static OpenAPI_charging_notify_request_t *build_notify_request(
        chf_sess_t *sess, bool abort_charging,
        struct chf_notify_storage *st)
{
    ogs_assert(sess);
    ogs_assert(st);

    memset(st, 0, sizeof(*st));

    st->req.notification_type = abort_charging ?
        OpenAPI_charging_notification_type_ABORT_CHARGING :
        OpenAPI_charging_notification_type_REAUTHORIZATION;

    if (!abort_charging) {
        st->details.is_rating_group = true;
        st->details.rating_group = (int)sess->rating_group;

        st->details_list = OpenAPI_list_create();
        ogs_assert(st->details_list);
        OpenAPI_list_add(st->details_list, &st->details);
        st->req.reauthorization_details = st->details_list;
    }

    return &st->req;
}

static void build_notify_finalize(struct chf_notify_storage *st)
{
    ogs_assert(st);
    if (st->details_list) {
        OpenAPI_list_free(st->details_list);
        st->details_list = NULL;
    }
}

bool chf_notify_send(chf_sess_t *sess, bool abort_charging,
        const char *reason)
{
    ogs_sbi_client_t *client = NULL;
    ogs_sbi_message_t message;
    ogs_sbi_request_t *request = NULL;
    OpenAPI_uri_scheme_e scheme = OpenAPI_uri_scheme_NULL;
    char *fqdn = NULL;
    uint16_t fqdn_port = 0;
    ogs_sockaddr_t *addr = NULL, *addr6 = NULL;
    struct chf_notify_storage nst;
    bool rc = false;

    ogs_assert(sess);

    if (!sess->notify_uri) {
        ogs_debug("[%s] no notifyUri — this session can only be reached by "
                  "answering its reports [ref:%s]",
                sess->supi ? sess->supi : "?", sess->charging_data_ref);
        return false;
    }

    if (!ogs_sbi_getaddr_from_uri(&scheme, &fqdn, &fqdn_port,
                &addr, &addr6, sess->notify_uri) ||
            scheme == OpenAPI_uri_scheme_NULL) {
        ogs_error("[%s] notifyUri cannot be reached [%s]",
                sess->supi ? sess->supi : "?", sess->notify_uri);
        chf_metrics_inst_global_inc(CHF_METR_CTR_NOTIFY_FAILED);
        return false;
    }

    client = ogs_sbi_client_find(scheme, fqdn, fqdn_port, addr, addr6);
    if (!client) {
        client = ogs_sbi_client_add(scheme, fqdn, fqdn_port, addr, addr6);
        if (!client) {
            ogs_error("[%s] no client for notifyUri [%s]",
                    sess->supi ? sess->supi : "?", sess->notify_uri);
            chf_metrics_inst_global_inc(CHF_METR_CTR_NOTIFY_FAILED);
            goto end;
        }
    }

    memset(&message, 0, sizeof(message));
    message.h.method = (char *)OGS_SBI_HTTP_METHOD_POST;
    message.h.uri = sess->notify_uri;
    message.ChargingNotifyRequest =
        build_notify_request(sess, abort_charging, &nst);

    request = ogs_sbi_build_request(&message);
    build_notify_finalize(&nst);

    if (!request) {
        ogs_error("[%s] ogs_sbi_build_request() failed",
                sess->supi ? sess->supi : "?");
        chf_metrics_inst_global_inc(CHF_METR_CTR_NOTIFY_FAILED);
        goto end;
    }

    rc = ogs_sbi_send_request_to_client(
            client, notify_response_cb, request, NULL);
    if (rc) {
        /* Remember why this session is about to end, so its CDR says the
         * operator closed it rather than reading as an ordinary release. */
        if (abort_charging)
            sess->aborted = true;
        chf_metrics_inst_global_inc(CHF_METR_CTR_NOTIFY_SENT);
        ogs_info("[%s] ChargingNotify %s sent [ref:%s reason:%s]",
                sess->supi ? sess->supi : "?",
                abort_charging ? "ABORT_CHARGING" : "REAUTHORIZATION",
                sess->charging_data_ref, reason && *reason ? reason : "-");
    } else {
        chf_metrics_inst_global_inc(CHF_METR_CTR_NOTIFY_FAILED);
        ogs_error("[%s] ChargingNotify could not be sent [ref:%s]",
                sess->supi ? sess->supi : "?", sess->charging_data_ref);
    }

    ogs_sbi_request_free(request);

end:
    if (fqdn)
        ogs_free(fqdn);
    ogs_freeaddrinfo(addr);
    ogs_freeaddrinfo(addr6);

    return rc;
}

/* ------------------------------------------------------------------ */
/* Polling the queue                                                    */
/* ------------------------------------------------------------------ */

typedef struct {
    bool abort_charging;
    const char *reason;
    int sent;
} notify_fanout_t;

static void notify_one_session(chf_sess_t *sess, void *data)
{
    notify_fanout_t *fan = data;

    if (chf_notify_send(sess, fan->abort_charging, fan->reason))
        fan->sent++;
}

int chf_notify_poll(void)
{
    chf_notification_t queue[CHF_MAX_NOTIFY_BATCH];
    int count, i, sent = 0;

    count = chf_db_read_notifications(queue, CHF_MAX_NOTIFY_BATCH);
    if (count <= 0)
        return 0;   /* nothing queued, or MongoDB could not be read */

    for (i = 0; i < count; i++) {
        notify_fanout_t fan = {
            .abort_charging = queue[i].abort_charging,
            .reason = queue[i].reason,
            .sent = 0,
        };
        int matched;

        if (!queue[i].supi[0])
            continue;   /* already logged; deleted below with the rest */

        matched = chf_sess_foreach_by_bucket(queue[i].supi,
                queue[i].bucket_id, notify_one_session, &fan);

        if (matched == 0)
            /* Nothing to tell.  The subscriber has no session right now,
             * so the change is simply read at their next Create. */
            ogs_debug("[%s] queued %s has no live session [bucket:%s]",
                    queue[i].supi,
                    queue[i].abort_charging ? "ABORT_CHARGING"
                                            : "REAUTHORIZATION",
                    queue[i].bucket_id[0] ? queue[i].bucket_id : "any");

        sent += fan.sent;
    }

    /* Delivered or not, the rows go: see db-handler.h on at-most-once. */
    chf_db_delete_notifications(queue, count);

    return sent;
}

/* ------------------------------------------------------------------ */
/* The poll timer                                                       */
/* ------------------------------------------------------------------ */

static void notify_poll_cb(void *data)
{
    chf_notify_poll();
    ogs_timer_start(t_notify_poll,
            ogs_time_from_sec(chf_self()->notify.poll_seconds));
}

void chf_notify_init(void)
{
    if (!chf_self()->notify.enable) {
        ogs_info("CHF ChargingNotify: off — a top-up or a bar reaches a "
                 "session at its next report");
        return;
    }

    t_notify_poll = ogs_timer_add(ogs_app()->timer_mgr, notify_poll_cb, NULL);
    if (!t_notify_poll) {
        ogs_error("Cannot add the ChargingNotify poll timer");
        return;
    }

    ogs_timer_start(t_notify_poll,
            ogs_time_from_sec(chf_self()->notify.poll_seconds));

    ogs_info("CHF ChargingNotify: polling chf.notifications every %us",
            chf_self()->notify.poll_seconds);
}

void chf_notify_final(void)
{
    if (t_notify_poll) {
        ogs_timer_delete(t_notify_poll);
        t_notify_poll = NULL;
    }
}
