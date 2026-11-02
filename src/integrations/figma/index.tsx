import { useState } from 'react'
import type { ClientIntegration, SettingsCardProps } from '../index'
import { ApiError, req, type IntegrationsStatus } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from '../../components/ui/modal'
import { Note } from '../../components/ui/note'
import { DisconnectButton, IntegrationCard } from '../ui'
import { BrandMark } from '@/components/ui/brand-mark'

export interface FigmaStatus {
  connected: boolean
  accountName?: string
  connectedAt?: number
}

function statusOf(status: IntegrationsStatus): FigmaStatus {
  return (status.figma ?? { connected: false }) as FigmaStatus
}

export function FigmaTile({ size = 24, className }: { size?: number; className?: string }) {
  return <BrandMark brand="figma" size={size} className={className} />
}

export function FigmaSettingsCard({
  status,
  busy,
  setBusy,
  setStatus,
  requestDisconnect,
  showToast,
}: SettingsCardProps) {
  const figma = statusOf(status)
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function closeSetup() {
    if (busy) return
    setOpen(false)
    setToken('')
    setError(null)
    setReplacing(false)
  }

  async function connect() {
    if (busy || !token.trim()) return
    setBusy(true)
    setError(null)
    try {
      const freshStatus = await req<IntegrationsStatus>('/api/integrations/figma/token', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim() }),
      })
      setStatus(freshStatus)
      setToken('')
      setReplacing(false)
      setOpen(false)
      showToast(figma.connected ? 'Figma key replaced.' : 'Figma connected.')
    } catch (err) {
      setError(
        err instanceof ApiError ? String(err.body.error ?? 'Could not connect Figma.') : 'Could not connect Figma.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <IntegrationCard
        tile={<FigmaTile size={36} />}
        name="Figma"
        detail={figma.connected ? (figma.accountName ?? 'Figma account') : 'Import Figma frames onto your canvases'}
        connected={figma.connected}
        footnote={figma.connected ? 'Read-only access to Figma files' : ''}
        actions={
          <>
            <Button
              variant={figma.connected ? 'bare' : 'default'}
              size="sm"
              disabled={busy}
              onClick={() => setOpen(true)}
            >
              {figma.connected ? 'Manage' : 'Connect'}
            </Button>
            {figma.connected && <DisconnectButton disabled={busy} onClick={requestDisconnect} />}
          </>
        }
      />
      <Modal open={open} onClose={closeSetup} size="md">
        <ModalTitle>{figma.connected ? 'Manage Figma' : 'Connect Figma'}</ModalTitle>
        <ModalLede>Import Figma frames as editable HTML on your canvases.</ModalLede>
        <div className="mt-5 flex flex-col gap-5">
          {figma.connected && (
            <p className="text-copy text-ink-soft">
              Connected as <span className="font-semibold text-ink">{figma.accountName}</span>.
            </p>
          )}

          {error && (
            <Note role="alert" tone="error">
              {error}
            </Note>
          )}

          {figma.connected && !replacing && (
            <Button variant="bare" size="sm" disabled={busy} onClick={() => setReplacing(true)}>
              Replace key
            </Button>
          )}

          {(!figma.connected || replacing) && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void connect()
              }}
            >
              <h3 className="text-copy font-semibold">Personal access token</h3>
              <p className="text-copy leading-relaxed text-ink-soft">
                Create a personal access token in Figma under Settings → Personal access tokens with file read
                permissions. The token is stored securely on the server.
              </p>
              <div className="flex gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label="Figma personal access token"
                  placeholder="figd_…"
                  value={token}
                  disabled={busy}
                  variant="well"
                  className="min-w-0 flex-1"
                  onChange={(event) => {
                    setToken(event.target.value)
                    setError(null)
                  }}
                />
                <Button type="submit" size="sm" disabled={busy || !token.trim()}>
                  {busy ? 'Checking…' : replacing ? 'Save key' : 'Connect'}
                </Button>
              </div>
              {replacing && (
                <>
                  <Note>Your current key stays connected until the replacement is verified.</Note>
                  <Button
                    type="button"
                    variant="bare"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setToken('')
                      setError(null)
                      setReplacing(false)
                    }}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </form>
          )}
        </div>
        <ModalActions>
          <Button variant="bare" disabled={busy} onClick={closeSetup}>
            Close
          </Button>
        </ModalActions>
      </Modal>
    </>
  )
}

export const figmaIntegration: ClientIntegration = {
  id: 'figma',
  name: 'Figma',
  Tile: FigmaTile,
  SettingsCard: FigmaSettingsCard,
  isConnected: (status) => statusOf(status).connected,
  disconnect: () => req<IntegrationsStatus>('/api/integrations/figma', { method: 'DELETE' }),
  disconnectCopy: 'Disconnect Figma and remove access to your files. Existing frames imported onto canvases stay.',
}
