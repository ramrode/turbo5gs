/*
 * tai_1.h
 *
 * 
 */

#ifndef _OpenAPI_tai_1_H_
#define _OpenAPI_tai_1_H_

#include <string.h>
#include "third-party/cjson/cJSON.h"
#include "../include/list.h"
#include "../include/keyValuePair.h"
#include "../include/binary.h"
typedef struct OpenAPI_tai_1_s OpenAPI_tai_1_t;

#ifdef __cplusplus
extern "C" {
#endif

struct OpenAPI_tai_1_s {
    char *mcc;
    char *mnc;
    char *tac;
};

OpenAPI_tai_1_t *OpenAPI_tai_1_create(
    char *mcc,
    char *mnc,
    char *tac
);
void OpenAPI_tai_1_free(OpenAPI_tai_1_t *tai_1);
OpenAPI_tai_1_t *OpenAPI_tai_1_parseFromJSON(cJSON *tai_1JSON);
cJSON *OpenAPI_tai_1_convertToJSON(OpenAPI_tai_1_t *tai_1);
OpenAPI_tai_1_t *OpenAPI_tai_1_copy(OpenAPI_tai_1_t *dst, OpenAPI_tai_1_t *src);

#ifdef __cplusplus
}
#endif

#endif /* _OpenAPI_tai_1_H_ */

