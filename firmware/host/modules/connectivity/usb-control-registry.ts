export type USBControlNamespaceHandler = (command: string, value: unknown) => unknown | Promise<unknown>

type USBControlNamespace = {
  commands: readonly string[]
  handle: USBControlNamespaceHandler
}

const namespaces = new Map<string, USBControlNamespace>()
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

export function registerUSBControlNamespace(
  namespace: string,
  commands: readonly string[],
  handle: USBControlNamespaceHandler,
): () => void {
  if (!NAME_PATTERN.test(namespace)) throw new Error('invalid USB control namespace')
  if (commands.length === 0 || commands.some((command) => !NAME_PATTERN.test(command))) {
    throw new Error('invalid USB control command')
  }

  const registration = { commands: [...new Set(commands)], handle }
  namespaces.set(namespace, registration)
  return () => {
    if (namespaces.get(namespace) === registration) namespaces.delete(namespace)
  }
}

export function getUSBControlExtensionCapabilities(): string[] {
  return Array.from(namespaces.entries()).flatMap(([namespace, registration]) =>
    registration.commands.map((command) => `${namespace}.${command}`),
  )
}

export function runUSBControlExtension(command: string, value: unknown): unknown | Promise<unknown> {
  const separator = command.indexOf('.')
  if (separator <= 0 || separator === command.length - 1) throw new Error('unsupported command')
  const namespace = command.slice(0, separator)
  const localCommand = command.slice(separator + 1)
  const registration = namespaces.get(namespace)
  if (!registration?.commands.includes(localCommand)) throw new Error('unsupported command')
  return registration.handle(localCommand, value)
}
