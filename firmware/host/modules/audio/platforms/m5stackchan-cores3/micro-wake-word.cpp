/*
 * Minimal microWakeWord runtime for the M5Stack CoreS3.
 *
 * Model and post-processing parameters come from the Apache-2.0
 * esphome/micro-wake-word-models v2 "Okay Nabu" manifest. The feature
 * extraction and streaming inference behavior intentionally match ESPHome's
 * production component, without taking a dependency on the ESPHome runtime.
 */

#define TF_LITE_STATIC_MEMORY 1
#define TF_LITE_DISABLE_X86_NEON 1
#define ESP_NN 1

#include "xsHost.h"
#include "xsmc.h"
#include "mc.xs.h"
#include "mc.defines.h"

#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "frontend.h"
#include "frontend_util.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "tensorflow/lite/micro/micro_allocator.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"
#include "tensorflow/lite/schema/schema_generated.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <new>

/*
 * Buffers handed to feed() are already mono. The CoreS3 I2S slot layout is fixed
 * stereo at build time (MODDEF_AUDIOIN_NUMCHANNELS == 2), but AudioIn.read()
 * strips a channel when constructed with `channels: 1` -- see `xs_audioin_read`
 * in $(MODDABLE)/modules/io/audioin/esp32/audioin.c ("strip left channel").
 * Do not de-interleave again here: doing so halves the effective sample rate to
 * 8 kHz and the model silently stops matching.
 */
#define MWW_INPUT_CHANNELS (1)
#define MWW_SAMPLE_RATE (16000)
#define MWW_FEATURE_SIZE (40)
#define MWW_RING_SAMPLES (16000)
#define MWW_TASK_READ_SAMPLES (512)
#define MWW_TASK_STACK_BYTES (10 * 1024)
#define MWW_TASK_PRIORITY (tskIDLE_PRIORITY + 3)
#define MWW_TASK_CORE (1)
#define MWW_VARIABLE_ARENA_BYTES (10 * 1024)
/* The upstream 26,080-byte manifest is low on some TFLM/esp-nn versions. */
#define MWW_TENSOR_ARENA_BYTES (40 * 1024)
#define MWW_PROBABILITY_CUTOFF ((uint8_t)247) /* floor(0.97 * 255) */
#define MWW_SLIDING_WINDOW_SIZE (5)
#define MWW_MIN_SLICES_BEFORE_DETECTION (100)

typedef tflite::MicroMutableOpResolver<20> MicroWakeWordResolver;

typedef struct {
	uint8_t *modelData;
	uint32_t modelBytes;
	uint8_t *variableArena;
	uint8_t *tensorArena;
	MicroWakeWordResolver *resolver;
	tflite::MicroInterpreter *interpreter;
	tflite::MicroAllocator *allocator;
	tflite::MicroResourceVariables *variables;
	struct FrontendState frontendState;
	uint8_t frontendReady;
	int16_t *ring;
	uint32_t ringRead;
	uint32_t ringWrite;
	SemaphoreHandle_t dataAvailable;
	SemaphoreHandle_t stopped;
	TaskHandle_t task;
	uint32_t stop;
	uint32_t detected;
	uint32_t error;
	uint32_t droppedSamples;
	uint32_t featureCount;
	uint32_t invokeCount;
	uint32_t frontendMicros;
	uint32_t invokeMicros;
	uint32_t tensorArenaUsed;
	uint32_t pcmSampleCount;
	uint64_t pcmAbsoluteTotal;
	uint32_t pcmPeak;
	uint32_t lastProbability;
	uint32_t maxProbability;
	uint32_t slidingAverageProbability;
	uint8_t probabilities[MWW_SLIDING_WINDOW_SIZE];
	uint8_t probabilityIndex;
	int16_t ignoreWindows;
	uint8_t strideStep;
} xsMicroWakeWordRecord;

