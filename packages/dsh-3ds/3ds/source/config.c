#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <string.h>
#include <strings.h>

#define CONFIG_DIR "sdmc:/3ds/dsh-link"
#define CONFIG_PATH CONFIG_DIR "/config.txt"

static void copy(char *destination, size_t size, const char *source) {
	if (size == 0) return;
	if (source == NULL) source = "";
	size_t length = strlen(source);
	if (length >= size) length = size - 1;
	memcpy(destination, source, length);
	destination[length] = '\0';
}

void config_load(Config *config) {
	memset(config, 0, sizeof(*config));
	FILE *file = fopen(CONFIG_PATH, "r");
	if (file == NULL) return;
	char line[256];
	while (fgets(line, sizeof(line), file) != NULL) {
		char *end = strpbrk(line, "\r\n");
		if (end != NULL) *end = '\0';
		if (strncmp(line, "base=", 5) == 0) copy(config->base, sizeof(config->base), line + 5);
		else if (strncmp(line, "token=", 6) == 0) copy(config->token, sizeof(config->token), line + 6);
		else if (strncmp(line, "last=", 5) == 0) copy(config->last, sizeof(config->last), line + 5);
	}
	fclose(file);
	config->paired = config->base[0] != '\0' && config->token[0] != '\0';
}

bool config_save(const Config *config) {
	mkdir(CONFIG_DIR, 0777);
	FILE *file = fopen(CONFIG_PATH, "w");
	if (file == NULL) return false;
	fprintf(file, "base=%s\n", config->base);
	fprintf(file, "token=%s\n", config->token);
	fprintf(file, "last=%s\n", config->last);
	fclose(file);
	return true;
}

bool config_parse_origin(const char *origin, char *host, size_t host_size, int *port) {
	if (origin == NULL || strncasecmp(origin, "http://", 7) != 0) return false;
	const char *cursor = origin + 7;
	const char *slash = strchr(cursor, '/');
	size_t length = slash == NULL ? strlen(cursor) : (size_t)(slash - cursor);
	if (length == 0 || length >= 128) return false;
	char authority[128];
	memcpy(authority, cursor, length);
	authority[length] = '\0';
	char *colon = strrchr(authority, ':');
	int parsed_port = 7080;
	if (colon != NULL) {
		*colon = '\0';
		parsed_port = atoi(colon + 1);
		if (parsed_port <= 0 || parsed_port > 65535) return false;
	}
	if (authority[0] == '\0') return false;
	snprintf(host, host_size, "%s", authority);
	*port = parsed_port;
	return true;
}
