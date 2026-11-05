#pragma once

#include "app.h"

/** Tap targets returned by the UI hit tests. */
enum {
	UI_HIT_NONE = 0,
	UI_HIT_TEXT = 1,
	UI_HIT_VOICE = 2,
	UI_HIT_WRITE = 3,
	UI_HIT_SESSIONS = 4,
	UI_HIT_SEND = 5,
	UI_HIT_CLEAR = 6,
	UI_HIT_BACK = 7,
	UI_HIT_NEW = 8,
	UI_HIT_CANVAS = 9,
	UI_HIT_SESSION = 20
};

void ui_init(void);
void ui_chat(void);
void ui_sessions(void);
void ui_ink(void);
void ui_pair(const char *status);
void ui_recording(int level, int seconds);
void ui_transcribing(void);

/** Chat screen tap target. */
int ui_chat_hit(int x, int y);
/** Session screen tap target: UI_HIT_SESSION + row, or another UI_HIT_*. */
int ui_sessions_hit(int x, int y);
/** Ink screen tap target. */
int ui_ink_hit(int x, int y);

/** Raw framebuffer drawing on a landscape 400x240 or 320x240 screen. */
void ui_raw_fill(u8 *framebuffer, int screen_width, int x, int y, int width, int height,
                 u8 red, u8 green, u8 blue);
void ui_raw_text(u8 *framebuffer, int screen_width, int x, int y, const char *text, int scale,
                 u8 red, u8 green, u8 blue);
void ui_raw_line(u8 *framebuffer, int screen_width, int x0, int y0, int x1, int y1, int thickness,
                 u8 red, u8 green, u8 blue);
