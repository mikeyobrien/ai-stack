#include <3ds.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

#include "api.h"
#include "app.h"
#include "config.h"
#include "mic.h"
#include "net.h"
#include "qrscan.h"
#include "ui.h"

#define MAX_RECORD_SECONDS 12
#define MIC_SAMPLE_RATE 16364
#define INK_BLACK 24

AppState app;
static bool camera_attempted;
static bool sessions_loaded;

static void present(void) {
	gfxFlushBuffers();
	gspWaitForVBlank();
	gfxSwapBuffers();
}

void app_error(const char *text) {
	snprintf(app.error, sizeof(app.error), "%s", text == NULL ? "" : text);
}

void app_notify(const char *text) {
	snprintf(app.toast, sizeof(app.toast), "%s", text == NULL ? "" : text);
	app.toast_until = osGetTime() + 4000;
}

const SessionInfo *app_session(const char *session_id) {
	for (int index = 0; index < app.session_count; index++) {
		if (strcmp(app.sessions[index].id, session_id) == 0) return &app.sessions[index];
	}
	return NULL;
}

void app_select(const char *session_id, const char *title) {
	snprintf(app.current, sizeof(app.current), "%s", session_id);
	snprintf(app.title, sizeof(app.title), "%s", title == NULL ? "" : title);
	app.cursor = 0;
	app.message_count = 0;
	app.live[0] = '\0';
	app.running = false;
	app.loading = true;
	app.scroll = 0;
	app.revision++;
	app.error[0] = '\0';
	app.toast[0] = '\0';
	app.needs_pairing = false;
	if (strcmp(app.config.last, session_id) != 0) {
		snprintf(app.config.last, sizeof(app.config.last), "%s", session_id);
		config_save(&app.config);
	}
}

static void start_chat(int index) {
	if (index < 0 || index >= app.session_count) return;
	const SessionInfo *session = &app.sessions[index];
	app_select(session->id, session->title);
	app.screen = SCREEN_CHAT;
	app.last_poll = 0;
}

static void choose_initial(void) {
	if (app.session_count == 0) {
		if (!api_new_session()) app.screen = SCREEN_SESSIONS;
		return;
	}
	const SessionInfo *last = app_session(app.config.last);
	if (last != NULL) {
		for (int index = 0; index < app.session_count; index++) {
			if (&app.sessions[index] == last) {
				start_chat(index);
				return;
			}
		}
	}
	app.session_selected = 0;
	app.session_offset = 0;
	sessions_loaded = true;
	app.screen = SCREEN_SESSIONS;
}

static void pair_payload(const char *payload) {
	cJSON *root = cJSON_Parse(payload);
	if (root == NULL) {
		app_error("That QR code is not a DSH Link pair.");
		return;
	}
	cJSON *url_item = cJSON_GetObjectItemCaseSensitive(root, "url");
	cJSON *token_item = cJSON_GetObjectItemCaseSensitive(root, "token");
	char host[128];
	int port = 0;
	if (!cJSON_IsString(url_item) || !cJSON_IsString(token_item) ||
		!config_parse_origin(url_item->valuestring, host, sizeof(host), &port) ||
		strlen(token_item->valuestring) < 16) {
		cJSON_Delete(root);
		app_error("That QR code is not a DSH Link pair.");
		return;
	}
	snprintf(app.config.base, sizeof(app.config.base), "%s", url_item->valuestring);
	snprintf(app.config.token, sizeof(app.config.token), "%s", token_item->valuestring);
	app.config.paired = true;
	config_save(&app.config);
	cJSON_Delete(root);
	qr_end();
	camera_attempted = true;
	if (!api_hello()) {
		app.screen = SCREEN_PAIR;
		camera_attempted = false;
		return;
	}
	choose_initial();
}