static uint32_t ringReadable(xsMicroWakeWordRecord *recognizer)
{
	uint32_t read = __atomic_load_n(&recognizer->ringRead, __ATOMIC_ACQUIRE);
	uint32_t write = __atomic_load_n(&recognizer->ringWrite, __ATOMIC_ACQUIRE);
	return (write >= read) ? (write - read) : (MWW_RING_SAMPLES - read + write);
}

static uint32_t ringTake(xsMicroWakeWordRecord *recognizer, int16_t *output, uint32_t capacity)
{
	uint32_t count = ringReadable(recognizer);
	uint32_t read;
	uint32_t index;
	if (count > capacity)
		count = capacity;
	if (!count)
		return 0;
	read = __atomic_load_n(&recognizer->ringRead, __ATOMIC_RELAXED);
	for (index = 0; index < count; index++) {
		output[index] = recognizer->ring[read];
		read = (read + 1 == MWW_RING_SAMPLES) ? 0 : read + 1;
	}
	__atomic_store_n(&recognizer->ringRead, read, __ATOMIC_RELEASE);
	return count;
}

static uint8_t registerStreamingOps(MicroWakeWordResolver *resolver)
{
	return (resolver->AddCallOnce() == kTfLiteOk) &&
		(resolver->AddVarHandle() == kTfLiteOk) &&
		(resolver->AddReshape() == kTfLiteOk) &&
		(resolver->AddReadVariable() == kTfLiteOk) &&
		(resolver->AddStridedSlice() == kTfLiteOk) &&
		(resolver->AddConcatenation() == kTfLiteOk) &&
		(resolver->AddAssignVariable() == kTfLiteOk) &&
		(resolver->AddConv2D() == kTfLiteOk) &&
		(resolver->AddMul() == kTfLiteOk) &&
		(resolver->AddAdd() == kTfLiteOk) &&
		(resolver->AddMean() == kTfLiteOk) &&
		(resolver->AddFullyConnected() == kTfLiteOk) &&
		(resolver->AddLogistic() == kTfLiteOk) &&
		(resolver->AddQuantize() == kTfLiteOk) &&
		(resolver->AddDepthwiseConv2D() == kTfLiteOk) &&
		(resolver->AddAveragePool2D() == kTfLiteOk) &&
		(resolver->AddMaxPool2D() == kTfLiteOk) &&
		(resolver->AddPad() == kTfLiteOk) &&
		(resolver->AddPack() == kTfLiteOk) &&
		(resolver->AddSplitV() == kTfLiteOk);
}

static void resetProbabilities(xsMicroWakeWordRecord *recognizer)
{
	std::memset(recognizer->probabilities, 0, sizeof(recognizer->probabilities));
	recognizer->probabilityIndex = 0;
	recognizer->ignoreWindows = -MWW_MIN_SLICES_BEFORE_DETECTION;
}

