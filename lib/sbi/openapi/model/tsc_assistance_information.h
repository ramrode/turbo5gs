/*
 * tsc_assistance_information.h
 *
 * 
 */

#ifndef _OpenAPI_tsc_assistance_information_H_
#define _OpenAPI_tsc_assistance_information_H_

#include <string.h>
#include "third-party/cjson/cJSON.h"
#include "../include/list.h"
#include "../include/keyValuePair.h"
#include "../include/binary.h"
typedef struct OpenAPI_tsc_assistance_information_s OpenAPI_tsc_assistance_information_t;
#include "tsc_flow_direction.h"

#ifdef __cplusplus
extern "C" {
#endif

struct OpenAPI_tsc_assistance_information_s {
    OpenAPI_tsc_flow_direction_e flow_direction;
    bool is_periodicity;
    int periodicity;
};

OpenAPI_tsc_assistance_information_t *OpenAPI_tsc_assistance_information_create(
    OpenAPI_tsc_flow_direction_e flow_direction,
    bool is_periodicity,
    int periodicity
);
void OpenAPI_tsc_assistance_information_free(OpenAPI_tsc_assistance_information_t *tsc_assistance_information);
OpenAPI_tsc_assistance_information_t *OpenAPI_tsc_assistance_information_parseFromJSON(cJSON *tsc_assistance_informationJSON);
cJSON *OpenAPI_tsc_assistance_information_convertToJSON(OpenAPI_tsc_assistance_information_t *tsc_assistance_information);
OpenAPI_tsc_assistance_information_t *OpenAPI_tsc_assistance_information_copy(OpenAPI_tsc_assistance_information_t *dst, OpenAPI_tsc_assistance_information_t *src);

#ifdef __cplusplus
}
#endif

#endif /* _OpenAPI_tsc_assistance_information_H_ */

