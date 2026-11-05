#pragma once

#include <3ds.h>
#include <stdbool.h>
#include <stddef.h>

/** One HTTP response owned by the caller. */
typedef struct {
	int status;
	char *body;
	size_t length;
	char error[144];
} HttpResponse;

/** Bring up the SOC service. */
bool http_init(void);

/** Tear down the SOC service. */
void http_exit(void);

/**
 * Perform one plain-HTTP request against a LAN origin.
 *
 * @param base origin, e.g. http://192.168.1.50:7080
 * @param token pairing token, or NULL
 * @param method GET or POST
 * @param path absolute path with query
 * @param body request bytes, or NULL
 * @param body_length request length
 * @param content_type request content type, or NULL
 * @param timeout_ms whole-operation bound
 * @param response receives the status and body
 */
bool http_request(const char *base, const char *token, const char *method, const char *path,
                  const void *body, size_t body_length, const char *content_type,
                  int timeout_ms, HttpResponse *response);

/** Release a response body. */
void http_response_free(HttpResponse *response);