static uint8_t runInference(xsMicroWakeWordRecord *recognizer, const int8_t *features)
{
	TfLiteTensor *input = recognizer->interpreter->input(0);
	uint8_t stride = input->dims->data[1];
	uint8_t *probabilities = recognizer->probabilities;
	int64_t startedAt;
	uint32_t sum = 0;
	uint32_t index;

	recognizer->strideStep %= stride;
	std::memmove(tflite::GetTensorData<int8_t>(input) + (MWW_FEATURE_SIZE * recognizer->strideStep),
		features, MWW_FEATURE_SIZE);
	recognizer->strideStep += 1;
	if (recognizer->strideStep < stride)
		return 1;

	startedAt = esp_timer_get_time();
	if (recognizer->interpreter->Invoke() != kTfLiteOk)
		return 0;
	recognizer->invokeMicros += (uint32_t)(esp_timer_get_time() - startedAt);
	recognizer->invokeCount += 1;
	recognizer->probabilityIndex = (recognizer->probabilityIndex + 1) % MWW_SLIDING_WINDOW_SIZE;
	probabilities[recognizer->probabilityIndex] = recognizer->interpreter->output(0)->data.uint8[0];
	__atomic_store_n(&recognizer->lastProbability, probabilities[recognizer->probabilityIndex], __ATOMIC_RELAXED);
	uint32_t maximum = __atomic_load_n(&recognizer->maxProbability, __ATOMIC_RELAXED);
	while ((probabilities[recognizer->probabilityIndex] > maximum) &&
		!__atomic_compare_exchange_n(&recognizer->maxProbability, &maximum,
			probabilities[recognizer->probabilityIndex], 1, __ATOMIC_RELAXED, __ATOMIC_RELAXED))
		;
	for (index = 0; index < MWW_SLIDING_WINDOW_SIZE; index++)
		sum += probabilities[index];
	__atomic_store_n(&recognizer->slidingAverageProbability,
		sum / MWW_SLIDING_WINDOW_SIZE, __ATOMIC_RELAXED);

	if ((probabilities[recognizer->probabilityIndex] < MWW_PROBABILITY_CUTOFF) &&
		(recognizer->ignoreWindows < 0))
		recognizer->ignoreWindows += 1;
	if (recognizer->ignoreWindows < 0)
		return 1;

	if (sum > (MWW_PROBABILITY_CUTOFF * MWW_SLIDING_WINDOW_SIZE)) {
		__atomic_store_n(&recognizer->detected, 1, __ATOMIC_RELEASE);
		resetProbabilities(recognizer);
	}
	return 1;
}

static uint8_t generateFeature(xsMicroWakeWordRecord *recognizer, const int16_t *samples,
	uint32_t available, uint32_t *consumed)
{
	struct FrontendOutput output;
	int8_t features[MWW_FEATURE_SIZE];
	int64_t startedAt = esp_timer_get_time();
	size_t processed = 0;
	uint32_t index;

	output = FrontendProcessSamples(&recognizer->frontendState, samples, available, &processed);
	recognizer->frontendMicros += (uint32_t)(esp_timer_get_time() - startedAt);
	*consumed = (uint32_t)processed;
	if (!output.size)
		return 1;
	if (output.size != MWW_FEATURE_SIZE)
		return 0;

	for (index = 0; index < MWW_FEATURE_SIZE; index++) {
		int32_t value = ((output.values[index] * 256) + 333) / 666;
		value += INT8_MIN;
		features[index] = (int8_t)std::max<int32_t>(INT8_MIN, std::min<int32_t>(INT8_MAX, value));
	}
	recognizer->featureCount += 1;
	return runInference(recognizer, features);
}

static void microWakeWordTask(void *parameter)
{
	xsMicroWakeWordRecord *recognizer = (xsMicroWakeWordRecord *)parameter;
	int16_t samples[MWW_TASK_READ_SAMPLES];

	while (!__atomic_load_n(&recognizer->stop, __ATOMIC_ACQUIRE)) {
		xSemaphoreTake(recognizer->dataAvailable, pdMS_TO_TICKS(20));
		while (!__atomic_load_n(&recognizer->stop, __ATOMIC_ACQUIRE)) {
			uint32_t count = ringTake(recognizer, samples, MWW_TASK_READ_SAMPLES);
			uint32_t offset = 0;
			if (!count)
				break;
			while (offset < count) {
				uint32_t consumed = 0;
				if (!generateFeature(recognizer, samples + offset, count - offset, &consumed) || !consumed) {
					__atomic_store_n(&recognizer->error, 1, __ATOMIC_RELEASE);
					__atomic_store_n(&recognizer->stop, 1, __ATOMIC_RELEASE);
					break;
				}
				offset += consumed;
			}
		}
	}
	xSemaphoreGive(recognizer->stopped);
	vTaskDelete(NULL);
}

