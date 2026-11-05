#pragma once

#include <3ds.h>
#include <stdbool.h>
#include <stddef.h>

/** Wire protocol this app speaks. */
#define APP_PROTOCOL 1

/** Bounded transcript the console keeps. */
#define MAX_SESSIONS 24
#define MAX_MESSAGES 80
#define MAX_MESSAGE_CHARS 2400
#define MAX_LINES 600
#define LINE_CHARS 51

/** Stylus canvas. */
#define INK_WIDTH 320
#define INK_HEIGHT 200
#define INK_MAX_POINTS 4096
#define INK_MAX_STROKES 64

/** Saved pairing and the most recent session. */
typedef struct {
	bool paired;
	char base[160];
	char token[96];
	char last[80];
} Config;

/** One session row from the bridge. */
typedef struct {
	char id[80];
	char title[80];
	bool running;
	bool blank;
	long updated_at;
} SessionInfo;

/** One displayed transcript entry. */
typedef struct {
	int seq;
	char role; /* 'u' or 'a' */
	char text[MAX_MESSAGE_CHARS];
} ChatMessage;

/** Stylus strokes: contiguous runs of points. */
typedef struct {
	s16 x[INK_MAX_POINTS];
	s16 y[INK_MAX_POINTS];
	u16 start[INK_MAX_STROKES];
	u16 count[INK_MAX_STROKES];
	int points;
	int strokes;
	bool drawing;
} InkCanvas;

/** Which full-screen surface owns input. */
typedef enum {
	SCREEN_PAIR,
	SCREEN_CHAT,
	SCREEN_SESSIONS,
	SCREEN_INK,
} Screen;

/** All mutable console state. */
typedef struct {
	Config config;
	Screen screen;
	SessionInfo sessions[MAX_SESSIONS];
	int session_count;
	int session_selected;
	int session_offset;
	char current[80];
	char title[80];
	ChatMessage messages[MAX_MESSAGES];
	int message_count;
	int cursor;
	char live[1600];
	bool running;
	bool loading;
	bool connected;
	bool needs_pairing;
	char error[192];
	char toast[128];
	u64 toast_until;
	u64 last_poll;
	int scroll;
	u32 revision;
	InkCanvas ink;
	bool camera_ready;
	char camera_error[128];
} AppState;

extern AppState app;

/** Replace the first displayable line of the error buffer. */
void app_error(const char *text);
/** Replace the toast and keep it visible briefly. */
void app_notify(const char *text);
/** Forget the current transcript and select a session. */
void app_select(const char *session_id, const char *title);
/** Find a session row by id, or NULL. */
const SessionInfo *app_session(const char *session_id);
