#include "ui.h"

#include <stdio.h>
#include <string.h>

#include "font8x8_basic.h"

#define TOP_WIDTH 50
#define BOTTOM_WIDTH 40
#define BODY_ROWS 26

typedef struct {
	char text[LINE_CHARS];
	u8 color;
} ChatLine;

static PrintConsole top_console;
static PrintConsole bottom_console;
static ChatLine lines[MAX_LINES];
static int line_count;
static u32 built_revision = 0;

static const char *const COLORS[] = {
	"\x1b[0;37m",
	"\x1b[0;36m",
	"\x1b[0;32m",
	"\x1b[0;33m",
	"\x1b[0;31m",
	"\x1b[0;37;1m",
};

enum { COLOR_TEXT = 0, COLOR_USER = 1, COLOR_ASSISTANT = 2, COLOR_LIVE = 3, COLOR_ERROR = 4, COLOR_BRIGHT = 5 };

void ui_init(void) {
	consoleInit(GFX_TOP, &top_console);
	consoleInit(GFX_BOTTOM, &bottom_console);
	consoleSetWindow(&top_console, 0, 0, TOP_WIDTH, 30);
	consoleSetWindow(&bottom_console, 0, 0, BOTTOM_WIDTH, 30);
	consoleSelect(&top_console);
}

/** Print one complete line in a console at a zero-based row. */
static void put_line(PrintConsole *console, int row, const char *text) {
	consoleSelect(console);
	printf("\x1b[%d;1H\x1b[0m%s\x1b[0m", row + 1, text);
}

static void clear(PrintConsole *console) {
	consoleSelect(console);
	consoleClear();
}

/** Keep a line to the console width, replacing non-Latin bytes. */
static void fit(char *destination, const char *source, int width) {
	int written = 0;
	for (const unsigned char *cursor = (const unsigned char *)source; *cursor != '\0' && written < width; cursor++) {
		unsigned char value = *cursor;
		if (value >= 0x80) {
			if ((value & 0xC0) == 0xC0) destination[written++] = '?';
			continue;
		}
		if (value < 0x20) destination[written++] = ' ';
		else destination[written++] = (char)value;
	}
	destination[written] = '\0';
}

static void push_line(const char *text, u8 color) {
	if (line_count >= MAX_LINES) {
		memmove(&lines[0], &lines[1], sizeof(ChatLine) * (MAX_LINES - 1));
		line_count = MAX_LINES - 1;
	}
	ChatLine *line = &lines[line_count++];
	snprintf(line->text, sizeof(line->text), "%s", text);
	line->color = color;
}

static void push_blank(void) {
	if (line_count == 0) return;
	if (lines[line_count - 1].text[0] == '\0') return;
	push_line("", COLOR_TEXT);
}

/** Word-wrap one message beneath a label, keeping its colour. */
static void wrap_message(const char *prefix, const char *text, u8 color) {
	char line[LINE_CHARS];
	size_t indent = strlen(prefix);
	size_t length = 0;
	size_t last_space = 0;
	line[0] = '\0';
	snprintf(line, sizeof(line), "%s", prefix);
	length = strlen(line);
	if (indent > TOP_WIDTH - 4) indent = TOP_WIDTH - 4;

	for (const unsigned char *cursor = (const unsigned char *)text;; cursor++) {
		unsigned char raw = *cursor;
		char output = '\0';
		bool end = raw == 0;
		if (!end) {
			if (raw == '\n') output = '\n';
			else if (raw == '\t' || raw == '\r') output = ' ';
			else if (raw < 0x20) output = ' ';
			else if (raw < 0x7f) output = (char)raw;
			else if ((raw & 0xC0) == 0xC0) output = '?';
			else continue;
		}
		if (end || output == '\n') {
			if (length > indent || line_count == 0) {
				line[length] = '\0';
				push_line(line, color);
			}
			length = indent;
			memset(line, ' ', indent);
			line[length] = '\0';
			last_space = 0;
			if (end) break;
			continue;
		}
		if (length >= TOP_WIDTH - 1) {
			if (last_space > indent) {
				char remainder[LINE_CHARS];
				size_t remain = length - last_space - 1;
				memcpy(remainder, line + last_space + 1, remain);
				remainder[remain] = '\0';
				line[last_space] = '\0';
				push_line(line, color);
				length = indent;
				memset(line, ' ', indent);
				memcpy(line + indent, remainder, remain);
				length = indent + remain;
				line[length] = '\0';
				last_space = 0;
			} else {
				line[length] = '\0';
				push_line(line, color);
				length = indent;
				memset(line, ' ', indent);
				line[length] = '\0';
				last_space = 0;
			}
		}
		if (output == ' ') last_space = length;
		line[length++] = output;
		line[length] = '\0';
	}
}

