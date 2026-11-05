#include "mic.h"

#include <malloc.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define MIC_BUFFER_SIZE 0x30000
#define MIC_RATE 16364.479

static u8 *shared;
static u32 shared_data_size;
static u32 read_offset;
static bool active;

bool mic_start(void) {
	if (active) return true;
	shared = (u8 *)memalign(0x1000, MIC_BUFFER_SIZE);
	if (shared == NULL) return false;
	if (R_FAILED(micInit(shared, MIC_BUFFER_SIZE))) {
		free(shared);
		shared = NULL;
		return false;
	}
	MICU_SetPower(true);
	MICU_SetGain(2);
	shared_data_size = micGetSampleDataSize();
	if (shared_data_size + 4 > MIC_BUFFER_SIZE) shared_data_size = MIC_BUFFER_SIZE - 4;
	read_offset = 0;
	Result result = MICU_StartSampling(MICU_ENCODING_PCM16_SIGNED, MICU_SAMPLE_RATE_16360, 0, shared_data_size, true);
	if (R_FAILED(result)) {
		micExit();
		free(shared);
		shared = NULL;
		return false;
	}
	active = true;
	return true;
}

u32 mic_read(void *destination, u32 capacity) {
	if (!active) return 0;
	u32 written = 0;
	u32 last = micGetLastSampleOffset();
	if (last > shared_data_size) last = shared_data_size;
	u8 *out = (u8 *)destination;
	while (written < capacity && read_offset != last) {
		out[written++] = shared[read_offset];
		read_offset = (read_offset + 1) % shared_data_size;
	}
	return written;
}

void mic_stop(void) {
	if (!active) return;
	MICU_StopSampling();
	MICU_SetPower(false);
	micExit();
	free(shared);
	shared = NULL;
	active = false;
}

static void put_u32(u8 *buffer, u32 value) {
	buffer[0] = (u8)(value & 0xff);
	buffer[1] = (u8)((value >> 8) & 0xff);
	buffer[2] = (u8)((value >> 16) & 0xff);
	buffer[3] = (u8)((value >> 24) & 0xff);
}

static void put_u16(u8 *buffer, u16 value) {
	buffer[0] = (u8)(value & 0xff);
	buffer[1] = (u8)((value >> 8) & 0xff);
}

u8 *mic_wav(const s16 *samples, int count, size_t *length) {
	if (samples == NULL || count <= 0) return NULL;
	int output_count = (int)((double)count * 16000.0 / MIC_RATE);
	if (output_count < 16) output_count = 16;
	size_t size = 44 + (size_t)output_count * 2;
	u8 *wav = (u8 *)malloc(size);
	if (wav == NULL) return NULL;
	memcpy(wav, "RIFF", 4);
	put_u32(wav + 4, (u32)(size - 8));
	memcpy(wav + 8, "WAVE", 4);
	memcpy(wav + 12, "fmt ", 4);
	put_u32(wav + 16, 16);
	put_u16(wav + 20, 1);
	put_u16(wav + 22, 1);
	put_u32(wav + 24, 16000);
	put_u32(wav + 28, 32000);
	put_u16(wav + 32, 2);
	put_u16(wav + 34, 16);
	memcpy(wav + 36, "data", 4);
	put_u32(wav + 40, (u32)(output_count * 2));
	double ratio = MIC_RATE / 16000.0;
	for (int index = 0; index < output_count; index++) {
		double position = index * ratio;
		int first = (int)position;
		if (first >= count - 1) first = count - 2;
		if (first < 0) first = 0;
		double fraction = position - first;
		double value = samples[first] * (1.0 - fraction) + samples[first + 1] * fraction;
		int sample = (int)lrint(value);
		if (sample > 32767) sample = 32767;
		if (sample < -32768) sample = -32768;
		put_u16(wav + 44 + (size_t)index * 2, (u16)(s16)sample);
	}
	*length = size;
	return wav;
}
