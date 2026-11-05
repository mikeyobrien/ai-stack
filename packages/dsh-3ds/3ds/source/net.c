#include "net.h"
#include "config.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <malloc.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#define SOC_BUFFER_SIZE 0x100000
#define MAX_RESPONSE_BYTES (4 * 1024 * 1024)

static u32 *soc_buffer;
static bool soc_ready;

static u64 now_ms(void) {
	return osGetTime();
}

/** Wait for a socket to become readable/writable before the deadline. */
static bool wait_socket(int fd, bool writable, u64 deadline) {
	for (;;) {
		u64 current = now_ms();
		if (current >= deadline) return false;
		u64 left = deadline - current;
		struct timeval timeout = { (time_t)(left / 1000), (suseconds_t)((left % 1000) * 1000) };
		fd_set set;
		FD_ZERO(&set);
		FD_SET(fd, &set);
		int ready = select(fd + 1, writable ? NULL : &set, writable ? &set : NULL, NULL, &timeout);
		if (ready > 0) return true;
		if (ready < 0 && errno != EINTR) return false;
	}
}

bool http_init(void) {
	if (soc_ready) return true;
	soc_buffer = (u32 *)memalign(0x1000, SOC_BUFFER_SIZE);
	if (soc_buffer == NULL) return false;
	if (R_FAILED(socInit(soc_buffer, SOC_BUFFER_SIZE))) {
		free(soc_buffer);
		soc_buffer = NULL;
		return false;
	}
	soc_ready = true;
	return true;
}

void http_exit(void) {
	if (!soc_ready) return;
	socExit();
	free(soc_buffer);
	soc_buffer = NULL;
	soc_ready = false;
}

void http_response_free(HttpResponse *response) {
	if (response == NULL) return;
	free(response->body);
	response->body = NULL;
	response->length = 0;
}

static void set_error(HttpResponse *response, const char *text) {
	snprintf(response->error, sizeof(response->error), "%s", text == NULL ? "network error" : text);
}

