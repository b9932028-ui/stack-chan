/*
 * Native CoreS3 microphone capture for the USB microphone stream.
 *
 * Moddable's ESP32 AudioIn delivers samples through callbacks on the main XS
 * machine and keeps a 16 KB ring (about 256 ms of 16 kHz stereo). When the main
 * machine is busy rendering an animation it misses callbacks and the ring
 * silently overwrites speech. This module reads I2S on its own task into a
 * 3 second PSRAM ring that the USB worker drains directly, so capture no longer
 * depends on the main machine being responsive.
 *
 * The I2S configuration mirrors $(MODDABLE)/modules/io/audioin/esp32/audioin.c
 * (same port, pins and stereo slot layout) and, like AudioIn constructed with
 * `channels: 1`, keeps the first slot of every frame. Only one capture may be
 * open, and callers must hold `audio-input-lock` because AudioIn and the speaker
 * share the I2S port.
 *
 * open() and close() are called from the main machine and read() from the USB
 * worker machine. The ring is single-producer (capture task) / single-consumer
 * (read); a reader count keeps close() from freeing it under a running read().
 */

#include "xsmc.h"
#include "xsHost.h"
#include "mc.xs.h"
#include "mc.defines.h"

#include "driver/i2s_std.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <string.h>

#define CAPTURE_SAMPLE_RATE (MODDEF_AUDIOIN_SAMPLERATE)
#define CAPTURE_RING_SAMPLES (CAPTURE_SAMPLE_RATE * 3)
#define CAPTURE_READ_FRAMES (256)
#define CAPTURE_READ_TIMEOUT_MS (100)
#define CAPTURE_TASK_STACK_BYTES (4 * 1024)
/* Above the main XS task (4), the USB worker (5) and wake-word inference (6). */
#define CAPTURE_TASK_PRIORITY (10)
#define CAPTURE_TASK_CORE (0)

typedef struct {
	i2s_chan_handle_t handle;
	uint8_t enabled;
	TaskHandle_t task;
	SemaphoreHandle_t stopped;
	int16_t *ring;
	uint32_t ringRead;
	uint32_t ringWrite;
	uint32_t stop;
	uint32_t capturedSamples;
	uint32_t droppedSamples;
	uint32_t readErrors;
} MicrophoneCapture;

static MicrophoneCapture *gCapture = NULL;
static uint8_t gOpening = 0;
static uint32_t gReaders = 0;
static portMUX_TYPE gCaptureMux = portMUX_INITIALIZER_UNLOCKED;

static MicrophoneCapture *retainCapture(void)
{
	MicrophoneCapture *capture;
	portENTER_CRITICAL(&gCaptureMux);
	capture = gCapture;
	if (capture)
		gReaders += 1;
	portEXIT_CRITICAL(&gCaptureMux);
	return capture;
}

static void releaseCapture(void)
{
	portENTER_CRITICAL(&gCaptureMux);
	gReaders -= 1;
	portEXIT_CRITICAL(&gCaptureMux);
}

static void captureTask(void *parameter)
{
	MicrophoneCapture *capture = (MicrophoneCapture *)parameter;
	int16_t frames[CAPTURE_READ_FRAMES * 2];

	while (!__atomic_load_n(&capture->stop, __ATOMIC_ACQUIRE)) {
		size_t bytesRead = 0;
		esp_err_t err = i2s_channel_read(capture->handle, frames, sizeof(frames), &bytesRead,
			pdMS_TO_TICKS(CAPTURE_READ_TIMEOUT_MS));
		uint32_t count = bytesRead / (2 * sizeof(int16_t));
		uint32_t write;
		uint32_t read;
		uint32_t writable;
		uint32_t index;

		if ((ESP_OK != err) && (ESP_ERR_TIMEOUT != err)) {
			__atomic_add_fetch(&capture->readErrors, 1, __ATOMIC_RELAXED);
			vTaskDelay(1);
		}
		if (!count)
			continue;

		write = __atomic_load_n(&capture->ringWrite, __ATOMIC_RELAXED);
		read = __atomic_load_n(&capture->ringRead, __ATOMIC_ACQUIRE);
		writable = ((read > write) ? (read - write) : (CAPTURE_RING_SAMPLES - write + read)) - 1;
		for (index = 0; index < count; index++) {
			if (!writable) {
				/* The reader stalled for 3 seconds; keep the older audio in order. */
				__atomic_add_fetch(&capture->droppedSamples, count - index, __ATOMIC_RELAXED);
				break;
			}
			capture->ring[write] = frames[index * 2];
			write = (write + 1 == CAPTURE_RING_SAMPLES) ? 0 : write + 1;
			writable -= 1;
		}
		__atomic_store_n(&capture->ringWrite, write, __ATOMIC_RELEASE);
		__atomic_add_fetch(&capture->capturedSamples, count, __ATOMIC_RELAXED);
	}
	xSemaphoreGive(capture->stopped);
	vTaskDelete(NULL);
}

