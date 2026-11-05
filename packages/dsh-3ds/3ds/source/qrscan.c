#include "qrscan.h"
#include "ui.h"

#include <malloc.h>
#include <stdio.h>
#include <string.h>

#include "quirc.h"

#define CAMERA_WIDTH 400
#define CAMERA_HEIGHT 240
#define CAMERA_BYTES (CAMERA_WIDTH * CAMERA_HEIGHT * 2)

static struct quirc *recognizer;
static u8 *frame;
static bool started;
static bool camera_open;
static u32 transfer_bytes;
static Handle receive_event;

bool qr_begin(void) {
	if (started) return true;
	if (R_FAILED(camInit())) {
		snprintf(app.camera_error, sizeof(app.camera_error), "camera service failed");
		return false;
	}
	camera_open = true;
	Result result = CAMU_SetSize(SELECT_OUT1, SIZE_CTR_TOP_LCD, CONTEXT_A);
	if (R_FAILED(result)) {
		snprintf(app.camera_error, sizeof(app.camera_error), "camera size 0x%08lX", (unsigned long)result);
		camExit();
		camera_open = false;
		return false;
	}
	CAMU_SetOutputFormat(SELECT_OUT1, OUTPUT_RGB_565, CONTEXT_A);
	CAMU_SetFrameRate(SELECT_OUT1, FRAME_RATE_15);
	CAMU_SetNoiseFilter(SELECT_OUT1, true);
	CAMU_SetAutoExposure(SELECT_OUT1, true);
	CAMU_SetAutoWhiteBalance(SELECT_OUT1, true);
	CAMU_SetTrimming(PORT_CAM1, false);
	u32 max_bytes = 0;
	CAMU_GetMaxBytes(&max_bytes, CAMERA_WIDTH, CAMERA_HEIGHT);
	transfer_bytes = max_bytes;
	CAMU_SetTransferBytes(PORT_CAM1, max_bytes, CAMERA_WIDTH, CAMERA_HEIGHT);
	if (R_FAILED(CAMU_Activate(SELECT_OUT1))) {
		snprintf(app.camera_error, sizeof(app.camera_error), "camera could not start");
		qr_end();
		return false;
	}
	CAMU_ClearBuffer(PORT_CAM1);
	if (R_FAILED(CAMU_StartCapture(PORT_CAM1))) {
		snprintf(app.camera_error, sizeof(app.camera_error), "camera could not capture");
		qr_end();
		return false;
	}

	frame = (u8 *)memalign(0x80, CAMERA_BYTES);
	recognizer = quirc_new();
	if (frame == NULL || recognizer == NULL || quirc_resize(recognizer, CAMERA_WIDTH, CAMERA_HEIGHT) < 0) {
		snprintf(app.camera_error, sizeof(app.camera_error), "not enough memory for the camera");
		qr_end();
		return false;
	}
	started = true;
	app.camera_ready = true;
	return true;
}

void qr_end(void) {
	if (camera_open) {
		CAMU_StopCapture(PORT_CAM1);
		CAMU_Activate(SELECT_NONE);
		camExit();
		camera_open = false;
	}
	if (receive_event != 0) {
		svcCloseHandle(receive_event);
		receive_event = 0;
	}
	if (recognizer != NULL) {
		quirc_destroy(recognizer);
		recognizer = NULL;
	}
	free(frame);
	frame = NULL;
	started = false;
	app.camera_ready = false;
}