bool http_request(const char *base, const char *token, const char *method, const char *path,
                  const void *body, size_t body_length, const char *content_type,
                  int timeout_ms, HttpResponse *response) {
	memset(response, 0, sizeof(*response));
	if (!soc_ready && !http_init()) {
		set_error(response, "network is not available");
		return false;
	}
	char host[128];
	int port = 0;
	if (!config_parse_origin(base, host, sizeof(host), &port)) {
		set_error(response, "the pairing address is malformed");
		return false;
	}
	struct hostent *resolved = gethostbyname(host);
	if (resolved == NULL || resolved->h_addrtype != AF_INET) {
		set_error(response, "the Harness host was not found");
		return false;
	}
	struct sockaddr_in address;
	memset(&address, 0, sizeof(address));
	address.sin_family = AF_INET;
	address.sin_port = htons((u16)port);
	memcpy(&address.sin_addr, resolved->h_addr_list[0], sizeof(address.sin_addr));

	int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
	if (fd < 0) {
		set_error(response, "could not open a socket");
		return false;
	}
	int flags = fcntl(fd, F_GETFL, 0);
	fcntl(fd, F_SETFL, flags | O_NONBLOCK);
	u64 deadline = now_ms() + (u64)(timeout_ms <= 0 ? 30000 : timeout_ms);

	int connected = connect(fd, (struct sockaddr *)&address, sizeof(address));
	if (connected < 0 && errno != EINPROGRESS) {
		close(fd);
		set_error(response, "the Harness host refused the connection");
		return false;
	}
	if (connected < 0) {
		if (!wait_socket(fd, true, deadline)) {
			close(fd);
			set_error(response, "the Harness host did not answer");
			return false;
		}
		int so_error = 0;
		socklen_t length = sizeof(so_error);
		if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &so_error, &length) != 0 || so_error != 0) {
			close(fd);
			set_error(response, "the Harness host did not answer");
			return false;
		}
	}

	size_t capacity = 2048;
	u8 *request = (u8 *)malloc(capacity);
	if (request == NULL) {
		close(fd);
		set_error(response, "out of memory");
		return false;
	}
	int used = snprintf((char *)request, capacity,
		"%s %s HTTP/1.1\r\n"
		"Host: %s:%d\r\n"
		"Connection: close\r\n"
		"X-3DS-Token: %s\r\n"
		"User-Agent: dsh-link/1\r\n"
		"%s%s%s"
		"Content-Length: %zu\r\n"
		"\r\n",
		method, path, host, port, token == NULL ? "" : token,
		body_length > 0 ? "Content-Type: " : "",
		body_length > 0 ? (content_type == NULL ? "application/octet-stream" : content_type) : "",
		body_length > 0 ? "\r\n" : "",
		body_length);
	if (used < 0) {
		free(request);
		close(fd);
		set_error(response, "could not build the request");
		return false;
	}
	size_t header_length = (size_t)used;
	if (header_length + body_length > capacity) {
		capacity = header_length + body_length;
		u8 *grown = (u8 *)realloc(request, capacity);
		if (grown == NULL) {
			free(request);
			close(fd);
			set_error(response, "out of memory");
			return false;
		}
		request = grown;
	}
	if (body_length > 0) memcpy(request + header_length, body, body_length);
	size_t total = header_length + body_length;
	size_t sent = 0;
	while (sent < total) {
		ssize_t wrote = send(fd, request + sent, total - sent, 0);
		if (wrote > 0) {
			sent += (size_t)wrote;
			continue;
		}
		if (wrote < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
			if (!wait_socket(fd, true, deadline)) {
				free(request);
				close(fd);
				set_error(response, "the request timed out");
				return false;
			}
			continue;
		}
		free(request);
		close(fd);
		set_error(response, "the request could not be sent");
		return false;
	}
	free(request);

	u8 *incoming = (u8 *)malloc(4096);
	size_t incoming_length = 0;
	size_t incoming_capacity = 4096;
	if (incoming == NULL) {
		close(fd);
		set_error(response, "out of memory");
		return false;
	}
	size_t header_end = 0;
	long content_length = -1;
	bool complete = false;
	while (!complete) {
		if (incoming_length + 2048 > incoming_capacity) {
			if (incoming_capacity >= MAX_RESPONSE_BYTES) {
				free(incoming);
				close(fd);
				set_error(response, "the response was too large");
				return false;
			}
			size_t next = incoming_capacity * 2;
			u8 *grown = (u8 *)realloc(incoming, next);
			if (grown == NULL) {
				free(incoming);
				close(fd);
				set_error(response, "out of memory");
				return false;
			}
			incoming = grown;
			incoming_capacity = next;
		}
		ssize_t got = recv(fd, incoming + incoming_length, incoming_capacity - incoming_length, 0);
		if (got > 0) {
			incoming_length += (size_t)got;
			if (header_end == 0) {
				for (size_t index = 0; index + 3 < incoming_length; index++) {
					if (incoming[index] == '\r' && incoming[index + 1] == '\n' &&
						incoming[index + 2] == '\r' && incoming[index + 3] == '\n') {
						header_end = index + 4;
						break;
					}
				}
				if (header_end > 0) {
					incoming[header_end - 1] = '\0';
					char *header = (char *)incoming;
					char *length_header = strstr(header, "\r\nContent-Length:");
					if (length_header == NULL) length_header = strstr(header, "\r\ncontent-length:");
					if (length_header != NULL) content_length = strtol(length_header + 17, NULL, 10);
					char *status = strstr(header, "HTTP/");
					if (status != NULL) {
						char *space = strchr(status, ' ');
						if (space != NULL) response->status = atoi(space + 1);
					}
				}
			}
			if (header_end > 0 && content_length >= 0) {
				complete = incoming_length >= header_end + (size_t)content_length;
			}
			continue;
		}
		if (got == 0) break;
		if (errno == EAGAIN || errno == EWOULDBLOCK) {
			if (!wait_socket(fd, false, deadline)) break;
			continue;
		}
		break;
	}
	close(fd);
	if (header_end == 0 || response->status == 0) {
		free(incoming);
		set_error(response, "the Harness did not return an HTTP response");
		return false;
	}
	size_t body_size = incoming_length - header_end;
	if (content_length >= 0 && (size_t)content_length < body_size) body_size = (size_t)content_length;
	response->body = (char *)malloc(body_size + 1);
	if (response->body == NULL) {
		free(incoming);
		set_error(response, "out of memory");
		return false;
	}
	memcpy(response->body, incoming + header_end, body_size);
	response->body[body_size] = '\0';
	response->length = body_size;
	free(incoming);
	return true;
}