static void ask(const char *hint, char *text, size_t size, bool password) {
	SwkbdState keyboard;
	swkbdInit(&keyboard, SWKBD_TYPE_NORMAL, 2, (int)size - 1);
	swkbdSetHintText(&keyboard, hint);
	swkbdSetInitialText(&keyboard, text);
	if (password) swkbdSetPasswordMode(&keyboard, SWKBD_PASSWORD_HIDE);
	text[0] = '\0';
	if (swkbdInputText(&keyboard, text, size) != SWKBD_BUTTON_CONFIRM) text[0] = '\0';
}

static void manual_pair(void) {
	char url[160];
	snprintf(url, sizeof(url), "%s", app.config.base);
	char token[96];
	snprintf(token, sizeof(token), "%s", app.config.token);
	ask("http://host:7080", url, sizeof(url), false);
	if (url[0] == '\0') return;
	ask("Pairing token", token, sizeof(token), true);
	if (token[0] == '\0') return;
	char host[128];
	int port = 0;
	if (!config_parse_origin(url, host, sizeof(host), &port) || strlen(token) < 16) {
		app_error("That address or token is not valid.");
		return;
	}
	snprintf(app.config.base, sizeof(app.config.base), "%s", url);
	snprintf(app.config.token, sizeof(app.config.token), "%s", token);
	app.config.paired = true;
	config_save(&app.config);
	qr_end();
	camera_attempted = true;
	if (!api_hello()) {
		app.screen = SCREEN_PAIR;
		camera_attempted = false;
		return;
	}
	choose_initial();
}

static void text_flow(void) {
	char text[512];
	text[0] = '\0';
	ask("Message", text, sizeof(text), false);
	if (text[0] == '\0') return;
	api_prompt(text);
}

static int level_of(const s16 *samples, int count) {
	int peak = 0;
	int start = count > 512 ? count - 512 : 0;
	for (int index = start; index < count; index++) {
		int value = samples[index];
		if (value < 0) value = -value;
		if (value > peak) peak = value;
	}
	return peak * 100 / 32768;
}

static void voice_flow(bool touch_mode) {
	size_t capacity = (size_t)MIC_SAMPLE_RATE * MAX_RECORD_SECONDS * 2;
	s16 *samples = (s16 *)malloc(capacity);
	if (samples == NULL) {
		app_error("out of memory");
		return;
	}
	if (!mic_start()) {
		free(samples);
		app_error("the microphone is unavailable");
		return;
	}
	size_t bytes = 0;
	u64 started = osGetTime();
	u64 painted = 0;
	bool cancelled = false;
	while (aptMainLoop()) {
		hidScanInput();
		u32 held = hidKeysHeld();
		if (touch_mode) {
			if (!(held & KEY_TOUCH)) break;
		} else if (!(held & KEY_Y)) break;
		if (held & KEY_B) {
			cancelled = true;
			break;
		}
		if (bytes < capacity) {
			bytes += mic_read((u8 *)samples + bytes, (u32)(capacity - bytes));
		}
		u64 now = osGetTime();
		if (now - started > MAX_RECORD_SECONDS * 1000) break;
		if (now - painted > 120) {
			int samples_ready = (int)(bytes / 2);
			ui_recording(level_of(samples, samples_ready), (int)((now - started) / 100));
			present();
			painted = now;
		}
		svcSleepThread(8 * 1000 * 1000LL);
	}
	mic_stop();
	if (cancelled) {
		free(samples);
		return;
	}
	if (bytes < 16000) {
		free(samples);
		app_notify("Too short");
		return;
	}
	size_t wav_length = 0;
	u8 *wav = mic_wav(samples, (int)(bytes / 2), &wav_length);
	free(samples);
	if (wav == NULL) {
		app_error("out of memory");
		return;
	}
	ui_transcribing();
	present();
	api_voice(wav, wav_length);
	free(wav);
	app.last_poll = 0;
}

static void enter_ink(void) {
	memset(&app.ink, 0, sizeof(app.ink));
	app.screen = SCREEN_INK;
	app.error[0] = '\0';
}

static void select_current_session(void) {
	for (int index = 0; index < app.session_count; index++) {
		if (strcmp(app.sessions[index].id, app.current) == 0) {
			app.session_selected = index;
			if (app.session_selected >= app.session_offset + 8) app.session_offset = app.session_selected - 7;
			if (app.session_selected < app.session_offset) app.session_offset = app.session_selected;
			return;
		}
	}
}

