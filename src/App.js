import React, { useCallback, useEffect, useState } from 'react'
import { Provider, Flex, Heading, Content, StatusLight, Button } from '@adobe/react-spectrum'
import UsageTable from './components/UsageTable'
import DetailView from './components/DetailView'
import ExportButton from './components/ExportButton'

// Injected at build time by webpack DefinePlugin. Left empty locally so the
// relative path falls back to the `aio app run` dev proxy.
const NAMESPACE = process.env.AIO_RUNTIME_NAMESPACE
const ACTION_PATH = '/api/v1/web/default/queryComponents'

function actionUrl () {
  return NAMESPACE ? `https://${NAMESPACE}.adobeioruntime.net${ACTION_PATH}` : ACTION_PATH
}

// app.config.yaml sets require-adobe-auth, so the caller must present an Adobe
// IMS token. ExC Shell exposes it on the window.dx context.
function authHeaders () {
  if (typeof window === 'undefined') return {}
  const ctx = typeof window.dx?.getContext === 'function' ? window.dx.getContext() : null
  const token = ctx?.imsToken || ctx?.auth?.imsToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export default function App () {
  const [scope, setScope] = useState('')
  const [state, setState] = useState({ status: 'loading', data: null, error: null })
  const [selected, setSelected] = useState(null)

  const load = useCallback(async path => {
    setState({ status: 'loading', data: null, error: null })
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ path: path || undefined, includeDead: true })
      })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload.message || payload.error || `HTTP ${res.status}`)
      setState({ status: 'success', data: payload, error: null })
    } catch (err) {
      setState({ status: 'error', data: null, error: err.message })
    }
  }, [])

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('path')
    setScope(initial || '')
    load(initial)
  }, [load])

  const components = state.data?.components || []
  const deadComponents = state.data?.deadComponents || []

  return (
    <Provider theme="light" scale="medium">
      <Content>
        <Flex direction="column" gap="size-300" UNSAFE_style={{ padding: 24 }}>
          <Flex alignItems="center" justifyContent="space-between" gap="size-200" wrap>
            <Heading size="M">Component Usage</Heading>
            <Flex gap="size-150" alignItems="center">
              {state.data && !state.data.countsFromFacets && (
                <StatusLight variant="warning">
                  Counts derived from paged page query — verify totals on large sites
                </StatusLight>
              )}
              <ExportButton rows={[...components, ...deadComponents]} />
            </Flex>
          </Flex>

          {state.status === 'loading' && <StatusLight>Querying AEM…</StatusLight>}

          {state.status === 'error' && (
            <Flex gap="size-200" alignItems="center">
              <StatusLight variant="negative">{state.error}</StatusLight>
              <Button variant="secondary" onPress={() => load(scope)}>Retry</Button>
            </Flex>
          )}

          {state.status === 'success' && (
            <>
              <UsageTable
                rows={[...components, ...deadComponents]}
                onSelect={setSelected}
                deadStatus={state.data.deadComponentsStatus}
                truncated={state.data.pageQueryTruncated}
              />
              {selected && <DetailView component={selected} onClose={() => setSelected(null)} />}
            </>
          )}
        </Flex>
      </Content>
    </Provider>
  )
}