#pragma once

#include "app.h"

/** Verify the pairing and read the current session list. */
bool api_hello(void);

/** Refresh the session list. */
bool api_sessions(void);

/** Create a new session and select it. */
bool api_new_session(void);

/** Read transcript entries after the app cursor. */
bool api_state(void);

/** Send a typed message. */
bool api_prompt(const char *text);

/** Upload a WAV recording and let the Host transcribe it. */
bool api_voice(const void *wav, size_t length);

/** Upload the current stylus canvas as a handwritten note. */
bool api_ink(const InkCanvas *ink);
