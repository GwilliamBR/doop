// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { figmaIntegration } from '../src/integrations/figma'
import type { IntegrationsStatus } from '../src/lib/api'

const mocks = vi.hoisted(() => ({ req: vi.fn() }))
vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  req: mocks.req,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const disconnect = vi.fn()
const setStatus = vi.fn()
const showToast = vi.fn()
const statusConnected = {
  figma: { connected: true, accountName: 'design_lead' },
} as unknown as IntegrationsStatus

const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent === label)!
const input = () => document.querySelector<HTMLInputElement>('input[type="password"]')!

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

it('renders connected state and handles replace key', async () => {
  const Card = figmaIntegration.SettingsCard
  await act(async () =>
    root.render(
      <Card
        status={statusConnected}
        busy={false}
        setBusy={vi.fn()}
        setStatus={setStatus}
        requestDisconnect={disconnect}
        showToast={showToast}
      />,
    ),
  )

  expect(container.textContent).toContain('design_lead')
  expect(button('Manage')).toBeDefined()
  expect(button('Disconnect')).toBeDefined()

  await act(async () => button('Disconnect').click())
  expect(disconnect).toHaveBeenCalledOnce()

  await act(async () => button('Manage').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.body.textContent).toContain('Connected as design_lead')

  await act(async () => button('Replace key').click())
  expect(input()).not.toBeNull()

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), 'figd_new_token')
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })

  mocks.req.mockResolvedValue({ figma: { connected: true, accountName: 'new_lead' } })
  await act(async () =>
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )

  expect(mocks.req).toHaveBeenCalledWith('/api/integrations/figma/token', {
    method: 'POST',
    body: JSON.stringify({ token: 'figd_new_token' }),
  })
  expect(setStatus).toHaveBeenCalled()
  expect(showToast).toHaveBeenCalledWith('Figma key replaced.')
})

it('renders disconnected state and connects token', async () => {
  const Card = figmaIntegration.SettingsCard
  await act(async () =>
    root.render(
      <Card
        status={{ figma: { connected: false } } as unknown as IntegrationsStatus}
        busy={false}
        setBusy={vi.fn()}
        setStatus={setStatus}
        requestDisconnect={disconnect}
        showToast={showToast}
      />,
    ),
  )

  expect(container.textContent).toContain('Import Figma frames onto your canvases')
  expect(button('Connect')).toBeDefined()

  await act(async () => button('Connect').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(input()).not.toBeNull()

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), 'figd_initial_token')
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })

  mocks.req.mockResolvedValue(statusConnected)
  await act(async () =>
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )

  expect(mocks.req).toHaveBeenCalledWith('/api/integrations/figma/token', {
    method: 'POST',
    body: JSON.stringify({ token: 'figd_initial_token' }),
  })
  expect(setStatus).toHaveBeenCalledWith(statusConnected)
  expect(showToast).toHaveBeenCalledWith('Figma connected.')
})
