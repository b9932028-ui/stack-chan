#include "xs.h"
#include "esp_system.h"

void xs_stackchan_reset_reason(xsMachine *the) {
  xsResult = xsInteger(esp_reset_reason());
}
