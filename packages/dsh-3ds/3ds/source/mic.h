#pragma once

#include <3ds.h>
#include <stdbool.h>
#include <stddef.h>

/** Open the microphone and start sampling. */
bool mic_start(void);

/** Copy pending 16-bit mono samples into a caller buffer; returns bytes read. */
u32 mic_read(void *destination, u32 capacity);

/** Stop sampling and release the microphone. */
void mic_stop(void);

/** Resample captured PCM to 16 kHz mono and prepend a canonical WAV header. */
u8 *mic_wav(const s16 *samples, int count, size_t *length);