static void enter_sessions(void) {
	sessions_loaded = false;
	select_current_session();
	app.screen = SCREEN_SESSIONS;
	if (app.session_selected >= app.session_count) app.session_selected = app.session_count > 0 ? app.session_count - 1 : 0;
}

static void ink_begin(int x, int y) {
	if (app.ink.strokes >= INK_MAX_STROKES || app.ink.points >= INK_MAX_POINTS) return;
	if (x < 0) x = 0;
	if (x >= INK_WIDTH) x = INK_WIDTH - 1;
	if (y < 0) y = 0;
	if (y >= INK_HEIGHT) y = INK_HEIGHT - 1;
	app.ink.start[app.ink.strokes] = (u16)app.ink.points;
	app.ink.count[app.ink.strokes] = 0;
	app.ink.strokes++;
	app.ink.drawing = true;
	app.ink.x[app.ink.points] = (s16)x;
	app.ink.y[app.ink.points] = (s16)y;
	app.ink.points++;
	app.ink.count[app.ink.strokes - 1] = 1;
}

static void ink_point(int x, int y) {
	if (!app.ink.drawing || app.ink.strokes == 0) return;
	if (x < 0) x = 0;
	if (x >= INK_WIDTH) x = INK_WIDTH - 1;
	if (y < 0) y = 0;
	if (y >= INK_HEIGHT) y = INK_HEIGHT - 1;
	int stroke = app.ink.strokes - 1;
	int start = app.ink.start[stroke];
	int count = app.ink.count[stroke];
	if (count > 0 && app.ink.x[start + count - 1] == x && app.ink.y[start + count - 1] == y) return;
	if (app.ink.points >= INK_MAX_POINTS || count >= 0xffff) return;
	app.ink.x[app.ink.points] = (s16)x;
	app.ink.y[app.ink.points] = (s16)y;
	app.ink.points++;
	app.ink.count[stroke] = (u16)(count + 1);
}

static void ink_send(void) {
	if (app.ink.strokes == 0 || app.ink.points == 0) {
		app_notify("Draw first");
		return;
	}
	if (api_ink(&app.ink)) {
		memset(&app.ink, 0, sizeof(app.ink));
		app.screen = SCREEN_CHAT;
		app.last_poll = 0;
	}
}

static void pair_screen(u32 down) {
	if (!camera_attempted) {
		camera_attempted = true;
		qr_begin();
	}
	if (app.camera_ready) {
		char payload[512];
		if (qr_frame(payload, sizeof(payload))) {
			pair_payload(payload);
			return;
		}
	}
	if (down & KEY_X) {
		manual_pair();
		return;
	}
	if ((down & KEY_A) && app.config.paired) {
		if (api_hello()) {
			qr_end();
			camera_attempted = true;
			choose_initial();
			return;
		}
	}
	ui_pair(app.camera_ready ? "Scanning" : NULL);
}

static void chat_screen(u32 down, u32 held, bool touched, const touchPosition *touch) {
	if (down & KEY_A) text_flow();
	else if (down & KEY_Y) voice_flow(false);
	else if (down & KEY_X) enter_ink();
	else if (down & KEY_B) enter_sessions();
	else if (down & KEY_DUP) app.scroll += 4;
	else if (down & KEY_DDOWN) app.scroll -= 4;
	else if (touched) {
		int hit = ui_chat_hit(touch->px, touch->py);
		if (hit == UI_HIT_TEXT) text_flow();
		else if (hit == UI_HIT_VOICE) voice_flow(true);
		else if (hit == UI_HIT_WRITE) enter_ink();
		else if (hit == UI_HIT_SESSIONS) enter_sessions();
	}
	(void)held;
	if (app.screen != SCREEN_CHAT) return;
	u64 now = osGetTime();
	if (app.last_poll == 0 || now - app.last_poll > 1200) {
		app.last_poll = now;
		api_state();
	}
	ui_chat();
}

