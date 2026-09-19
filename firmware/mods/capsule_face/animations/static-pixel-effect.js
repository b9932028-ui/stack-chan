const glyphs = Object.freeze({
  0: ['.111.', '1...1', '1..11', '1.1.1', '11..1', '1...1', '.111.'],
  4: ['1...1', '1...1', '1...1', '11111', '....1', '....1', '....1'],
  5: ['11111', '1....', '1111.', '....1', '....1', '1...1', '.111.'],
  6: ['.111.', '1...1', '1....', '1111.', '1...1', '1...1', '.111.'],
  7: ['11111', '....1', '...1.', '..1..', '.1...', '.1...', '.1...'],
  8: ['.111.', '1...1', '1...1', '.111.', '1...1', '1...1', '.111.'],
  9: ['.111.', '1...1', '1...1', '.1111', '....1', '1...1', '.111.'],
  '^': ['..1..', '.111.', '11111', '..1..', '..1..', '..1..', '..1..'],
})

export function drawPixelRows(port, rows, colors, left, top, scale) {
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y]
    for (let x = 0; x < row.length; ) {
      const start = x
      const color = row[x]
      while (x < row.length && row[x] === color) x += 1
      if (color !== '.')
        port.fillColor(colors[color], left + start * scale, top + y * scale, (x - start) * scale, scale)
    }
  }
}

export function drawPixelText(port, text, color, left, top, scale) {
  let x = left
  for (const character of text) {
    const glyph = glyphs[character]
    if (!glyph) continue
    drawPixelRows(port, glyph, { 1: color }, x, top, scale)
    x += 6 * scale
  }
}

export function staticPixelEffect(name, draw) {
  return Port.template((opts) => ({
    left: 0,
    top: 0,
    width: 320,
    height: 240,
    visible: false,
    active: false,
    Behavior: class extends Behavior {
      onCreate(port) {
        opts.machine.addVisualListener((state) => {
          const visible = state === name
          if (port.visible !== visible) port.visible = visible
        })
      }
      onDraw(port) {
        port.fillColor('#000000', 0, 0, port.width, port.height)
        draw(port)
      }
    },
  }))
}
