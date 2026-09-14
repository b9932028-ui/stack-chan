/*
 * Register access to the CoreS3 AW88298 speaker amplifier.
 *
 * Moddable's CoreS3 setup already holds an ECMA-419 I2C handle on 0x36, and its
 * I2C module refuses a second handle at the same address ("duplicate address").
 * That check lives only in Moddable's JavaScript binding. Underneath, both use the
 * ESP-IDF i2c_master bus, which allows several devices at one address and
 * serializes transactions with its own bus lock, so this adds a second device on
 * the bus Moddable created instead of opening a new one.
 */

#include "xsHost.h"
#include "xsmc.h"
#include "mc.xs.h"

#include "driver/i2c_master.h"
#include "esp_err.h"
#include "soc/soc_caps.h"

#define AW88298_ADDRESS (0x36)
#define AW88298_SCL_HZ (400000)
#define AW88298_TIMEOUT_MS (100)
#define AW88298_PROBE_TIMEOUT_MS (50)

static i2c_master_dev_handle_t gAmplifier = NULL;
static int gAmplifierPort = -1;

// Finds the bus that answers at 0x36 and attaches to it. Returns the I2C port, or -1.
void xs_stackchan_speaker_amp_open(xsMachine *the)
{
	if (!gAmplifier) {
		for (int port = 0; port < SOC_I2C_NUM; port++) {
			i2c_master_bus_handle_t bus = NULL;
			if (ESP_OK != i2c_master_get_bus_handle((i2c_port_num_t)port, &bus))
				continue;
			if (ESP_OK != i2c_master_probe(bus, AW88298_ADDRESS, AW88298_PROBE_TIMEOUT_MS))
				continue;

			i2c_device_config_t config = {
				.dev_addr_length = I2C_ADDR_BIT_LEN_7,
				.device_address = AW88298_ADDRESS,
				.scl_speed_hz = AW88298_SCL_HZ,
			};
			if (ESP_OK == i2c_master_bus_add_device(bus, &config, &gAmplifier)) {
				gAmplifierPort = port;
				break;
			}
			gAmplifier = NULL;
		}
	}
	xsmcSetInteger(xsResult, gAmplifier ? gAmplifierPort : -1);
}

// Writes a 16-bit register, big-endian, as Moddable's writeUint16(register, value, true) does.
void xs_stackchan_speaker_amp_write(xsMachine *the)
{
	if (!gAmplifier)
		xsUnknownError("AW88298 is not open");
	int reg = xsmcToInteger(xsArg(0));
	int value = xsmcToInteger(xsArg(1));
	uint8_t bytes[3] = { (uint8_t)reg, (uint8_t)((value >> 8) & 0xff), (uint8_t)(value & 0xff) };
	esp_err_t err = i2c_master_transmit(gAmplifier, bytes, sizeof(bytes), AW88298_TIMEOUT_MS);
	if (ESP_OK != err)
		xsUnknownError("AW88298 write failed: %s", esp_err_to_name(err));
}

// Reads a 16-bit register, big-endian.
void xs_stackchan_speaker_amp_read(xsMachine *the)
{
	if (!gAmplifier)
		xsUnknownError("AW88298 is not open");
	uint8_t reg = (uint8_t)xsmcToInteger(xsArg(0));
	uint8_t bytes[2] = { 0, 0 };
	esp_err_t err = i2c_master_transmit_receive(gAmplifier, &reg, 1, bytes, sizeof(bytes), AW88298_TIMEOUT_MS);
	if (ESP_OK != err)
		xsUnknownError("AW88298 read failed: %s", esp_err_to_name(err));
	xsmcSetInteger(xsResult, (bytes[0] << 8) | bytes[1]);
}