/** Build the complete wrapped transcript for the top screen. */
static void build_lines(void) {
	line_count = 0;
	for (int index = 0; index < app.message_count; index++) {
		ChatMessage *message = &app.messages[index];
		push_blank();
		wrap_message(message->role == 'u' ? "You: " : "DSH: ", message->text,
			message->role == 'u' ? COLOR_USER : COLOR_ASSISTANT);
	}
	if (app.live[0] != '\0') {
		push_blank();
		wrap_message("DSH: ", app.live, COLOR_LIVE);
	} else if (app.running && app.message_count == 0) {
		push_line("Working...", COLOR_LIVE);
	}
	if (app.loading && line_count == 0) push_line("Loading...", COLOR_TEXT);
}

static const char *status_text(char *buffer, size_t size) {
	u64 now = osGetTime();
	if (app.error[0] != '\0') {
		snprintf(buffer, size, "! %s", app.error);
		return buffer;
	}
	if (app.toast[0] != '\0' && now < app.toast_until) {
		snprintf(buffer, size, "%s", app.toast);
		return buffer;
	}
	if (app.loading) snprintf(buffer, size, "Loading...");
	else if (app.running) snprintf(buffer, size, "Working");
	else if (app.connected) snprintf(buffer, size, "Linked");
	else snprintf(buffer, size, "Offline");
	return buffer;
}

void ui_chat(void) {
	if (built_revision != app.revision) {
		build_lines();
		built_revision = app.revision;
	}
	char title[TOP_WIDTH + 1];
	snprintf(title, sizeof(title), " 3DS LINK  %s", app.title[0] != '\0' ? app.title : "New session");
	title[TOP_WIDTH] = '\0';

	clear(&top_console);
	char header[TOP_WIDTH + 16];
	snprintf(header, sizeof(header), "\x1b[36;1m%s\x1b[0m", title);
	put_line(&top_console, 0, header);
	put_line(&top_console, 1, "\x1b[0;37m--------------------------------------------------\x1b[0m");

	int visible = BODY_ROWS;
	int maximum = line_count > visible ? line_count - visible : 0;
	if (app.scroll < 0) app.scroll = 0;
	if (app.scroll > maximum) app.scroll = maximum;
	int start = line_count - visible - app.scroll;
	if (start < 0) start = 0;
	for (int row = 0; row < visible && start + row < line_count; row++) {
		ChatLine *line = &lines[start + row];
		char fitted[LINE_CHARS];
		fit(fitted, line->text, TOP_WIDTH);
		char rendered[LINE_CHARS + 16];
		snprintf(rendered, sizeof(rendered), "%s%s", COLORS[line->color], fitted);
		put_line(&top_console, 2 + row, rendered);
	}

	char status[TOP_WIDTH + 20];
	char status_plain[TOP_WIDTH + 1];
	status_text(status_plain, sizeof(status_plain));
	u8 color = app.error[0] != '\0' ? COLOR_ERROR
		: (app.toast[0] != '\0' && osGetTime() < app.toast_until) ? COLOR_LIVE
		: app.running ? COLOR_ASSISTANT : COLOR_TEXT;
	snprintf(status, sizeof(status), "%s%s\x1b[0m", COLORS[color], status_plain);
	put_line(&top_console, 28, status);
	if (app.scroll > 0) put_line(&top_console, 29, "\x1b[0;37m^ older messages\x1b[0m");

	clear(&bottom_console);
	char bottom_title[41];
	snprintf(bottom_title, sizeof(bottom_title), "%s", app.title[0] != '\0' ? app.title : "New session");
	put_line(&bottom_console, 0, "\x1b[36;1m3DS LINK\x1b[0m");
	put_line(&bottom_console, 2, bottom_title);
	char bottom_status[41];
	status_text(bottom_status, sizeof(bottom_status));
	put_line(&bottom_console, 4, bottom_status);

	put_line(&bottom_console, 16, "\x1b[36m+----------------+  +----------------+\x1b[0m");
	put_line(&bottom_console, 17, "\x1b[36m|                |  |                |\x1b[0m");
	put_line(&bottom_console, 18, "\x1b[36m| A  Text        |  | Y  Voice       |\x1b[0m");
	put_line(&bottom_console, 19, "\x1b[36m+----------------+  +----------------+\x1b[0m");
	put_line(&bottom_console, 21, "\x1b[33m+----------------+  +----------------+\x1b[0m");
	put_line(&bottom_console, 22, "\x1b[33m|                |  |                |\x1b[0m");
	put_line(&bottom_console, 23, "\x1b[33m| X  Note        |  | B  Sessions    |\x1b[0m");
	put_line(&bottom_console, 24, "\x1b[33m+----------------+  +----------------+\x1b[0m");
	put_line(&bottom_console, 27, "\x1b[0;37mSTART  Exit\x1b[0m");
}