static void draw_preview(const u16 *pixels, const u8 *gray) {
	u8 *framebuffer = gfxGetFramebuffer(GFX_TOP, GFX_LEFT, NULL, NULL);
	for (int y = 0; y < CAMERA_HEIGHT; y++) {
		for (int x = 0; x < CAMERA_WIDTH; x++) {
			u16 value = pixels[y * CAMERA_WIDTH + x];
			u8 red = (u8)(((value >> 11) & 0x1f) * 255 / 31);
			u8 green = (u8)(((value >> 5) & 0x3f) * 255 / 63);
			u8 blue = (u8)((value & 0x1f) * 255 / 31);
			u32 offset = (u32)(x * 240 + (239 - y)) * 3;
			framebuffer[offset] = blue;
			framebuffer[offset + 1] = green;
			framebuffer[offset + 2] = red;
		}
	}
	(void)gray;
	ui_raw_fill(framebuffer, 400, 6, 6, 80, 18, 0, 0, 0);
	ui_raw_text(framebuffer, 400, 12, 11, "SCAN QR", 1, 255, 255, 255);
	/* Corner brackets make the aim point visible without covering the code. */
	ui_raw_fill(framebuffer, 400, 60, 40, 3, 24, 46, 139, 87);
	ui_raw_fill(framebuffer, 400, 60, 40, 24, 3, 46, 139, 87);
	ui_raw_fill(framebuffer, 400, 337, 40, 3, 24, 46, 139, 87);
	ui_raw_fill(framebuffer, 400, 316, 40, 24, 3, 46, 139, 87);
	ui_raw_fill(framebuffer, 400, 60, 197, 3, 24, 46, 139, 87);
	ui_raw_fill(framebuffer, 400, 60, 218, 24, 3, 46, 139, 87);
	ui_raw_fill(framebuffer, 400, 337, 197, 3, 24, 46, 139, 87);
	ui_raw_fill(framebuffer, 400, 316, 218, 24, 3, 46, 139, 87);
}

bool qr_frame(char *payload, size_t capacity) {
	if (!started) return false;
	receive_event = 0;
	Result result = CAMU_SetReceiving(&receive_event, frame, PORT_CAM1, CAMERA_BYTES, (s16)transfer_bytes);
	if (R_FAILED(result)) {
		snprintf(app.camera_error, sizeof(app.camera_error), "camera receive 0x%08lX", (unsigned long)result);
		return false;
	}
	result = svcWaitSynchronization(receive_event, 500000000LL);
	svcCloseHandle(receive_event);
	receive_event = 0;
	if (R_FAILED(result)) {
		/* The pending transfer may still land in the buffer: stop the
		 * capture, flush, and re-arm so the next frame cannot tear. */
		CAMU_StopCapture(PORT_CAM1);
		CAMU_ClearBuffer(PORT_CAM1);
		CAMU_StartCapture(PORT_CAM1);
		return false;
	}

	int width = 0;
	int height = 0;
	u8 *gray = quirc_begin(recognizer, &width, &height);
	if (gray == NULL) return false;
	u16 *pixels = (u16 *)frame;
	for (int y = 0; y < CAMERA_HEIGHT; y++) {
		for (int x = 0; x < CAMERA_WIDTH; x++) {
			u16 value = pixels[y * CAMERA_WIDTH + x];
			u16 red = (value >> 11) & 0x1f;
			u16 green = (value >> 5) & 0x3f;
			u16 blue = value & 0x1f;
			u8 red8 = (u8)((red << 3) | (red >> 2));
			u8 green8 = (u8)((green << 2) | (green >> 4));
			u8 blue8 = (u8)((blue << 3) | (blue >> 2));
			gray[y * width + x] = (u8)((red8 * 77 + green8 * 150 + blue8 * 29) >> 8);
		}
	}
	quirc_end(recognizer);
	draw_preview(pixels, gray);

	int count = quirc_count(recognizer);
	for (int index = 0; index < count; index++) {
		struct quirc_code code;
		struct quirc_data data;
		quirc_extract(recognizer, index, &code);
		quirc_decode_error_t error = quirc_decode(&code, &data);
		if (error != QUIRC_SUCCESS) continue;
		size_t length = (size_t)data.payload_len;
		if (length >= capacity) length = capacity - 1;
		memcpy(payload, data.payload, length);
		payload[length] = '\0';
		return true;
	}
	return false;
}
