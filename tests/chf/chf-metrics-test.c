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
 * The metric tables, and the contract the rest of the tests rely on.
 *
 * These do not read metric values — that needs a running metrics context,
 * a Prometheus exporter and a scrape, which is the rig's job. What they
 * check is the part that silently rots:
 *
 *   - Both spec tables are sized by their enum's _MAX and filled with
 *     designated initialisers, so adding a metric to an enum and
 *     forgetting its spec leaves a zeroed entry whose name is NULL.
 *     chf_metrics_init_spec() passes that straight to
 *     ogs_metrics_spec_new(), so the mistake reaches the exporter rather
 *     than the compiler.
 *
 *   - Every other suite in this binary instruments code that calls
 *     chf_metrics_inst_*() without a metrics context. The header
 *     promises those are no-ops; if that ever stopped being true, every
 *     CDR and quota test would start crashing for a reason that has
 *     nothing to do with what they test. Worth one test of its own.
 *
 * Test IDs: METR-1 .. METR-4
 */

#include "ogs-sbi.h"
#include "chf/context.h"
#include "chf/metrics.h"
#include "core/abts.h"

/* ------------------------------------------------------------------ */
/* METR-1: every metric spec is complete                               */
/* ------------------------------------------------------------------ */
static void test_metrics_specs_complete(abts_case *tc, void *data)
{
    /*
     * Zero is the only acceptable answer. A non-zero count means some
     * metric in chf_metric_global_t or chf_metric_labeled_t has no spec,
     * no description, or a label count the instance key cannot hold —
     * chf_metrics_spec_defects() logs which.
     */
    ABTS_INT_EQUAL(tc, 0, chf_metrics_spec_defects());
}

/* ------------------------------------------------------------------ */
/* METR-2: the enums are non-empty and within the key's capacity       */
/* ------------------------------------------------------------------ */
static void test_metrics_enum_bounds(abts_case *tc, void *data)
{
    ABTS_TRUE(tc, _CHF_METR_GLOB_MAX > 0);
    ABTS_TRUE(tc, _CHF_METR_LBL_MAX > 0);

    /* A labeled metric may carry at most CHF_METR_MAX_LABELS labels, and
     * the instance key is sized for exactly that. */
    ABTS_TRUE(tc, CHF_METR_MAX_LABELS >= 1);
    ABTS_TRUE(tc, CHF_METR_LABEL_LEN > 1);

    /* The series cap is what stops an unbounded label value from growing
     * the hash without limit. */
    ABTS_TRUE(tc, CHF_METR_MAX_LABELED_INSTANCES > 0);
}

/* ------------------------------------------------------------------ */
/* METR-3: instrumentation is a no-op before the context exists        */
/*                                                                      */
/* This is the contract every other suite here depends on.  None of     */
/* them starts a metrics context, yet all of them run code that         */
/* instruments.                                                         */
/* ------------------------------------------------------------------ */
static void test_metrics_noop_without_context(abts_case *tc, void *data)
{
    /* Global: set, add, inc, dec. */
    chf_metrics_inst_global_set(CHF_METR_GAUGE_SESSIONS_ACTIVE, 7);
    chf_metrics_inst_global_add(CHF_METR_CTR_CDR_BYTES, 1234);
    chf_metrics_inst_global_inc(CHF_METR_CTR_NOTIFY_SENT);
    chf_metrics_inst_global_dec(CHF_METR_GAUGE_SESSIONS_ACTIVE);

    /* Labeled, including the metrics added for slicing and the two CDR
     * encodings. */
    chf_metrics_inst_labeled_inc(CHF_METR_LBL_CDR_WRITTEN,
            "success", NULL, NULL);
    chf_metrics_inst_labeled_inc(CHF_METR_LBL_CDR_ENCODED,
            "asn1", "success", NULL);
    chf_metrics_inst_labeled_inc(CHF_METR_LBL_CDR_FILE_ROLLED,
            "json", "records", NULL);
    chf_metrics_inst_labeled_inc(CHF_METR_LBL_BUCKET_SELECTED,
            "scoped", "1/000001", NULL);

    /* Reaching here without a crash is the assertion. */
    ABTS_TRUE(tc, true);
}

/* ------------------------------------------------------------------ */
/* METR-4: an over-long label value is tolerated on this path          */
/*                                                                      */
/* dnn and smf label values come off the wire, so an over-long one is   */
/* reachable from a peer rather than only from our own code.            */
/*                                                                      */
/* What this proves is narrow, and worth stating: without a metrics     */
/* context chf_metrics_inst_labeled_add() returns before it copies      */
/* anything, so this shows the uninitialised path is safe for any       */
/* input, not that truncation works.  Truncation is by construction —   */
/* the copy is an ogs_cpystrn() bounded by CHF_METR_LABEL_LEN — and     */
/* exercising it needs a live metrics context, which is the rig's job.  */
/* ------------------------------------------------------------------ */
static void test_metrics_overlong_label(abts_case *tc, void *data)
{
    char huge[CHF_METR_LABEL_LEN * 3];

    memset(huge, 'x', sizeof(huge) - 1);
    huge[sizeof(huge) - 1] = '\0';

    chf_metrics_inst_labeled_inc(CHF_METR_LBL_BUCKET_SELECTED,
            "scoped", huge, NULL);
    chf_metrics_inst_labeled_inc(CHF_METR_LBL_SESSION_CREATE,
            "success", huge, huge);

    ABTS_TRUE(tc, true);
}

abts_suite *test_chf_metrics(abts_suite *suite)
{
    suite = ADD_SUITE(suite)

    abts_run_test(suite, test_metrics_specs_complete,      NULL);
    abts_run_test(suite, test_metrics_enum_bounds,         NULL);
    abts_run_test(suite, test_metrics_noop_without_context, NULL);
    abts_run_test(suite, test_metrics_overlong_label,      NULL);

    return suite;
}