static const char *session_label(const SessionInfo *session) {
	if (session->title[0] != '\0') return session->title;
	if (session->blank) return "New session";
	return "Untitled";
}

void ui_sessions(void) {
	clear(&top_console);
	put_line(&top_console, 0, "\x1b[36;1m Sessions\x1b[0m");
	char summary[TOP_WIDTH + 1];
	snprintf(summary, sizeof(summary), " %d available", app.session_count);
	put_line(&top_console, 1, summary);
	if (app.error[0] != '\0') {
		char error[TOP_WIDTH + 20];
		snprintf(error, sizeof(error), "\x1b[31m ! %s\x1b[0m", app.error);
		put_line(&top_console, 3, error);
	}

	clear(&bottom_console);
	put_line(&bottom_console, 0, "\x1b[36;1mSessions\x1b[0m");
	int visible = 8;
	if (app.session_offset > app.session_count - visible) {
		app.session_offset = app.session_count - visible;
		if (app.session_offset < 0) app.session_offset = 0;
	}
	for (int row = 0; row < visible; row++) {
		int index = app.session_offset + row;
		if (index >= app.session_count) break;
		const SessionInfo *session = &app.sessions[index];
		char title[BOTTOM_WIDTH + 1];
		fit(title, session_label(session), BOTTOM_WIDTH - 2);
		char rendered[BOTTOM_WIDTH + 24];
		if (index == app.session_selected) {
			snprintf(rendered, sizeof(rendered), "\x1b[7m> %s\x1b[0m", title);
		} else {
			snprintf(rendered, sizeof(rendered), "  %s", title);
		}
		put_line(&bottom_console, 2 + row * 3, rendered);
		char state[BOTTOM_WIDTH + 1];
		if (session->running) snprintf(state, sizeof(state), "  \x1b[32;1mworking\x1b[0m");
		else if (session->blank) snprintf(state, sizeof(state), "  \x1b[33;1mnew\x1b[0m");
		else snprintf(state, sizeof(state), "  \x1b[37midle\x1b[0m");
		put_line(&bottom_console, 3 + row * 3, state);
	}
	if (app.session_count == 0) put_line(&bottom_console, 3, "  \x1b[37mNo sessions\x1b[0m");
	put_line(&bottom_console, 27, "\x1b[36m[X] New\x1b[0m          \x1b[37m[B] Back\x1b[0m");
	put_line(&bottom_console, 28, "\x1b[0;37mUp/Down select, A open\x1b[0m");
}

