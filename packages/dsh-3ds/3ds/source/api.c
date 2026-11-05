#include "api.h"
#include "net.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

static void copy_string(char *destination, size_t size, const char *source) {
	if (size == 0) return;
	if (source == NULL) {
		destination[0] = '\0';
		return;
	}
	snprintf(destination, size, "%s", source);
}

static const char *json_string(cJSON *object, const char *name) {
	cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);
	return cJSON_IsString(item) ? item->valuestring : NULL;
}

/** Show the bridge's error sentence, or a status fallback. */
static void api_error(const HttpResponse *response) {
	char message[160] = "";
	cJSON *root = cJSON_Parse(response->body);
	if (root != NULL) {
		const char *error = json_string(root, "error");
		if (error != NULL) copy_string(message, sizeof(message), error);
		cJSON_Delete(root);
	}
	if (message[0] == '\0') snprintf(message, sizeof(message), "Harness returned HTTP %d", response->status);
	if (response->status == 401) app.needs_pairing = true;
	app_error(message);
}

static bool api_request(const char *method, const char *path, const void *body, size_t length,
                        const char *content_type, int timeout_ms, HttpResponse *response) {
	if (!http_request(app.config.base, app.config.token, method, path, body, length, content_type, timeout_ms, response)) {
		app_error(response->error);
		return false;
	}
	if (response->status >= 200 && response->status < 300) return true;
	api_error(response);
	return false;
}

static void parse_sessions(cJSON *items) {
	app.session_count = 0;
	if (!cJSON_IsArray(items)) return;
	cJSON *item = NULL;
	cJSON_ArrayForEach(item, items) {
		if (app.session_count >= MAX_SESSIONS) break;
		const char *id = json_string(item, "id");
		if (id == NULL) continue;
		SessionInfo *row = &app.sessions[app.session_count++];
		memset(row, 0, sizeof(*row));
		copy_string(row->id, sizeof(row->id), id);
		copy_string(row->title, sizeof(row->title), json_string(item, "title"));
		cJSON *running = cJSON_GetObjectItemCaseSensitive(item, "running");
		row->running = cJSON_IsTrue(running);
		cJSON *blank = cJSON_GetObjectItemCaseSensitive(item, "blank");
		row->blank = cJSON_IsTrue(blank);
		cJSON *updated = cJSON_GetObjectItemCaseSensitive(item, "updatedAt");
		if (cJSON_IsNumber(updated)) row->updated_at = (long)updated->valuedouble;
	}
}

bool api_hello(void) {
	HttpResponse response;
	if (!api_request("GET", "/api/hello", NULL, 0, NULL, 7000, &response)) return false;
	cJSON *root = cJSON_Parse(response.body);
	bool ok = root != NULL && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "ok"));
	if (ok) {
		parse_sessions(cJSON_GetObjectItemCaseSensitive(root, "sessions"));
		app.connected = true;
		app.error[0] = '\0';
	} else {
		app_error("the bridge rejected this console");
	}
	cJSON_Delete(root);
	http_response_free(&response);
	return ok;
}

bool api_sessions(void) {
	HttpResponse response;
	if (!api_request("GET", "/api/sessions", NULL, 0, NULL, 7000, &response)) return false;
	cJSON *root = cJSON_Parse(response.body);
	bool ok = root != NULL && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "ok"));
	if (ok) {
		parse_sessions(cJSON_GetObjectItemCaseSensitive(root, "sessions"));
		app.error[0] = '\0';
	} else app_error("could not read the session list");
	cJSON_Delete(root);
	http_response_free(&response);
	return ok;
}

bool api_new_session(void) {
	HttpResponse response;
	if (!api_request("POST", "/api/session/new", NULL, 0, NULL, 12000, &response)) return false;
	cJSON *root = cJSON_Parse(response.body);
	const char *session_id = root == NULL ? NULL : json_string(root, "sessionId");
	bool ok = session_id != NULL;
	if (ok) {
		app_select(session_id, "New session");
		app.screen = SCREEN_CHAT;
	} else {
		app_error("could not start a session");
	}
	cJSON_Delete(root);
	http_response_free(&response);
	return ok;
}

static void append_message(int seq, char role, const char *text) {
	if (seq <= 0 || text == NULL || text[0] == '\0') return;
	for (int index = 0; index < app.message_count; index++) {
		if (app.messages[index].seq == seq) return;
	}
	if (app.message_count >= MAX_MESSAGES) {
		memmove(&app.messages[0], &app.messages[1], sizeof(ChatMessage) * (MAX_MESSAGES - 1));
		app.message_count--;
	}
	ChatMessage *message = &app.messages[app.message_count++];
	memset(message, 0, sizeof(*message));
	message->seq = seq;
	message->role = role;
	copy_string(message->text, sizeof(message->text), text);
	app.loading = false;
	app.revision++;
}

