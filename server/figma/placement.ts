const FRAME_GAP = 80
const FIRST_FRAME_ORIGIN = { x: 120, y: 120 }
const FRAMES_PER_ROW = 3

export interface FrameSize {
  width: number
  height: number
}

export interface FramePosition {
  x: number
  y: number
}

/**
 * Lays imported frames out in rows of three, to the right of everything already on the canvas.
 * Each frame starts after the full width of the frames before it in its row, so differently
 * sized frames never overlap.
 */
export function placeImportedFrames(existing: { x: number; width: number }[], incoming: FrameSize[]): FramePosition[] {
  const rightmostEdge = existing.reduce((right, frame) => Math.max(right, frame.x + frame.width), 0)
  const startX = existing.length ? rightmostEdge + FRAME_GAP : FIRST_FRAME_ORIGIN.x

  const positions: FramePosition[] = []
  let rowTop = FIRST_FRAME_ORIGIN.y
  let rowLeft = startX
  let rowHeight = 0

  incoming.forEach((size, index) => {
    const isRowStart = index > 0 && index % FRAMES_PER_ROW === 0
    if (isRowStart) {
      rowTop += rowHeight + FRAME_GAP
      rowLeft = startX
      rowHeight = 0
    }
    positions.push({ x: rowLeft, y: rowTop })
    rowLeft += size.width + FRAME_GAP
    rowHeight = Math.max(rowHeight, size.height)
  })

  return positions
}