void ui_ink(void) {
	clear(&top_console);
	put_line(&top_console, 0, "\x1b[36;1m 3DS LINK  Write\x1b[0m");
	put_line(&top_console, 2, " A  Send");
	put_line(&top_console, 3, " X  Clear");
	put_line(&top_console, 4, " B  Back");
	char count[TOP_WIDTH + 1];
	snprintf(count, sizeof(count), " %d stroke%s", app.ink.strokes, app.ink.strokes == 1 ? "" : "s");
	put_line(&top_console, 6, count);
	if (app.error[0] != '\0') {
		char error[TOP_WIDTH + 1];
		fit(error, app.error, TOP_WIDTH - 2);
		put_line(&top_console, 8, error);
	}

	u8 *framebuffer = gfxGetFramebuffer(GFX_BOTTOM, GFX_LEFT, NULL, NULL);
	ui_raw_fill(framebuffer, 320, 0, 0, 320, 240, 252, 252, 248);
	ui_raw_fill(framebuffer, 320, 0, 202, 320, 2, 200, 200, 200);
	for (int stroke = 0; stroke < app.ink.strokes; stroke++) {
		int start = app.ink.start[stroke];
		int count_points = app.ink.count[stroke];
		for (int point = 1; point < count_points; point++) {
			ui_raw_line(framebuffer, 320,
				app.ink.x[start + point - 1], app.ink.y[start + point - 1],
				app.ink.x[start + point], app.ink.y[start + point], 2, 24, 24, 24);
		}
	}

	ui_raw_fill(framebuffer, 320, 8, 208, 96, 28, 46, 139, 87);
	ui_raw_fill(framebuffer, 320, 112, 208, 96, 28, 90, 90, 90);
	ui_raw_fill(framebuffer, 320, 216, 208, 96, 28, 170, 60, 60);
	ui_raw_text(framebuffer, 320, 8 + 16, 208 + 6, "SEND", 2, 255, 255, 255);
	ui_raw_text(framebuffer, 320, 112 + 8, 208 + 6, "CLEAR", 2, 255, 255, 255);
	ui_raw_text(framebuffer, 320, 216 + 16, 208 + 6, "BACK", 2, 255, 255, 255);
}

void ui_pair(const char *status) {
	if (!app.camera_ready) {
		clear(&top_console);
		put_line(&top_console, 4, "\x1b[33;1m Camera unavailable\x1b[0m");
		if (app.camera_error[0] != '\0') {
			char error[TOP_WIDTH + 1];
			fit(error, app.camera_error, TOP_WIDTH - 2);
			put_line(&top_console, 6, error);
		}
	}
	clear(&bottom_console);
	put_line(&bottom_console, 0, "\x1b[36;1m3DS LINK\x1b[0m");
	put_line(&bottom_console, 2, "Scan the code in");
	put_line(&bottom_console, 3, "Settings > 3DS Link");
	if (app.config.paired) put_line(&bottom_console, 6, "A  Retry");
	put_line(&bottom_console, 7, "X  Enter address");
	put_line(&bottom_console, 8, "START  Exit");
	if (status != NULL) {
		char fitted[41];
		fit(fitted, status, 40);
		put_line(&bottom_console, 10, fitted);
	}
	if (app.error[0] != '\0') {
		char fitted[41];
		fit(fitted, app.error, 40);
		char rendered[64];
		snprintf(rendered, sizeof(rendered), "\x1b[31m%s\x1b[0m", fitted);
		put_line(&bottom_console, 12, rendered);
	}
}

void ui_recording(int level, int seconds) {
	clear(&top_console);
	put_line(&top_console, 0, "\x1b[31;1m REC\x1b[0m");
	put_line(&top_console, 2, " Release to send");
	char bar[42];
	int filled = level * 24 / 100;
	if (filled < 0) filled = 0;
	if (filled > 24) filled = 24;
	for (int index = 0; index < 24; index++) bar[index] = index < filled ? '#' : '.';
	bar[24] = '\0';
	put_line(&top_console, 4, bar);
	char time[TOP_WIDTH + 1];
	snprintf(time, sizeof(time), " %d.%ds", seconds / 10, seconds % 10);
	put_line(&top_console, 6, time);
	clear(&bottom_console);
	put_line(&bottom_console, 0, "\x1b[31;1mRecording\x1b[0m");
	put_line(&bottom_console, 2, "Y  hold to talk");
}

