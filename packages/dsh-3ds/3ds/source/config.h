#pragma once

#include "app.h"

/** Load the pairing file if present. */
void config_load(Config *config);

/** Persist the pairing file, creating the directory once. */
bool config_save(const Config *config);

/** Split an http origin into host and port. Returns false when malformed. */
bool config_parse_origin(const char *origin, char *host, size_t host_size, int *port);
