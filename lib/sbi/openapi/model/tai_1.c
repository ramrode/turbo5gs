
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "tai_1.h"

OpenAPI_tai_1_t *OpenAPI_tai_1_create(
    char *mcc,
    char *mnc,
    char *tac
)
{
    OpenAPI_tai_1_t *tai_1_local_var = ogs_malloc(sizeof(OpenAPI_tai_1_t));
    ogs_assert(tai_1_local_var);

    tai_1_local_var->mcc = mcc;
    tai_1_local_var->mnc = mnc;
    tai_1_local_var->tac = tac;

    return tai_1_local_var;
}

void OpenAPI_tai_1_free(OpenAPI_tai_1_t *tai_1)
{
    OpenAPI_lnode_t *node = NULL;

    if (NULL == tai_1) {
        return;
    }
    if (tai_1->mcc) {
        ogs_free(tai_1->mcc);
        tai_1->mcc = NULL;
    }
    if (tai_1->mnc) {
        ogs_free(tai_1->mnc);
        tai_1->mnc = NULL;
    }
    if (tai_1->tac) {
        ogs_free(tai_1->tac);
        tai_1->tac = NULL;
    }
    ogs_free(tai_1);
}

cJSON *OpenAPI_tai_1_convertToJSON(OpenAPI_tai_1_t *tai_1)
{
    cJSON *item = NULL;
    OpenAPI_lnode_t *node = NULL;

    if (tai_1 == NULL) {
        ogs_error("OpenAPI_tai_1_convertToJSON() failed [Tai_1]");
        return NULL;
    }

    item = cJSON_CreateObject();
    if (tai_1->mcc) {
    if (cJSON_AddStringToObject(item, "mcc", tai_1->mcc) == NULL) {
        ogs_error("OpenAPI_tai_1_convertToJSON() failed [mcc]");
        goto end;
    }
    }

    if (tai_1->mnc) {
    if (cJSON_AddStringToObject(item, "mnc", tai_1->mnc) == NULL) {
        ogs_error("OpenAPI_tai_1_convertToJSON() failed [mnc]");
        goto end;
    }
    }

    if (tai_1->tac) {
    if (cJSON_AddStringToObject(item, "tac", tai_1->tac) == NULL) {
        ogs_error("OpenAPI_tai_1_convertToJSON() failed [tac]");
        goto end;
    }
    }

end:
    return item;
}

OpenAPI_tai_1_t *OpenAPI_tai_1_parseFromJSON(cJSON *tai_1JSON)
{
    OpenAPI_tai_1_t *tai_1_local_var = NULL;
    OpenAPI_lnode_t *node = NULL;
    cJSON *mcc = NULL;
    cJSON *mnc = NULL;
    cJSON *tac = NULL;
    mcc = cJSON_GetObjectItemCaseSensitive(tai_1JSON, "mcc");
    if (mcc) {
    if (!cJSON_IsString(mcc) && !cJSON_IsNull(mcc)) {
        ogs_error("OpenAPI_tai_1_parseFromJSON() failed [mcc]");
        goto end;
    }
    }

    mnc = cJSON_GetObjectItemCaseSensitive(tai_1JSON, "mnc");
    if (mnc) {
    if (!cJSON_IsString(mnc) && !cJSON_IsNull(mnc)) {
        ogs_error("OpenAPI_tai_1_parseFromJSON() failed [mnc]");
        goto end;
    }
    }

    tac = cJSON_GetObjectItemCaseSensitive(tai_1JSON, "tac");
    if (tac) {
    if (!cJSON_IsString(tac) && !cJSON_IsNull(tac)) {
        ogs_error("OpenAPI_tai_1_parseFromJSON() failed [tac]");
        goto end;
    }
    }

    tai_1_local_var = OpenAPI_tai_1_create (
        mcc && !cJSON_IsNull(mcc) ? ogs_strdup(mcc->valuestring) : NULL,
        mnc && !cJSON_IsNull(mnc) ? ogs_strdup(mnc->valuestring) : NULL,
        tac && !cJSON_IsNull(tac) ? ogs_strdup(tac->valuestring) : NULL
    );

    return tai_1_local_var;
end:
    return NULL;
}

OpenAPI_tai_1_t *OpenAPI_tai_1_copy(OpenAPI_tai_1_t *dst, OpenAPI_tai_1_t *src)
{
    cJSON *item = NULL;
    char *content = NULL;

    ogs_assert(src);
    item = OpenAPI_tai_1_convertToJSON(src);
    if (!item) {
        ogs_error("OpenAPI_tai_1_convertToJSON() failed");
        return NULL;
    }

    content = cJSON_Print(item);
    cJSON_Delete(item);

    if (!content) {
        ogs_error("cJSON_Print() failed");
        return NULL;
    }

    item = cJSON_Parse(content);
    ogs_free(content);
    if (!item) {
        ogs_error("cJSON_Parse() failed");
        return NULL;
    }

    OpenAPI_tai_1_free(dst);
    dst = OpenAPI_tai_1_parseFromJSON(item);
    cJSON_Delete(item);

    return dst;
}