void ui_transcribing(void) {
	clear(&top_console);
	put_line(&top_console, 0, "\x1b[33;1m Transcribing\x1b[0m");
	clear(&bottom_console);
	put_line(&bottom_console, 0, "\x1b[33;1mTranscribing\x1b[0m");
}

int ui_chat_hit(int x, int y) {
	if (x >= 8 && x < 160 && y >= 128 && y < 160) return UI_HIT_TEXT;
	if (x >= 168 && x < 320 && y >= 128 && y < 160) return UI_HIT_VOICE;
	if (x >= 8 && x < 160 && y >= 168 && y < 200) return UI_HIT_WRITE;
	if (x >= 168 && x < 320 && y >= 168 && y < 200) return UI_HIT_SESSIONS;
	return UI_HIT_NONE;
}

int ui_sessions_hit(int x, int y) {
	if (y >= 216 && y < 240) {
		if (x >= 8 && x < 152) return UI_HIT_NEW;
		if (x >= 168 && x < 312) return UI_HIT_BACK;
		return UI_HIT_NONE;
	}
	for (int row = 0; row < 8; row++) {
		int top = 16 + row * 24;
		if (y >= top && y < top + 24 && x >= 8 && x < 312) return UI_HIT_SESSION + row;
	}
	return UI_HIT_NONE;
}

int ui_ink_hit(int x, int y) {
	if (y >= 204) {
		if (x >= 8 && x < 104) return UI_HIT_SEND;
		if (x >= 112 && x < 208) return UI_HIT_CLEAR;
		if (x >= 216 && x < 312) return UI_HIT_BACK;
		return UI_HIT_NONE;
	}
	if (y >= 0 && y < INK_HEIGHT && x >= 0 && x < INK_WIDTH) return UI_HIT_CANVAS;
	return UI_HIT_NONE;
}

static void pixel(u8 *framebuffer, int screen_width, int x, int y, u8 red, u8 green, u8 blue) {
	if (x < 0 || y < 0 || x >= screen_width || y >= 240) return;
	u32 offset = (u32)(x * 240 + (239 - y)) * 3;
	framebuffer[offset] = blue;
	framebuffer[offset + 1] = green;
	framebuffer[offset + 2] = red;
}

void ui_raw_fill(u8 *framebuffer, int screen_width, int x, int y, int width, int height,
                 u8 red, u8 green, u8 blue) {
	for (int row = 0; row < height; row++) {
		for (int column = 0; column < width; column++) {
			pixel(framebuffer, screen_width, x + column, y + row, red, green, blue);
		}
	}
}

void ui_raw_text(u8 *framebuffer, int screen_width, int x, int y, const char *text, int scale,
                 u8 red, u8 green, u8 blue) {
	if (scale < 1) scale = 1;
	int cursor = x;
	for (const unsigned char *character = (const unsigned char *)text; *character != '\0'; character++) {
		unsigned char value = *character;
		if (value < 0x20 || value >= 0x7f) {
			cursor += 8 * scale;
			continue;
		}
		const char *glyph = font8x8_basic[value];
		for (int row = 0; row < 8; row++) {
			for (int column = 0; column < 8; column++) {
				if ((glyph[row] & (1 << column)) == 0) continue;
				ui_raw_fill(framebuffer, screen_width, cursor + column * scale, y + row * scale, scale, scale, red, green, blue);
			}
		}
		cursor += 8 * scale;
	}
}

void ui_raw_line(u8 *framebuffer, int screen_width, int x0, int y0, int x1, int y1, int thickness,
                 u8 red, u8 green, u8 blue) {
	int dx = x1 - x0;
	int dy = y1 - y0;
	int steps = (dx < 0 ? -dx : dx) > (dy < 0 ? -dy : dy) ? (dx < 0 ? -dx : dx) : (dy < 0 ? -dy : dy);
	if (steps == 0) steps = 1;
	for (int step = 0; step <= steps; step++) {
		int x = x0 + dx * step / steps;
		int y = y0 + dy * step / steps;
		ui_raw_fill(framebuffer, screen_width, x - thickness / 2, y - thickness / 2, thickness, thickness, red, green, blue);
	}
}