static void destroyCapture(MicrophoneCapture *capture)
{
	if (capture->task) {
		__atomic_store_n(&capture->stop, 1, __ATOMIC_RELEASE);
		xSemaphoreTake(capture->stopped, portMAX_DELAY);
		capture->task = NULL;
	}
	if (capture->handle) {
		if (capture->enabled)
			i2s_channel_disable(capture->handle);
		i2s_del_channel(capture->handle);
	}
	if (capture->stopped)
		vSemaphoreDelete(capture->stopped);
	heap_caps_free(capture->ring);
	heap_caps_free(capture);
}

static const char *openCapture(void)
{
	MicrophoneCapture *capture;
	uint8_t busy;
	i2s_chan_config_t channelConfig = I2S_CHANNEL_DEFAULT_CONFIG(MODDEF_AUDIOIN_I2S_NUM, I2S_ROLE_MASTER);
	i2s_std_config_t standardConfig = {
		.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(CAPTURE_SAMPLE_RATE),
#if MODDEF_AUDIOIN_I2S_FORMAT_I2S
		.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
#else
		.slot_cfg = I2S_STD_MSB_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
#endif
		.gpio_cfg = {
			.mclk = MODDEF_AUDIOIN_I2S_MCK_PIN,
			.bclk = MODDEF_AUDIOIN_I2S_BCK_PIN,
			.ws = MODDEF_AUDIOIN_I2S_LR_PIN,
			.dout = I2S_GPIO_UNUSED,
			.din = MODDEF_AUDIOIN_I2S_DATAIN,
			.invert_flags = {
				.mclk_inv = false,
				.bclk_inv = false,
				.ws_inv = false,
			},
		},
	};
	standardConfig.slot_cfg.slot_mask = I2S_STD_SLOT_BOTH;

	portENTER_CRITICAL(&gCaptureMux);
	busy = (NULL != gCapture) || gOpening || gReaders;
	if (!busy)
		gOpening = 1;
	portEXIT_CRITICAL(&gCaptureMux);
	if (busy)
		return "microphone capture is already open";

	capture = (MicrophoneCapture *)heap_caps_calloc(1, sizeof(MicrophoneCapture), MALLOC_CAP_8BIT);
	if (!capture)
		goto noMemory;
	capture->ring = (int16_t *)heap_caps_malloc(CAPTURE_RING_SAMPLES * sizeof(int16_t),
		MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
	capture->stopped = xSemaphoreCreateBinary();
	if (!capture->ring || !capture->stopped)
		goto noMemory;

	if (ESP_OK != i2s_new_channel(&channelConfig, NULL, &capture->handle)) {
		capture->handle = NULL;
		destroyCapture(capture);
		gOpening = 0;
		return "microphone I2S channel is unavailable";
	}
	if ((ESP_OK != i2s_channel_init_std_mode(capture->handle, &standardConfig)) ||
		(ESP_OK != i2s_channel_enable(capture->handle))) {
		destroyCapture(capture);
		gOpening = 0;
		return "microphone I2S configuration failed";
	}
	capture->enabled = 1;

	if (pdPASS != xTaskCreatePinnedToCore(captureTask, "usb-mic", CAPTURE_TASK_STACK_BYTES, capture,
		CAPTURE_TASK_PRIORITY, &capture->task, CAPTURE_TASK_CORE)) {
		capture->task = NULL;
		destroyCapture(capture);
		gOpening = 0;
		return "microphone capture task could not start";
	}

	portENTER_CRITICAL(&gCaptureMux);
	gCapture = capture;
	gOpening = 0;
	portEXIT_CRITICAL(&gCaptureMux);
	return NULL;

noMemory:
	if (capture)
		destroyCapture(capture);
	gOpening = 0;
	return "no memory for microphone capture";
}

void xs_stackchan_microphone_capture_open(xsMachine *the)
{
	const char *failure = openCapture();
	if (failure)
		xsUnknownError("%s", failure);
}

void xs_stackchan_microphone_capture_close(xsMachine *the)
{
	MicrophoneCapture *capture;
	(void)the;

	portENTER_CRITICAL(&gCaptureMux);
	capture = gCapture;
	gCapture = NULL;
	portEXIT_CRITICAL(&gCaptureMux);
	if (!capture)
		return;
	for (;;) {
		uint32_t readers;
		portENTER_CRITICAL(&gCaptureMux);
		readers = gReaders;
		portEXIT_CRITICAL(&gCaptureMux);
		if (!readers)
			break;
		vTaskDelay(1);
	}
	destroyCapture(capture);
}

void xs_stackchan_microphone_capture_read(xsMachine *the)
{
	uint8_t *target;
	xsUnsignedValue targetBytes;
	MicrophoneCapture *capture;
	uint32_t count = 0;

	xsmcGetBufferWritable(xsArg(0), (void **)&target, &targetBytes);
	capture = retainCapture();
	if (capture) {
		uint32_t read = __atomic_load_n(&capture->ringRead, __ATOMIC_RELAXED);
		uint32_t write = __atomic_load_n(&capture->ringWrite, __ATOMIC_ACQUIRE);
		uint32_t available = (write >= read) ? (write - read) : (CAPTURE_RING_SAMPLES - read + write);
		uint32_t capacity = targetBytes / sizeof(int16_t);
		uint32_t first;

		count = (available < capacity) ? available : capacity;
		first = CAPTURE_RING_SAMPLES - read;
		if (first > count)
			first = count;
		memcpy(target, capture->ring + read, first * sizeof(int16_t));
		memcpy(target + (first * sizeof(int16_t)), capture->ring, (count - first) * sizeof(int16_t));
		read = (read + count) % CAPTURE_RING_SAMPLES;
		__atomic_store_n(&capture->ringRead, read, __ATOMIC_RELEASE);
		releaseCapture();
	}
	xsmcSetInteger(xsResult, (xsIntegerValue)(count * sizeof(int16_t)));
}

static void setStat(xsMachine *the, const char *name, uint32_t value)
{
	xsmcSetInteger(xsVar(0), (xsIntegerValue)value);
	xsmcSet(xsResult, xsID(name), xsVar(0));
}

void xs_stackchan_microphone_capture_stats(xsMachine *the)
{
	MicrophoneCapture *capture = retainCapture();
	uint32_t available = 0;
	uint32_t captured = 0;
	uint32_t dropped = 0;
	uint32_t readErrors = 0;

	if (capture) {
		uint32_t read = __atomic_load_n(&capture->ringRead, __ATOMIC_ACQUIRE);
		uint32_t write = __atomic_load_n(&capture->ringWrite, __ATOMIC_ACQUIRE);
		available = (write >= read) ? (write - read) : (CAPTURE_RING_SAMPLES - read + write);
		captured = __atomic_load_n(&capture->capturedSamples, __ATOMIC_RELAXED);
		dropped = __atomic_load_n(&capture->droppedSamples, __ATOMIC_RELAXED);
		readErrors = __atomic_load_n(&capture->readErrors, __ATOMIC_RELAXED);
		releaseCapture();
	}

	/* Property names come from TypeScript types only, so look the IDs up at runtime. */
	xsmcVars(1);
	xsmcSetNewObject(xsResult);
	xsmcSetBoolean(xsVar(0), NULL != capture);
	xsmcSet(xsResult, xsID("open"), xsVar(0));
	setStat(the, "availableSamples", available);
	setStat(the, "capturedSamples", captured);
	setStat(the, "droppedSamples", dropped);
	setStat(the, "readErrors", readErrors);
}