bool api_state(void) {
	if (app.current[0] == '\0') return false;
	char path[256];
	snprintf(path, sizeof(path), "/api/state?sessionId=%s&after=%d", app.current, app.cursor);
	HttpResponse response;
	if (!api_request("GET", path, NULL, 0, NULL, 5000, &response)) {
		app.connected = false;
		return false;
	}
	app.connected = true;
	cJSON *root = cJSON_Parse(response.body);
	bool ok = root != NULL && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "ok"));
	cJSON *session = ok ? cJSON_GetObjectItemCaseSensitive(root, "session") : NULL;
	if (!cJSON_IsObject(session)) {
		app_error("the session is no longer available");
		cJSON_Delete(root);
		http_response_free(&response);
		return false;
	}
	cJSON *cursor = cJSON_GetObjectItemCaseSensitive(session, "cursor");
	if (cJSON_IsNumber(cursor) && (int)cursor->valuedouble > app.cursor) app.cursor = (int)cursor->valuedouble;
	const char *live = json_string(session, "live");
	copy_string(app.live, sizeof(app.live), live);
	cJSON *running = cJSON_GetObjectItemCaseSensitive(session, "running");
	app.running = cJSON_IsTrue(running);
	bool ready = true;
	cJSON *ready_item = cJSON_GetObjectItemCaseSensitive(session, "ready");
	if (cJSON_IsBool(ready_item)) ready = cJSON_IsTrue(ready_item);
	const char *title = json_string(session, "title");
	if (title != NULL && title[0] != '\0') copy_string(app.title, sizeof(app.title), title);
	const char *feed_error = json_string(session, "error");
	if (feed_error != NULL && feed_error[0] != '\0') app_error(feed_error);
	cJSON *messages = cJSON_GetObjectItemCaseSensitive(session, "messages");
	cJSON *message = NULL;
	cJSON_ArrayForEach(message, messages) {
		cJSON *seq = cJSON_GetObjectItemCaseSensitive(message, "seq");
		const char *role = json_string(message, "role");
		const char *text = json_string(message, "text");
		if (!cJSON_IsNumber(seq) || role == NULL || text == NULL) continue;
		append_message((int)seq->valuedouble, role[0] == 'u' ? 'u' : 'a', text);
	}
	app.loading = !ready;
	app.revision++;
	if (feed_error == NULL || feed_error[0] == '\0') app.error[0] = '\0';
	cJSON_Delete(root);
	http_response_free(&response);
	return true;
}

bool api_prompt(const char *text) {
	if (text == NULL || text[0] == '\0') return false;
	cJSON *root = cJSON_CreateObject();
	cJSON_AddStringToObject(root, "text", text);
	char *body = cJSON_PrintUnformatted(root);
	cJSON_Delete(root);
	if (body == NULL) {
		app_error("out of memory");
		return false;
	}
	char path[160];
	snprintf(path, sizeof(path), "/api/prompt?sessionId=%s", app.current);
	HttpResponse response;
	bool ok = api_request("POST", path, body, strlen(body), "application/json", 30000, &response);
	free(body);
	http_response_free(&response);
	if (ok) {
		app.error[0] = '\0';
		app_notify("Sent");
		app.last_poll = 0;
	}
	return ok;
}

bool api_voice(const void *wav, size_t length) {
	char path[160];
	snprintf(path, sizeof(path), "/api/voice?sessionId=%s", app.current);
	HttpResponse response;
	if (!api_request("POST", path, wav, length, "audio/wav", 130000, &response)) return false;
	cJSON *root = cJSON_Parse(response.body);
	const char *text = root == NULL ? NULL : json_string(root, "text");
	if (text != NULL) {
		app.error[0] = '\0';
		char toast[128];
		snprintf(toast, sizeof(toast), "Heard: %s", text);
		app_notify(toast);
	} else {
		app_notify("Voice sent");
	}
	app.last_poll = 0;
	cJSON_Delete(root);
	http_response_free(&response);
	return true;
}

bool api_ink(const InkCanvas *ink) {
	cJSON *root = cJSON_CreateObject();
	cJSON_AddNumberToObject(root, "width", INK_WIDTH);
	cJSON_AddNumberToObject(root, "height", INK_HEIGHT);
	cJSON *strokes = cJSON_AddArrayToObject(root, "strokes");
	for (int index = 0; index < ink->strokes; index++) {
		cJSON *stroke = cJSON_CreateArray();
		int start = ink->start[index];
		int count = ink->count[index];
		for (int point = 0; point < count; point++) {
			cJSON_AddItemToArray(stroke, cJSON_CreateNumber(ink->x[start + point]));
			cJSON_AddItemToArray(stroke, cJSON_CreateNumber(ink->y[start + point]));
		}
		cJSON_AddItemToArray(strokes, stroke);
	}
	char *body = cJSON_PrintUnformatted(root);
	cJSON_Delete(root);
	if (body == NULL) {
		app_error("out of memory");
		return false;
	}
	char path[160];
	snprintf(path, sizeof(path), "/api/ink?sessionId=%s", app.current);
	HttpResponse response;
	bool ok = api_request("POST", path, body, strlen(body), "application/json", 45000, &response);
	free(body);
	http_response_free(&response);
	if (ok) {
		app.error[0] = '\0';
		app_notify("Note sent");
		app.last_poll = 0;
	}
	return ok;
}
