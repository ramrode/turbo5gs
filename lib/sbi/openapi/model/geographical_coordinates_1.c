
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "geographical_coordinates_1.h"

OpenAPI_geographical_coordinates_1_t *OpenAPI_geographical_coordinates_1_create(
    double lon,
    double lat
)
{
    OpenAPI_geographical_coordinates_1_t *geographical_coordinates_1_local_var = ogs_malloc(sizeof(OpenAPI_geographical_coordinates_1_t));
    ogs_assert(geographical_coordinates_1_local_var);

    geographical_coordinates_1_local_var->lon = lon;
    geographical_coordinates_1_local_var->lat = lat;

    return geographical_coordinates_1_local_var;
}

void OpenAPI_geographical_coordinates_1_free(OpenAPI_geographical_coordinates_1_t *geographical_coordinates_1)
{
    OpenAPI_lnode_t *node = NULL;

    if (NULL == geographical_coordinates_1) {
        return;
    }
    ogs_free(geographical_coordinates_1);
}

cJSON *OpenAPI_geographical_coordinates_1_convertToJSON(OpenAPI_geographical_coordinates_1_t *geographical_coordinates_1)
{
    cJSON *item = NULL;
    OpenAPI_lnode_t *node = NULL;

    if (geographical_coordinates_1 == NULL) {
        ogs_error("OpenAPI_geographical_coordinates_1_convertToJSON() failed [GeographicalCoordinates_1]");
        return NULL;
    }

    item = cJSON_CreateObject();
    if (cJSON_AddNumberToObject(item, "lon", geographical_coordinates_1->lon) == NULL) {
        ogs_error("OpenAPI_geographical_coordinates_1_convertToJSON() failed [lon]");
        goto end;
    }

    if (cJSON_AddNumberToObject(item, "lat", geographical_coordinates_1->lat) == NULL) {
        ogs_error("OpenAPI_geographical_coordinates_1_convertToJSON() failed [lat]");
        goto end;
    }

end:
    return item;
}

OpenAPI_geographical_coordinates_1_t *OpenAPI_geographical_coordinates_1_parseFromJSON(cJSON *geographical_coordinates_1JSON)
{
    OpenAPI_geographical_coordinates_1_t *geographical_coordinates_1_local_var = NULL;
    OpenAPI_lnode_t *node = NULL;
    cJSON *lon = NULL;
    cJSON *lat = NULL;
    lon = cJSON_GetObjectItemCaseSensitive(geographical_coordinates_1JSON, "lon");
    if (!lon) {
        ogs_error("OpenAPI_geographical_coordinates_1_parseFromJSON() failed [lon]");
        goto end;
    }
    if (!cJSON_IsNumber(lon)) {
        ogs_error("OpenAPI_geographical_coordinates_1_parseFromJSON() failed [lon]");
        goto end;
    }

    lat = cJSON_GetObjectItemCaseSensitive(geographical_coordinates_1JSON, "lat");
    if (!lat) {
        ogs_error("OpenAPI_geographical_coordinates_1_parseFromJSON() failed [lat]");
        goto end;
    }
    if (!cJSON_IsNumber(lat)) {
        ogs_error("OpenAPI_geographical_coordinates_1_parseFromJSON() failed [lat]");
        goto end;
    }

    geographical_coordinates_1_local_var = OpenAPI_geographical_coordinates_1_create (
        
        lon->valuedouble,
        
        lat->valuedouble
    );

    return geographical_coordinates_1_local_var;
end:
    return NULL;
}

OpenAPI_geographical_coordinates_1_t *OpenAPI_geographical_coordinates_1_copy(OpenAPI_geographical_coordinates_1_t *dst, OpenAPI_geographical_coordinates_1_t *src)
{
    cJSON *item = NULL;
    char *content = NULL;

    ogs_assert(src);
    item = OpenAPI_geographical_coordinates_1_convertToJSON(src);
    if (!item) {
        ogs_error("OpenAPI_geographical_coordinates_1_convertToJSON() failed");
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

    OpenAPI_geographical_coordinates_1_free(dst);
    dst = OpenAPI_geographical_coordinates_1_parseFromJSON(item);
    cJSON_Delete(item);

    return dst;
}

