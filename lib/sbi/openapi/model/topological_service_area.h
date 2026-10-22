/*
 * topological_service_area.h
 *
 * 
 */

#ifndef _OpenAPI_topological_service_area_H_
#define _OpenAPI_topological_service_area_H_

#include <string.h>
#include "third-party/cjson/cJSON.h"
#include "../include/list.h"
#include "../include/keyValuePair.h"
#include "../include/binary.h"
typedef struct OpenAPI_topological_service_area_s OpenAPI_topological_service_area_t;
#include "plmn_id_1.h"
#include "tai_1.h"

#ifdef __cplusplus
extern "C" {
#endif

struct OpenAPI_topological_service_area_s {
    OpenAPI_list_t *cell_id_list;
    OpenAPI_list_t *tracking_area_id_list;
    struct OpenAPI_plmn_id_1_s *serving_plmn;
};

OpenAPI_topological_service_area_t *OpenAPI_topological_service_area_create(
    OpenAPI_list_t *cell_id_list,
    OpenAPI_list_t *tracking_area_id_list,
    OpenAPI_plmn_id_1_t *serving_plmn
);
void OpenAPI_topological_service_area_free(OpenAPI_topological_service_area_t *topological_service_area);
OpenAPI_topological_service_area_t *OpenAPI_topological_service_area_parseFromJSON(cJSON *topological_service_areaJSON);
cJSON *OpenAPI_topological_service_area_convertToJSON(OpenAPI_topological_service_area_t *topological_service_area);
OpenAPI_topological_service_area_t *OpenAPI_topological_service_area_copy(OpenAPI_topological_service_area_t *dst, OpenAPI_topological_service_area_t *src);

#ifdef __cplusplus
}
#endif

#endif /* _OpenAPI_topological_service_area_H_ */

