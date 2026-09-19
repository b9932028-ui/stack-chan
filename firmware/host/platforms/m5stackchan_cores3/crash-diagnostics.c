#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "xsmc.h"
#include "xsHost.h"
#include "mc.xs.h"

/*
	Memory and task figures for the crash report. A release build compiles out
	Moddable's own abort reporting (xs/platforms/esp/xsPlatform.c), so an XS abort
	restarts the board with no explanation; the JavaScript abort hook calls this to
	say what the heap looked like at that moment.

	Field names are resolved at runtime: xsID_<name> exists only for identifiers the
	compiler saw in JavaScript source, and these live only in TypeScript types.
*/
static void setStat(xsMachine *the, const char *name, uint32_t value)
{
	xsmcSetInteger(xsVar(0), (xsIntegerValue)value);
	xsmcSet(xsResult, xsID(name), xsVar(0));
}

void xs_stackchan_crash_diagnostics(xsMachine *the)
{
	xsmcVars(1);
	xsmcSetNewObject(xsResult);

	setStat(the, "freeHeap", (uint32_t)esp_get_free_heap_size());
	setStat(the, "minimumFreeHeap", (uint32_t)esp_get_minimum_free_heap_size());
	setStat(the, "freeInternal", (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
	setStat(the, "largestFreeInternal", (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
	setStat(the, "minimumFreeInternal", (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
	setStat(the, "freeSpiram", (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
	setStat(the, "largestFreeSpiram", (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
	setStat(the, "freeDma", (uint32_t)heap_caps_get_free_size(MALLOC_CAP_DMA));
	setStat(the, "largestFreeDma", (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_DMA));
	/* Words remaining on this task's stack, the other way an XS abort happens. */
	setStat(the, "taskStackHeadroom", (uint32_t)uxTaskGetStackHighWaterMark(NULL));
	setStat(the, "taskCount", (uint32_t)uxTaskGetNumberOfTasks());
	setStat(the, "uptimeSeconds", (uint32_t)(esp_timer_get_time() / 1000000));
	setStat(the, "resetReason", (uint32_t)esp_reset_reason());
}
