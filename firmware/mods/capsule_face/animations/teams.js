import { applyNeutralPose } from 'capsule-face-animations/shared'
import { palette, pixels } from 'capsule-face-animations/teams-art'
import { statusColors, statusPixels } from 'capsule-face-animations/teams-status-art'

const DURATION_MS = 6000
const TEAMS_SCALE = 4
const STATUS_SCALE = 5

export const TEAMS_PRESENCES = Object.freeze(['available', 'busy', 'away'])

function createRuns(source) {
  const runs = []
  for (let y = 0; y < source.length; y += 1) {
    const row = source[y]
    for (let x = 0; x < row.length; ) {
      const start = x
      const color = row[x]
      while (x < row.length && row[x] === color) x += 1
      if (color !== '.') runs.push({ x: start, y, width: x - start, color })
    }
  }
  return runs
}

const teamsRuns = createRuns(pixels)
const presenceRuns = Object.freeze({
  available: createRuns(statusPixels.available),
  busy: createRuns(statusPixels.busy),
  away: createRuns(statusPixels.away),
})

function drawRuns(port, runs, colors, left, top, scale) {
  for (const run of runs) {
    port.fillColor(colors[run.color], left + run.x * scale, top + run.y * scale, run.width * scale, scale)
  }
}

const messageStyle = new Style({
  font: 'OpenSans-Regular-24',
  color: '#ffffff',
  horizontal: 'center',
  vertical: 'middle',
})

export const TeamsEffect = Container.template((opts) => {
  let presence = 'available'
  const art = new Port(null, {
    left: 0,
    top: 0,
    width: 320,
    height: 176,
    Behavior: class extends Behavior {
      onDraw(port) {
        port.fillColor('#000000', 0, 0, port.width, port.height)
        drawRuns(port, teamsRuns, palette, 20, 22, TEAMS_SCALE)
        drawRuns(port, presenceRuns[presence], { c: statusColors[presence], w: '#ffffff' }, 216, 46, STATUS_SCALE)
      }
    },
  })
  const message = new Label(null, {
    left: 16,
    right: 16,
    top: 176,
    height: 44,
    string: 'WFH',
    style: messageStyle,
  })

  return {
    left: 0,
    top: 0,
    width: 320,
    height: 240,
    visible: false,
    active: false,
    skin: new Skin({ fill: '#000000' }),
    contents: [art, message],
    Behavior: class extends Behavior {
      onCreate(container) {
        opts.machine.addVisualListener((state) => {
          const visible = state === 'teams'
          if (container.visible !== visible) container.visible = visible
        })
        opts.machine.addTeamsStatusListener((status) => {
          if (presence !== status.presence) {
            presence = status.presence
            art.invalidate()
          }
          if (message.string !== status.message) message.string = status.message
        })
      }
    },
  }
})

export default Object.freeze({
  duration: DURATION_MS,
  apply(face) {
    applyNeutralPose(face)
  },
})
