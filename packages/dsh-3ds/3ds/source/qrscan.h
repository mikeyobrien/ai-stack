#pragma once

#include <3ds.h>
#include <stdbool.h>
#include <stddef.h>

/** Start the outer camera and prepare QR recognition. */
bool qr_begin(void);

/**
 * Capture one frame, draw the preview, and try to decode a QR code.
 *
 * @param payload receives the decoded bytes
 * @param capacity payload buffer size
 * @returns true when a code was decoded this frame
 */
bool qr_frame(char *payload, size_t capacity);

/** Stop the camera and release recognition state. */
void qr_end(void);