static uint8_t initializeFrontend(xsMicroWakeWordRecord *recognizer)
{
	struct FrontendConfig config;
	FrontendFillConfigWithDefaults(&config);
	config.window.size_ms = 30;
	config.window.step_size_ms = 10;
	config.filterbank.num_channels = MWW_FEATURE_SIZE;
	config.filterbank.lower_band_limit = 125.0f;
	config.filterbank.upper_band_limit = 7500.0f;
	config.noise_reduction.smoothing_bits = 10;
	config.noise_reduction.even_smoothing = 0.025f;
	config.noise_reduction.odd_smoothing = 0.06f;
	config.noise_reduction.min_signal_remaining = 0.05f;
	config.pcan_gain_control.enable_pcan = true;
	config.pcan_gain_control.strength = 0.95f;
	config.pcan_gain_control.offset = 80.0f;
	config.pcan_gain_control.gain_bits = 21;
	config.log_scale.enable_log = true;
	config.log_scale.scale_shift = 6;
	if (!FrontendPopulateState(&config, &recognizer->frontendState, MWW_SAMPLE_RATE))
		return 0;
	recognizer->frontendReady = 1;
	return 1;
}

static uint8_t initializeModel(xsMicroWakeWordRecord *recognizer)
{
	const tflite::Model *model;
	TfLiteTensor *input;
	TfLiteTensor *output;

	recognizer->resolver = new (std::nothrow) MicroWakeWordResolver();
	if (!recognizer->resolver || !registerStreamingOps(recognizer->resolver))
		return 0;
	recognizer->variableArena = (uint8_t *)heap_caps_malloc(MWW_VARIABLE_ARENA_BYTES,
		MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
	recognizer->tensorArena = (uint8_t *)heap_caps_malloc(MWW_TENSOR_ARENA_BYTES,
		MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
	if (!recognizer->variableArena || !recognizer->tensorArena)
		return 0;

	model = tflite::GetModel(recognizer->modelData);
	if (!model || (model->version() != TFLITE_SCHEMA_VERSION))
		return 0;
	recognizer->allocator = tflite::MicroAllocator::Create(recognizer->variableArena, MWW_VARIABLE_ARENA_BYTES);
	recognizer->variables = tflite::MicroResourceVariables::Create(recognizer->allocator, 20);
	if (!recognizer->allocator || !recognizer->variables)
		return 0;
	recognizer->interpreter = new (std::nothrow) tflite::MicroInterpreter(model, *recognizer->resolver,
		recognizer->tensorArena, MWW_TENSOR_ARENA_BYTES, recognizer->variables);
	if (!recognizer->interpreter || (recognizer->interpreter->AllocateTensors() != kTfLiteOk))
		return 0;
	recognizer->tensorArenaUsed = (uint32_t)recognizer->interpreter->arena_used_bytes();

	input = recognizer->interpreter->input(0);
	output = recognizer->interpreter->output(0);
	if (!input || !output || (input->type != kTfLiteInt8) || (output->type != kTfLiteUInt8) ||
		(input->dims->size != 3) || (input->dims->data[0] != 1) ||
		(input->dims->data[2] != MWW_FEATURE_SIZE) || (output->dims->size != 2) ||
		(output->dims->data[0] != 1) || (output->dims->data[1] != 1))
		return 0;
	resetProbabilities(recognizer);
	return 1;
}

extern "C" void xs_micro_wake_word_destructor(void *data)
{
	xsMicroWakeWordRecord *recognizer = (xsMicroWakeWordRecord *)data;
	if (!recognizer)
		return;
	if (recognizer->task) {
		__atomic_store_n(&recognizer->stop, 1, __ATOMIC_RELEASE);
		xSemaphoreGive(recognizer->dataAvailable);
		xSemaphoreTake(recognizer->stopped, portMAX_DELAY);
		recognizer->task = NULL;
	}
	delete recognizer->interpreter;
	delete recognizer->resolver;
	if (recognizer->frontendReady)
		FrontendFreeStateContents(&recognizer->frontendState);
	if (recognizer->dataAvailable)
		vSemaphoreDelete(recognizer->dataAvailable);
	if (recognizer->stopped)
		vSemaphoreDelete(recognizer->stopped);
	heap_caps_free(recognizer->ring);
	heap_caps_free(recognizer->tensorArena);
	heap_caps_free(recognizer->variableArena);
	heap_caps_free(recognizer->modelData);
	delete recognizer;
}

extern "C" void xs_micro_wake_word_constructor(xsMachine *the)
{
	xsMicroWakeWordRecord *recognizer = new (std::nothrow) xsMicroWakeWordRecord();
	const uint8_t *source;
	xsUnsignedValue byteLength;

	if (!recognizer)
		xsUnknownError("no memory for microWakeWord");
	std::memset(recognizer, 0, sizeof(*recognizer));
	xsmcGetBufferReadable(xsArg(0), (void **)&source, &byteLength);
	if (!byteLength)
		goto failed;
	recognizer->modelBytes = byteLength;
	recognizer->modelData = (uint8_t *)heap_caps_malloc(byteLength, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
	recognizer->ring = (int16_t *)heap_caps_malloc(MWW_RING_SAMPLES * sizeof(int16_t),
		MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
	recognizer->dataAvailable = xSemaphoreCreateBinary();
	recognizer->stopped = xSemaphoreCreateBinary();
	if (!recognizer->modelData || !recognizer->ring || !recognizer->dataAvailable || !recognizer->stopped)
		goto failed;
	std::memcpy(recognizer->modelData, source, byteLength);
	if (!initializeFrontend(recognizer) || !initializeModel(recognizer))
		goto failed;
	if (pdPASS != xTaskCreatePinnedToCore(microWakeWordTask, "micro-wake", MWW_TASK_STACK_BYTES,
		recognizer, MWW_TASK_PRIORITY, &recognizer->task, MWW_TASK_CORE)) {
		recognizer->task = NULL;
		goto failed;
	}
	xsmcSetHostData(xsThis, recognizer);
	return;

failed:
	xs_micro_wake_word_destructor(recognizer);
	xsUnknownError("microWakeWord initialization failed");
}

extern "C" void xs_micro_wake_word_close(xsMachine *the)
{
	xsMicroWakeWordRecord *recognizer = (xsMicroWakeWordRecord *)xsmcGetHostData(xsThis);
	xs_micro_wake_word_destructor(recognizer);
	xsmcSetHostData(xsThis, NULL);
}

extern "C" void xs_micro_wake_word_feed(xsMachine *the)
{
	xsMicroWakeWordRecord *recognizer = (xsMicroWakeWordRecord *)xsmcGetHostData(xsThis);
	const uint8_t *sourceBytes;
	const int16_t *source;
	xsUnsignedValue byteLength;
	uint32_t sourceFrames;
	uint32_t read;
	uint32_t write;
	uint32_t writable;
	uint32_t index;

	if (!recognizer)
		xsUnknownError("microWakeWord is closed");
	xsmcGetBufferReadable(xsArg(0), (void **)&sourceBytes, &byteLength);
	if (byteLength % (sizeof(int16_t) * MWW_INPUT_CHANNELS))
		xsRangeError("microWakeWord PCM must contain whole frames");
	source = (const int16_t *)sourceBytes;
	sourceFrames = byteLength / (sizeof(int16_t) * MWW_INPUT_CHANNELS);
	write = __atomic_load_n(&recognizer->ringWrite, __ATOMIC_RELAXED);
	read = __atomic_load_n(&recognizer->ringRead, __ATOMIC_ACQUIRE);
	writable = ((read > write) ? (read - write) : (MWW_RING_SAMPLES - write + read)) - 1;
	if (sourceFrames > writable) {
		__atomic_add_fetch(&recognizer->droppedSamples, sourceFrames - writable, __ATOMIC_RELAXED);
		source += (sourceFrames - writable) * MWW_INPUT_CHANNELS;
		sourceFrames = writable;
	}
	for (index = 0; index < sourceFrames; index++) {
		int32_t sample = source[index * MWW_INPUT_CHANNELS];
		uint32_t magnitude = (sample < 0) ? (uint32_t)-sample : (uint32_t)sample;
		recognizer->ring[write] = (int16_t)sample;
		recognizer->pcmAbsoluteTotal += magnitude;
		if (magnitude > recognizer->pcmPeak)
			recognizer->pcmPeak = magnitude;
		write = (write + 1 == MWW_RING_SAMPLES) ? 0 : write + 1;
	}
	recognizer->pcmSampleCount += sourceFrames;
	__atomic_store_n(&recognizer->ringWrite, write, __ATOMIC_RELEASE);
	if (sourceFrames)
		xSemaphoreGive(recognizer->dataAvailable);
	xsmcSetBoolean(xsResult, __atomic_exchange_n(&recognizer->detected, 0, __ATOMIC_ACQ_REL));
}

static void setStat(xsMachine *the, xsSlot object, const char *name, uint32_t value)
{
	xsmcSetInteger(xsVar(0), (xsIntegerValue)value);
	xsmcSet(object, xsID(name), xsVar(0));
}

extern "C" void xs_micro_wake_word_stats(xsMachine *the)
{
	xsMicroWakeWordRecord *recognizer = (xsMicroWakeWordRecord *)xsmcGetHostData(xsThis);
	uint32_t featureCount;
	uint32_t invokeCount;
	xsmcVars(1);
	if (!recognizer)
		xsUnknownError("microWakeWord is closed");
	featureCount = __atomic_load_n(&recognizer->featureCount, __ATOMIC_RELAXED);
	invokeCount = __atomic_load_n(&recognizer->invokeCount, __ATOMIC_RELAXED);
	xsResult = xsNewObject();
	setStat(the, xsResult, "modelBytes", recognizer->modelBytes);
	setStat(the, xsResult, "tensorArenaBytes", MWW_TENSOR_ARENA_BYTES);
	setStat(the, xsResult, "tensorArenaUsed", recognizer->tensorArenaUsed);
	setStat(the, xsResult, "featureCount", featureCount);
	setStat(the, xsResult, "invokeCount", invokeCount);
	setStat(the, xsResult, "frontendAverageUs", featureCount ? (uint32_t)(recognizer->frontendMicros / featureCount) : 0);
	setStat(the, xsResult, "invokeAverageUs", invokeCount ? (uint32_t)(recognizer->invokeMicros / invokeCount) : 0);
	setStat(the, xsResult, "droppedSamples", __atomic_load_n(&recognizer->droppedSamples, __ATOMIC_RELAXED));
	uint32_t pcmSampleCount = recognizer->pcmSampleCount;
	uint64_t pcmAbsoluteTotal = recognizer->pcmAbsoluteTotal;
	setStat(the, xsResult, "pcmSampleCount", pcmSampleCount);
	setStat(the, xsResult, "pcmMeanAbsolute", pcmSampleCount ? (uint32_t)(pcmAbsoluteTotal / pcmSampleCount) : 0);
	setStat(the, xsResult, "pcmPeak", recognizer->pcmPeak);
	setStat(the, xsResult, "lastProbability", __atomic_load_n(&recognizer->lastProbability, __ATOMIC_RELAXED));
	setStat(the, xsResult, "maxProbability", __atomic_load_n(&recognizer->maxProbability, __ATOMIC_RELAXED));
	setStat(the, xsResult, "slidingAverageProbability",
		__atomic_load_n(&recognizer->slidingAverageProbability, __ATOMIC_RELAXED));
	setStat(the, xsResult, "error", __atomic_load_n(&recognizer->error, __ATOMIC_ACQUIRE));
}
