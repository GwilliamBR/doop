import { useEffect, useState } from 'react'
import type { ClientIntegration, ImportSectionProps, SettingsCardProps } from '../index'
import { api, ApiError, req, type IntegrationsStatus } from '../../lib/api'
import type { Frame } from '../../../shared/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Field } from '../../components/ui/field'
import { Badge } from '../../components/ui/badge'
import { Checkbox } from '../../components/ui/checkbox'
import { SelectionBar, SelectionBarAction } from '../../components/ui/selection-bar'
import { ArrowLeftIcon } from '../../components/ui/icons'
import { ImportStepFooter, ImportStepHeader } from '../../components/ImportSources'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from '../../components/ui/modal'
import { Note } from '../../components/ui/note'
import { DisconnectButton, IntegrationCard } from '../ui'
import { BrandMark } from '@/components/ui/brand-mark'
import { cn } from '../../lib/utils'

export interface FigmaStatus {
  connected: boolean
  accountName?: string
  connectedAt?: number
}

export interface DiscoveredFigmaFrame {
  id: string
  name: string
  pageName: string
  width: number
  height: number
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
        err instanceof ApiError
          ? String(err.body.error ?? 'Could not connect Figma.')
          : err instanceof Error
            ? err.message
            : 'Could not connect Figma.',
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
                Create a personal access token in Figma under Settings → Security &amp; Personal access tokens with
                Current user (current_user:read) and File content (file_content:read) permissions. The token is stored
                securely on the server.
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

function FigmaReviewView({
  canvasId,
  url,
  fileKey,
  frames,
  onDone,
  onBack,
}: {
  canvasId: string
  url: string
  fileKey: string
  frames: DiscoveredFigmaFrame[]
  onDone: (frames: Frame[]) => void
  onBack: () => void
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(frames.map((frame) => frame.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleFrame(frameId: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(frameId)) next.delete(frameId)
      else next.add(frameId)
      return next
    })
  }

  async function runImport() {
    if (!selectedIds.size || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.importFigmaFrames(canvasId, url, Array.from(selectedIds))
      onDone(result.frames)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.body.error ?? 'Could not import frames.')
          : err instanceof Error
            ? err.message
            : 'Could not import frames.',
      )
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row sm:gap-6">
        <div className="flex flex-col gap-[5px]">
          <ModalEyebrow>Review before import</ModalEyebrow>
          <ModalTitle>Choose frames to import</ModalTitle>
        </div>
        <Badge shape="pill">Figma · {fileKey}</Badge>
      </div>
      <ModalLede>
        {frames.length} {frames.length === 1 ? 'frame' : 'frames'} found. Select the frames you want to land on your
        canvas as editable HTML.
      </ModalLede>
      <SelectionBar
        className="mt-4"
        count={selectedIds.size}
        total={frames.length}
        actions={
          <>
            <SelectionBarAction
              disabled={busy}
              onClick={() => setSelectedIds(new Set(frames.map((frame) => frame.id)))}
            >
              Select all
            </SelectionBarAction>
            <SelectionBarAction disabled={busy} onClick={() => setSelectedIds(new Set())}>
              Clear
            </SelectionBarAction>
          </>
        }
      />
      <div
        className={cn(
          'max-h-[calc(100dvh-390px)] overflow-y-auto rounded-card border border-line bg-paper transition-opacity sm:max-h-[min(350px,calc(100vh-390px))]',
          busy && 'opacity-[0.58]',
        )}
        role="group"
        aria-label="Frames to import"
      >
        {frames.map((frame, index) => (
          <label
            key={frame.id}
            className="relative grid min-h-[58px] cursor-pointer grid-cols-[20px_24px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line bg-surface px-3 py-[9px] first:rounded-t-card last:rounded-t-none last:rounded-b-card last:border-b-0 hover:bg-paper"
          >
            <Checkbox checked={selectedIds.has(frame.id)} disabled={busy} onChange={() => toggleFrame(frame.id)} />
            <span className="font-mono text-micro text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
            <span className="min-w-0">
              <b className="block overflow-hidden whitespace-nowrap text-ellipsis text-body text-ink">{frame.name}</b>
              <span className="mt-[3px] block overflow-hidden whitespace-nowrap text-ellipsis font-mono text-micro text-ink-faint">
                {frame.pageName}
              </span>
            </span>
            <span className="rounded-full bg-paper-deep px-2 py-[3px] font-mono text-micro text-ink-faint">
              {frame.width} × {frame.height}px
            </span>
          </label>
        ))}
      </div>

      {error && (
        <Note role="alert" tone="error" className="mt-3">
          {error}
        </Note>
      )}

      <ModalActions className="justify-between">
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          <ArrowLeftIcon size={14} />
          Back
        </Button>
        <Button variant="primary" disabled={busy || !selectedIds.size} onClick={() => void runImport()}>
          {busy
            ? 'Importing…'
            : selectedIds.size
              ? `Import ${selectedIds.size} ${selectedIds.size === 1 ? 'frame' : 'frames'}`
              : 'Select frames'}
        </Button>
      </ModalActions>
    </>
  )
}

