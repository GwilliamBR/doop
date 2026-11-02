// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { figmaIntegration } from '../src/integrations/figma'
import { Modal } from '../src/components/ui/modal'
import { ApiError } from '../src/lib/api'

const mocks = vi.hoisted(() => ({
  integrations: vi.fn(),
  discoverFigmaFrames: vi.fn(),
  importFigmaFrames: vi.fn(),
  req: vi.fn(),
}))

vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  api: {
    ...(await original<typeof import('../src/lib/api')>()).api,
    integrations: mocks.integrations,
    discoverFigmaFrames: mocks.discoverFigmaFrames,
    importFigmaFrames: mocks.importFigmaFrames,
  },
  req: mocks.req,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const setReview = vi.fn()
const onImporting = vi.fn()
const onBack = vi.fn()

const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === label)!
const input = (placeholderPrefix = '') =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input')).find((el) =>
    placeholderPrefix ? el.placeholder.includes(placeholderPrefix) : true,
  )!

beforeEach(async () => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('prompts to connect token when user has not connected Figma', async () => {
  mocks.integrations.mockResolvedValue({ figma: { connected: false } })
  const ImportSection = figmaIntegration.ImportSection!

  await act(async () =>
    root.render(
      <Modal open onClose={() => {}}>
        <ImportSection canvasId="canvas-1" setReview={setReview} onImporting={onImporting} onBack={onBack} />
      </Modal>,
    ),
  )

  expect(document.body.textContent).toContain('Connect Figma')
  expect(document.body.textContent).toContain('Connect a Figma Personal Access Token')
  expect(button('Connect')).toBeDefined()
  expect(button('Back')).toBeDefined()

  await act(async () => button('Back').click())
  expect(onBack).toHaveBeenCalledOnce()
})

it('allows pasting Figma link and discovers frames to review', async () => {
  mocks.integrations.mockResolvedValue({ figma: { connected: true, accountName: 'design_lead' } })
  mocks.discoverFigmaFrames.mockResolvedValue({
    fileKey: 'sampleKey',
    frames: [
      { id: '1:2', name: 'Header', pageName: 'Page 1', width: 375, height: 100 },
      { id: '1:3', name: 'Footer', pageName: 'Page 1', width: 375, height: 80 },
    ],
  })

  const ImportSection = figmaIntegration.ImportSection!
  await act(async () =>
    root.render(
      <Modal open onClose={() => {}}>
        <ImportSection canvasId="canvas-1" setReview={setReview} onImporting={onImporting} onBack={onBack} />
      </Modal>,
    ),
  )

  expect(document.body.textContent).toContain('Import from Figma')
  const urlInput = input('https://www.figma.com')
  expect(urlInput).toBeDefined()

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      urlInput,
      'https://www.figma.com/design/sampleKey/Test',
    )
    urlInput.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await act(async () => button('Continue').click())

  expect(mocks.discoverFigmaFrames).toHaveBeenCalledWith('canvas-1', 'https://www.figma.com/design/sampleKey/Test')
  expect(setReview).toHaveBeenCalledOnce()
})

it('displays helpful error on invalid inline token and keeps input interactive', async () => {
  mocks.integrations.mockResolvedValue({ figma: { connected: false } })
  const ImportSection = figmaIntegration.ImportSection!

  await act(async () =>
    root.render(
      <Modal open onClose={() => {}}>
        <ImportSection canvasId="canvas-1" setReview={setReview} onImporting={onImporting} onBack={onBack} />
      </Modal>,
    ),
  )

  const tokenInput = input('figd_')
  expect(tokenInput).toBeDefined()

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(tokenInput, 'bad_token')
    tokenInput.dispatchEvent(new Event('input', { bubbles: true }))
  })

  mocks.req.mockRejectedValue(
    new ApiError(401, JSON.stringify({ error: 'Figma rejected this token. Verify the token and try again.' })),
  )
  await act(async () => button('Connect').click())

  const alertNote = document.querySelector('[role="alert"]')
  expect(alertNote).not.toBeNull()
  expect(alertNote?.textContent).toContain('Figma rejected this token. Verify the token and try again.')
  expect(tokenInput.disabled).toBe(false)
})

it('displays expected format error when pasting malformed link and keeps input interactive', async () => {
  mocks.integrations.mockResolvedValue({ figma: { connected: true, accountName: 'design_lead' } })
  mocks.discoverFigmaFrames.mockRejectedValue(
    new ApiError(
      400,
      JSON.stringify({
        error: 'Enter a valid Figma link with a file key (e.g. https://www.figma.com/design/KEY/Title?node-id=1-2).',
      }),
    ),
  )

  const ImportSection = figmaIntegration.ImportSection!
  await act(async () =>
    root.render(
      <Modal open onClose={() => {}}>
        <ImportSection canvasId="canvas-1" setReview={setReview} onImporting={onImporting} onBack={onBack} />
      </Modal>,
    ),
  )

  const urlInput = input('https://www.figma.com')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      urlInput,
      'https://example.com/not-a-figma-link',
    )
    urlInput.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await act(async () => button('Continue').click())

  const alertNote = document.querySelector('[role="alert"]')
  expect(alertNote).not.toBeNull()
  expect(alertNote?.textContent).toContain(
    'Enter a valid Figma link with a file key (e.g. https://www.figma.com/design/KEY/Title?node-id=1-2).',
  )
  expect(urlInput.value).toBe('https://example.com/not-a-figma-link')
  expect(urlInput.disabled).toBe(false)
})

it('displays human-readable rate limit error on discovery without resetting url input', async () => {
  mocks.integrations.mockResolvedValue({ figma: { connected: true, accountName: 'design_lead' } })
  mocks.discoverFigmaFrames.mockRejectedValue(
    new ApiError(429, JSON.stringify({ error: 'Figma rate limit reached. Try again later.' })),
  )

  const ImportSection = figmaIntegration.ImportSection!
  await act(async () =>
    root.render(
      <Modal open onClose={() => {}}>
        <ImportSection canvasId="canvas-1" setReview={setReview} onImporting={onImporting} onBack={onBack} />
      </Modal>,
    ),
  )

  const urlInput = input('https://www.figma.com')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      urlInput,
      'https://www.figma.com/design/sampleKey/RateLimited',
    )
    urlInput.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await act(async () => button('Continue').click())

  const alertNote = document.querySelector('[role="alert"]')
  expect(alertNote).not.toBeNull()
  expect(alertNote?.textContent).toContain('Figma rate limit reached. Try again later.')
  expect(urlInput.value).toBe('https://www.figma.com/design/sampleKey/RateLimited')
  expect(urlInput.disabled).toBe(false)
})
