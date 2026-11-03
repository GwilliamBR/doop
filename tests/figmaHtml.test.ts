import { describe, expect, it } from 'vitest'
import { figmaNodeToHtml } from '../server/figma/html.ts'
import { placeImportedFrames } from '../server/figma/placement.ts'
import { findSvgExportIds } from '../server/figma/vectors.ts'
import { FigmaNodeType, FigmaPaintType, type FigmaColor, type FigmaNode } from '../server/figma/types.ts'

const white: FigmaColor = { r: 1, g: 1, b: 1, a: 1 }
const red: FigmaColor = { r: 1, g: 0, b: 0, a: 1 }
const blue: FigmaColor = { r: 0, g: 0, b: 1, a: 1 }

function box(x: number, y: number, width: number, height: number) {
  return { absoluteBoundingBox: { x, y, width, height } }
}

function frame(id: string, bounds: ReturnType<typeof box>, children: FigmaNode[] = [], extra: Partial<FigmaNode> = {}) {
  return { id, name: id, type: FigmaNodeType.Frame, ...bounds, children, ...extra } satisfies FigmaNode
}

describe('Figma node placement', () => {
  const key = frame('key', box(23, 96, 45, 45), [
    { id: 'label', name: 'label', type: FigmaNodeType.Text, characters: 'Esc', ...box(37, 111, 18, 13) },
  ])
  const keypad = frame('keypad', box(23, 93, 351, 100), [key], {
    fills: [{ type: FigmaPaintType.Solid, color: white }],
  })
  const root = frame('root', box(0, 0, 400, 300), [keypad])

  it('keeps an absolutely placed node absolute even when it has children', () => {
    const html = figmaNodeToHtml(root)
    const styles = [...html.matchAll(/<div style="([^"]*)"/g)].map((match) => match[1]!)
    const keypadStyle = styles.find((style) => style.includes('left: 23px; top: 93px'))
    expect(keypadStyle).toContain('position: absolute;')
    expect(keypadStyle).not.toContain('position: relative')
    expect(html).not.toMatch(/position: absolute;[^"]*position: relative;/)
  })

  it('makes the root a reference point for its absolute children', () => {
    const rootStyle = figmaNodeToHtml(root).match(/<body[^>]*>\s*<div style="([^"]*)"/)![1]!
    expect(rootStyle).toContain('position: relative;')
    expect(rootStyle).not.toContain('position: absolute')
  })

  it('places a node floating inside an auto-layout parent by offset, not in the flex flow', () => {
    const badge: FigmaNode = {
      id: 'badge',
      name: 'badge',
      type: FigmaNodeType.Frame,
      layoutPositioning: 'ABSOLUTE',
      ...box(110, 10, 20, 20),
    }
    const row = frame('row', box(100, 0, 200, 40), [badge], { layoutMode: 'HORIZONTAL' })
    const html = figmaNodeToHtml(row)
    expect(html).toContain('position: absolute; left: 10px; top: 10px; width: 20px; height: 20px;')
    expect(html).toContain('display: flex;')
    expect(html).toContain('position: relative;')
  })
})

describe('Figma text', () => {
  const base: FigmaNode = {
    id: 't',
    name: 't',
    type: FigmaNodeType.Text,
    characters: '~/term $ ls',
    fills: [{ type: FigmaPaintType.Solid, color: { r: 0, g: 0, b: 0, a: 1 } }],
    style: { fontFamily: 'JetBrains Mono', fontWeight: 400, fontSize: 14, textAutoResize: 'HEIGHT' },
    characterStyleOverrides: [1, 1, 1, 1, 1, 1, 1, 2, 2, 0, 0, 3, 3],
    styleOverrideTable: {
      '1': { fills: [{ type: FigmaPaintType.Solid, color: blue }] },
      '2': { fills: [{ type: FigmaPaintType.Solid, color: red }] },
      '3': { fills: [{ type: FigmaPaintType.Solid, color: white }], fontWeight: 700 },
    },
    ...box(0, 0, 200, 20),
  }

  it('renders mixed colour runs as spans instead of the black base colour', () => {
    const html = figmaNodeToHtml({ ...base, characters: '~/term $ ls..' })
    expect(html).toContain('<span style="color: rgba(0, 0, 255, 1);">~/term </span>')
    expect(html).toContain('<span style="color: rgba(255, 0, 0, 1);">$ </span>')
    expect(html).toContain('<span style="font-weight: 700; color: rgba(255, 255, 255, 1);">..</span>')
  })

  it('keeps single-style text as plain escaped text', () => {
    const plain = { ...base, characters: '<b>&', characterStyleOverrides: [], styleOverrideTable: {} }
    expect(figmaNodeToHtml(plain)).toContain('&lt;b&gt;&amp;</div>')
  })

  it('does not wrap text that Figma sized to its content', () => {
    const sized = { ...base, style: { ...base.style, textAutoResize: 'WIDTH_AND_HEIGHT' } }
    expect(figmaNodeToHtml(sized)).toContain('white-space: pre;')
    expect(figmaNodeToHtml(base)).toContain('white-space: pre-wrap; overflow-wrap: break-word;')
  })

  it('centres text vertically through one wrapper span', () => {
    const centred = { ...base, characterStyleOverrides: [], style: { ...base.style, textAlignVertical: 'CENTER' } }
    const html = figmaNodeToHtml(centred)
    expect(html).toContain('justify-content: center;')
    expect(html).toContain('<span>~/term $ ls</span>')
  })
})

describe('Figma fonts', () => {
  const textNode = (id: string, style: FigmaNode['style']): FigmaNode => ({
    id,
    name: id,
    type: FigmaNodeType.Text,
    characters: 'x',
    style,
    ...box(0, 0, 10, 10),
  })

  it('requests each family in its own stylesheet with only the weights used', () => {
    const root = frame('root', box(0, 0, 100, 100), [
      textNode('a', { fontFamily: 'Roboto', fontWeight: 500 }),
      textNode('b', { fontFamily: 'Roboto', fontWeight: 400 }),
      textNode('c', { fontFamily: 'JetBrains Mono', fontWeight: 400 }),
    ])
    const html = figmaNodeToHtml(root)
    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap"')
    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&display=swap"')
  })

  it('adds the italic axis only when italics are used', () => {
    const root = frame('root', box(0, 0, 100, 100), [
      textNode('a', { fontFamily: 'Inter', fontWeight: 400 }),
      textNode('b', { fontFamily: 'Inter', fontWeight: 400, italic: true }),
    ])
    expect(figmaNodeToHtml(root)).toContain('family=Inter:ital,wght@0,400;1,400&display=swap')
  })

  it('never lets a hostile font name break out of the style attribute or the stylesheet link', () => {
    const hostile = `Evil'"><script>alert(1)</script>`
    const html = figmaNodeToHtml(frame('root', box(0, 0, 10, 10), [textNode('a', { fontFamily: hostile })]))
    expect(html).not.toContain('<script')
    expect(html).not.toContain("Evil'")
    expect(html).not.toContain('Evil"')
  })
})

describe('Figma paints', () => {
  it('stacks several fills with the top Figma fill first', () => {
    const html = figmaNodeToHtml(
      frame('f', box(0, 0, 10, 10), [], {
        fills: [
          { type: FigmaPaintType.Solid, color: red },
          { type: FigmaPaintType.Solid, color: blue, opacity: 0.5 },
        ],
      }),
    )
    expect(html).toContain(
      'background-image: linear-gradient(rgba(0, 0, 255, 0.5), rgba(0, 0, 255, 0.5)), linear-gradient(rgba(255, 0, 0, 1), rgba(255, 0, 0, 1));',
    )
  })

  it('turns Figma gradient handles into a CSS angle and stop positions', () => {
    const html = figmaNodeToHtml(
      frame('f', box(0, 0, 200, 100), [], {
        fills: [
          {
            type: FigmaPaintType.GradientLinear,
            gradientHandlePositions: [
              { x: 0, y: 0.5 },
              { x: 1, y: 0.5 },
              { x: 0, y: 1 },
            ],
            gradientStops: [
              { position: 0, color: red },
              { position: 1, color: blue },
            ],
          },
        ],
      }),
    )
    expect(html).toContain('linear-gradient(90deg, rgba(255, 0, 0, 1) 0%, rgba(0, 0, 255, 1) 100%)')
  })

  it('maps a handle line that covers half the box onto the matching CSS percentages', () => {
    const html = figmaNodeToHtml(
      frame('f', box(0, 0, 200, 100), [], {
        fills: [
          {
            type: FigmaPaintType.GradientLinear,
            gradientHandlePositions: [
              { x: 0.25, y: 0.5 },
              { x: 0.75, y: 0.5 },
              { x: 0.25, y: 1 },
            ],
            gradientStops: [
              { position: 0, color: red },
              { position: 1, color: blue },
            ],
          },
        ],
      }),
    )
    expect(html).toContain('rgba(255, 0, 0, 1) 25%, rgba(0, 0, 255, 1) 75%')
  })

  it('draws strokes as shadows so children keep their offsets', () => {
    const stroke = [{ type: FigmaPaintType.Solid, color: red }]
    const inside = figmaNodeToHtml(
      frame('f', box(0, 0, 10, 10), [], { strokes: stroke, strokeWeight: 2, strokeAlign: 'INSIDE' }),
    )
    const outside = figmaNodeToHtml(
      frame('f', box(0, 0, 10, 10), [], { strokes: stroke, strokeWeight: 2, strokeAlign: 'OUTSIDE' }),
    )
    const center = figmaNodeToHtml(
      frame('f', box(0, 0, 10, 10), [], { strokes: stroke, strokeWeight: 2, strokeAlign: 'CENTER' }),
    )
    expect(inside).toContain('box-shadow: inset 0 0 0 2px rgba(255, 0, 0, 1);')
    expect(outside).toContain('box-shadow: 0 0 0 2px rgba(255, 0, 0, 1);')
    expect(center).toContain('inset 0 0 0 1px rgba(255, 0, 0, 1), 0 0 0 1px rgba(255, 0, 0, 1)')
    expect(inside).not.toContain('border:')
  })

  it('draws per-side stroke weights', () => {
    const html = figmaNodeToHtml(
      frame('f', box(0, 0, 10, 10), [], {
        strokes: [{ type: FigmaPaintType.Solid, color: red }],
        strokeWeight: 1,
        individualStrokeWeights: { top: 0, right: 0, bottom: 3, left: 0 },
      }),
    )
    expect(html).toContain('box-shadow: inset 0 -3px 0 0 rgba(255, 0, 0, 1);')
  })

  it('turns layer and background blur into CSS filters', () => {
    const html = figmaNodeToHtml(
      frame('f', box(0, 0, 10, 10), [], {
        effects: [
          { type: 'LAYER_BLUR', radius: 8 },
          { type: 'BACKGROUND_BLUR', radius: 20 },
        ],
      }),
    )
    expect(html).toContain('filter: blur(4px);')
    expect(html).toContain('backdrop-filter: blur(10px);')
  })
})

describe('Figma vectors', () => {
  const arrow: FigmaNode = { id: 'arrow', name: 'arrow', type: FigmaNodeType.Vector, ...box(10, 10, 12, 12) }
  const label: FigmaNode = {
    id: 'label',
    name: 'label',
    type: FigmaNodeType.Text,
    characters: 'Go',
    ...box(0, 0, 20, 10),
  }

  it('swaps an exported vector for an image of its SVG', () => {
    const root = frame('root', box(0, 0, 100, 100), [arrow])
    const html = figmaNodeToHtml(root, { svgMap: { arrow: '/a/abc.svg' } })
    expect(html).toContain(
      '<img src="/a/abc.svg" alt="" style="box-sizing: border-box; display: block; position: absolute; left: 10px; top: 10px; width: 12px; height: 12px;">',
    )
  })

  it('finds lone vectors and small icon containers, but not layouts or frames with text', () => {
    const icon = frame('icon', box(0, 0, 24, 24), [
      { id: 'bg', name: 'bg', type: FigmaNodeType.Rectangle, ...box(0, 0, 24, 24) },
      { ...arrow, id: 'glyph' },
    ])
    const button = frame('button', box(0, 0, 80, 30), [{ ...arrow, id: 'btnIcon' }, label])
    const bigIllustration = frame('big', box(0, 0, 600, 600), [{ ...arrow, id: 'bigVector' }])
    const root = frame('root', box(0, 0, 1000, 1000), [icon, button, bigIllustration])

    expect(findSvgExportIds([root])).toEqual(['icon', 'btnIcon', 'bigVector'])
  })

  it('never exports the root frame itself', () => {
    const iconRoot = frame('iconRoot', box(0, 0, 24, 24), [arrow])
    expect(findSvgExportIds([iconRoot])).toEqual(['arrow'])
  })
})

describe('Imported frame layout on the canvas', () => {
  it('spaces frames by the combined width of the frames before them', () => {
    const sizes = [
      { width: 870, height: 1200 },
      { width: 1012, height: 1200 },
      { width: 940, height: 1241 },
    ]
    const positions = placeImportedFrames([], sizes)
    expect(positions).toEqual([
      { x: 120, y: 120 },
      { x: 1070, y: 120 },
      { x: 2162, y: 120 },
    ])
  })

  it('starts a new row after three frames, below the tallest frame of the row', () => {
    const sizes = [
      { width: 100, height: 50 },
      { width: 100, height: 300 },
      { width: 100, height: 80 },
      { width: 400, height: 100 },
      { width: 100, height: 100 },
    ]
    const positions = placeImportedFrames([], sizes)
    expect(positions[3]).toEqual({ x: 120, y: 120 + 300 + 80 })
    expect(positions[4]).toEqual({ x: 120 + 400 + 80, y: 500 })
  })

  it('never overlaps frames in the same row, and starts right of existing frames', () => {
    const sizes = [
      { width: 870, height: 10 },
      { width: 2118, height: 10 },
      { width: 1400, height: 10 },
    ]
    const positions = placeImportedFrames([{ x: 120, width: 500 }], sizes)
    expect(positions[0]!.x).toBe(700)
    for (let index = 1; index < positions.length; index++) {
      const previousRight = positions[index - 1]!.x + sizes[index - 1]!.width
      expect(positions[index]!.x).toBeGreaterThanOrEqual(previousRight + 80)
    }
  })
})
