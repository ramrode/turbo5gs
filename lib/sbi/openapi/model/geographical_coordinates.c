
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "geographical_coordinates.h"

OpenAPI_geographical_coordinates_t *OpenAPI_geographical_coordinates_create(
    bool is_latitude,
    int latitude,
    bool is_longitude,
    int longitude
)
{
    OpenAPI_geographical_coordinates_t *geographical_coordinates_local_var = ogs_malloc(sizeof(OpenAPI_geographical_coordinates_t));
    ogs_assert(geographical_coordinates_local_var);

    geographical_coordinates_local_var->is_latitude = is_latitude;
    geographical_coordinates_local_var->latitude = latitude;
    geographical_coordinates_local_var->is_longitude = is_longitude;
    geographical_coordinates_local_var->longitude = longitude;

    return geographical_coordinates_local_var;
}

void OpenAPI_geographical_coordinates_free(OpenAPI_geographical_coordinates_t *geographical_coordinates)
{
    OpenAPI_lnode_t *node = NULL;

    if (NULL == geographical_coordinates) {
        return;
    }
    ogs_free(geographical_coordinates);
}

cJSON *OpenAPI_geographical_coordinates_convertToJSON(OpenAPI_geographical_coordinates_t *geographical_coordinates)
{
    cJSON *item = NULL;
    OpenAPI_lnode_t *node = NULL;

    if (geographical_coordinates == NULL) {
        ogs_error("OpenAPI_geographical_coordinates_convertToJSON() failed [GeographicalCoordinates]");
        return NULL;
    }

    item = cJSON_CreateObject();
    if (geographical_coordinates->is_latitude) {
    if (cJSON_AddNumberToObject(item, "latitude", geographical_coordinates->latitude) == NULL) {
        ogs_error("OpenAPI_geographical_coordinates_convertToJSON() failed [latitude]");
        goto end;
    }
    }

    if (geographical_coordinates->is_longitude) {
    if (cJSON_AddNumberToObject(item, "longitude", geographical_coordinates->longitude) == NULL) {
        ogs_error("OpenAPI_geographical_coordinates_convertToJSON() failed [longitude]");
        goto end;
    }
    }

end:
    return item;
}

OpenAPI_geographical_coordinates_t *OpenAPI_geographical_coordinates_parseFromJSON(cJSON *geographical_coordinatesJSON)
{
    OpenAPI_geographical_coordinates_t *geographical_coordinates_local_var = NULL;
    OpenAPI_lnode_t *node = NULL;
    cJSON *latitude = NULL;
    cJSON *longitude = NULL;
    latitude = cJSON_GetObjectItemCaseSensitive(geographical_coordinatesJSON, "latitude");
    if (latitude) {
    if (!cJSON_IsNumber(latitude)) {
        ogs_error("OpenAPI_geographical_coordinates_parseFromJSON() failed [latitude]");
        goto end;
    }
    }

    longitude = cJSON_GetObjectItemCaseSensitive(geographical_coordinatesJSON, "longitude");
    if (longitude) {
    if (!cJSON_IsNumber(longitude)) {
        ogs_error("OpenAPI_geographical_coordinates_parseFromJSON() failed [longitude]");
        goto end;
    }
    }

    geographical_coordinates_local_var = OpenAPI_geographical_coordinates_create (
        latitude ? true : false,
        latitude ? latitude->valuedouble : 0,
        longitude ? true : false,
        longitude ? longitude->valuedouble : 0
    );

    return geographical_coordinates_local_var;
end:
    return NULL;
}

OpenAPI_geographical_coordinates_t *OpenAPI_geographical_coordinates_copy(OpenAPI_geographical_coordinates_t *dst, OpenAPI_geographical_coordinates_t *src)
{
    cJSON *item = NULL;
    char *content = NULL;

    ogs_assert(src);
    item = OpenAPI_geographical_coordinates_convertToJSON(src);
    if (!item) {
        ogs_error("OpenAPI_geographical_coordinates_convertToJSON() failed");
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

    OpenAPI_geographical_coordinates_free(dst);
    dst = OpenAPI_geographical_coordinates_parseFromJSON(item);
    cJSON_Delete(item);

    return dst;
}

