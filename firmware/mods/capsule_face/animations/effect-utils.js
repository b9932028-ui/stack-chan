import { smoothStep } from 'capsule-face-animations/shared'

export function envelope(elapsed, duration, transition = 500) {
  return smoothStep(Math.max(0, Math.min(1, elapsed / transition, (duration - elapsed) / transition)))
}

// Each effect subscribes to the shared machine without replacing other listeners.
export function effectTemplate(name, duration, create) {
  return Container.template((opts) => {
    const { contents, update } = create()
    return {
      left: 0,
      top: 0,
      width: 320,
      height: 240,
      visible: false,
      active: false,
      contents,
      Behavior: class extends Behavior {
        onCreate(container) {
          opts.machine.addVisualListener((state, elapsed) => this.onAnimationFrame(container, state, elapsed))
        }
        onAnimationFrame(container, state, elapsed) {
          const visible = state === name && elapsed >= 0 && elapsed < duration
          if (container.visible !== visible) container.visible = visible
          if (container.visible) update(elapsed, envelope(elapsed, duration))
        }
      },
    }
  })
}

export function bar(left, top, width, height, color = '#ffffff') {
  return new Content(null, { left, top, width, height, skin: new Skin({ fill: color }) })
}