export function FigmaImportSection({ canvasId, setReview, onImporting, onBack }: ImportSectionProps) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    api
      .integrations()
      .then((status) => {
        setConnected(statusOf(status).connected)
      })
      .catch(() => setConnected(false))
  }, [])

  async function connectInlineToken() {
    if (connecting || !tokenInput.trim()) return
    setConnecting(true)
    setError(null)
    try {
      await req('/api/integrations/figma/token', {
        method: 'POST',
        body: JSON.stringify({ token: tokenInput.trim() }),
      })
      setConnected(true)
      setTokenInput('')
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.body.error ?? 'Could not connect Figma.')
          : err instanceof Error
            ? err.message
            : 'Could not connect Figma.',
      )
    } finally {
      setConnecting(false)
    }
  }

  async function discover() {
    if (!url.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.discoverFigmaFrames(canvasId, url.trim())
      if (!result.frames.length) {
        setError('No frames found in this Figma file.')
        setBusy(false)
        return
      }

      setReview(
        <FigmaReviewView
          canvasId={canvasId}
          url={url.trim()}
          fileKey={result.fileKey}
          frames={result.frames}
          onBack={() => setReview(null)}
          onDone={(createdFrames) => {
            setReview(null)
            onImporting(
              createdFrames.length,
              createdFrames.map((f) => f.id),
            )
          }}
        />,
      )
      setBusy(false)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.body.error ?? 'Could not read Figma link.')
          : err instanceof Error
            ? err.message
            : 'Could not read Figma link.',
      )
      setBusy(false)
    }
  }

  if (connected === false) {
    return (
      <>
        <ImportStepHeader icon={<BrandMark brand="figma" size={22} className="text-ink" />} title="Connect Figma" />
        <ModalLede>Connect a Figma Personal Access Token to import frames onto this canvas.</ModalLede>
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-copy text-ink-soft">
            Create a token in Figma under Settings → Security &amp; Personal access tokens with Current user
            (current_user:read) and File content (file_content:read) permissions, or manage connections on the{' '}
            <a href="/integrations" className="text-ink underline underline-offset-2">
              Integrations page
            </a>
            .
          </p>
          <Field label="Personal access token" labelVariant="form">
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="figd_…"
                variant="well"
                inputSize="lg"
                className="font-mono flex-1"
                value={tokenInput}
                disabled={connecting}
                onChange={(e) => {
                  setTokenInput(e.target.value)
                  setError(null)
                }}
              />
              <Button
                variant="primary"
                disabled={connecting || !tokenInput.trim()}
                onClick={() => void connectInlineToken()}
              >
                {connecting ? 'Checking…' : 'Connect'}
              </Button>
            </div>
          </Field>
          {error && (
            <Note role="alert" tone="error">
              {error}
            </Note>
          )}
        </div>
        <ImportStepFooter note="Tokens are kept private on the server." onBack={onBack}>
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        </ImportStepFooter>
      </>
    )
  }

  return (
    <>
      <ImportStepHeader icon={<BrandMark brand="figma" size={22} className="text-ink" />} title="Import from Figma" />
      <ModalLede>
        Paste a Figma frame or file link. You can review all frames before adding them to the canvas.
      </ModalLede>
      <Field className="mt-[22px]" label="Figma URL" labelVariant="form" htmlFor="figma-url">
        <Input
          id="figma-url"
          variant="well"
          inputSize="lg"
          className="font-mono"
          autoFocus
          placeholder="https://www.figma.com/design/KEY/Title?node-id=1-2"
          value={url}
          disabled={busy}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void discover()
          }}
        />
      </Field>

      {error && (
        <Note role="alert" tone="error" className="mt-3">
          {error}
        </Note>
      )}

      <ImportStepFooter
        note="Fills, typography, layout, and images are converted into editable HTML frames."
        onBack={onBack}
        backDisabled={busy}
      >
        <Button variant="primary" disabled={busy || !url.trim()} onClick={() => void discover()}>
          {busy ? 'Reading file…' : 'Continue'}
        </Button>
      </ImportStepFooter>
    </>
  )
}

export const figmaIntegration: ClientIntegration = {
  id: 'figma',
  name: 'Figma',
  Tile: FigmaTile,
  importSource: {
    title: 'Figma',
    blurb: 'Frames or whole files from a link.',
    icon: <BrandMark brand="figma" size={20} className="text-ink" />,
  },
  SettingsCard: FigmaSettingsCard,
  ImportSection: FigmaImportSection,
  isConnected: (status) => statusOf(status).connected,
  disconnect: () => req<IntegrationsStatus>('/api/integrations/figma', { method: 'DELETE' }),
  disconnectCopy: 'Disconnect Figma and remove access to your files. Existing frames imported onto canvases stay.',
}
