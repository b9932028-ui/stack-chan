type PowerRegisters = {
  readByte(register: number): number
  writeByte(register: number, value: number): void
}

/** Request PMIC shutdown without triggering the separate SoC reset command. */
export function shutdownAxp2101(power: PowerRegisters): void {
  // AXP2101 COMMON_CONFIG: bit 0 = shutdown, bit 1 = reset.
  // Match M5Unified's shutdown request, preserving the other power settings.
  // Do not use the SDK powerOff(), which sets bit 1 before it can shut down.
  const configuration = power.readByte(0x10)
  power.writeByte(0x10, (configuration & ~0x02) | 0x01)
}