static void sessions_screen(u32 down, bool touched, const touchPosition *touch) {
	if (!sessions_loaded) {
		api_sessions();
		sessions_loaded = true;
		select_current_session();
		if (app.session_selected >= app.session_count) app.session_selected = app.session_count > 0 ? app.session_count - 1 : 0;
	}
	if (down & KEY_DUP) {
		if (app.session_selected > 0) app.session_selected--;
		if (app.session_selected < app.session_offset) app.session_offset = app.session_selected;
	} else if (down & KEY_DDOWN) {
		if (app.session_selected + 1 < app.session_count) app.session_selected++;
		if (app.session_selected >= app.session_offset + 8) app.session_offset = app.session_selected - 7;
	} else if (down & KEY_A) {
		start_chat(app.session_selected);
	} else if (down & KEY_X) {
		if (api_new_session()) sessions_loaded = false;
	} else if (down & KEY_B) {
		app.screen = SCREEN_CHAT;
		app.last_poll = 0;
	} else if (touched) {
		int hit = ui_sessions_hit(touch->px, touch->py);
		if (hit >= UI_HIT_SESSION) {
			int index = app.session_offset + (hit - UI_HIT_SESSION);
			if (index < app.session_count) {
				app.session_selected = index;
				start_chat(index);
			}
		} else if (hit == UI_HIT_NEW) {
			if (api_new_session()) sessions_loaded = false;
		} else if (hit == UI_HIT_BACK) {
			app.screen = SCREEN_CHAT;
			app.last_poll = 0;
		}
	}
	if (app.screen == SCREEN_SESSIONS) ui_sessions();
}

static void ink_screen(u32 down, u32 held, bool touched, const touchPosition *touch) {
	if (down & KEY_A) ink_send();
	else if (down & KEY_X) memset(&app.ink, 0, sizeof(app.ink));
	else if (down & KEY_B) {
		app.screen = SCREEN_CHAT;
		app.last_poll = 0;
	} else if (touched) {
		int hit = ui_ink_hit(touch->px, touch->py);
		if (hit == UI_HIT_SEND) ink_send();
		else if (hit == UI_HIT_CLEAR) memset(&app.ink, 0, sizeof(app.ink));
		else if (hit == UI_HIT_BACK) {
			app.screen = SCREEN_CHAT;
			app.last_poll = 0;
		} else if (hit == UI_HIT_CANVAS) {
			ink_begin(touch->px, touch->py);
		}
	}
	if (app.screen == SCREEN_INK) {
		if ((held & KEY_TOUCH) && app.ink.drawing) ink_point(touch->px, touch->py);
		if (!(held & KEY_TOUCH)) app.ink.drawing = false;
		ui_ink();
	}
}

int main(void) {
	memset(&app, 0, sizeof(app));
	gfxInitDefault();
	ui_init();
	config_load(&app.config);
	http_init();
	app.screen = SCREEN_PAIR;
	if (app.config.paired) {
		app.loading = true;
		if (api_hello()) choose_initial();
	}

	while (aptMainLoop()) {
		hidScanInput();
		u32 down = hidKeysDown();
		u32 held = hidKeysHeld();
		touchPosition touch;
		hidTouchRead(&touch);
		bool touched = (down & KEY_TOUCH) != 0;

		if (down & KEY_START) break;
		if (app.needs_pairing && app.screen != SCREEN_PAIR) {
			app.needs_pairing = false;
			qr_end();
			camera_attempted = false;
			app.screen = SCREEN_PAIR;
		}

		switch (app.screen) {
		case SCREEN_PAIR:
			pair_screen(down);
			break;
		case SCREEN_CHAT:
			chat_screen(down, held, touched, &touch);
			break;
		case SCREEN_SESSIONS:
			sessions_screen(down, touched, &touch);
			break;
		case SCREEN_INK:
			ink_screen(down, held, touched, &touch);
			break;
		}
		present();
	}

	qr_end();
	mic_stop();
	http_exit();
	gfxExit();
	return 0;
}
