/*
 * geographical_coordinates_1.h
 *
 * Geographical coordinates.
 */

#ifndef _OpenAPI_geographical_coordinates_1_H_
#define _OpenAPI_geographical_coordinates_1_H_

#include <string.h>
#include "third-party/cjson/cJSON.h"
#include "../include/list.h"
#include "../include/keyValuePair.h"
#include "../include/binary.h"
typedef struct OpenAPI_geographical_coordinates_1_s OpenAPI_geographical_coordinates_1_t;

#ifdef __cplusplus
extern "C" {
#endif

struct OpenAPI_geographical_coordinates_1_s {
    double lon;
    double lat;
};

OpenAPI_geographical_coordinates_1_t *OpenAPI_geographical_coordinates_1_create(
    double lon,
    double lat
);
void OpenAPI_geographical_coordinates_1_free(OpenAPI_geographical_coordinates_1_t *geographical_coordinates_1);
OpenAPI_geographical_coordinates_1_t *OpenAPI_geographical_coordinates_1_parseFromJSON(cJSON *geographical_coordinates_1JSON);
cJSON *OpenAPI_geographical_coordinates_1_convertToJSON(OpenAPI_geographical_coordinates_1_t *geographical_coordinates_1);
OpenAPI_geographical_coordinates_1_t *OpenAPI_geographical_coordinates_1_copy(OpenAPI_geographical_coordinates_1_t *dst, OpenAPI_geographical_coordinates_1_t *src);

#ifdef __cplusplus
}
#endif

#endif /* _OpenAPI_geographical_coordinates_1_H_ */

