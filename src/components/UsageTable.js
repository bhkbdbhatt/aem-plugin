import React, { useMemo, useState } from 'react'
import {
  TableView, TableHeader, TableBody, Column, Row, Cell,
  Button, Text, StatusLight
} from '@adobe/react-spectrum'

function componentName (resourceType) {
  const parts = String(resourceType || '').split('/')
  return parts[parts.length - 1] || resourceType
}

function formatDate (value) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10)
}

function compare (a, b, column) {
  switch (column) {
    case 'count':
      return a.count - b.count
    case 'lastModified':
      return (a.lastModified || '').localeCompare(b.lastModified || '')
    case 'componentName':
      return componentName(a.resourceType).localeCompare(componentName(b.resourceType))
    default:
      return (a.resourceType || '').localeCompare(b.resourceType || '')
  }
}

function sortRows (rows, descriptor) {
  const direction = descriptor.direction === 'descending' ? -1 : 1
  return [...rows].sort((a, b) => compare(a, b, descriptor.column) * direction)
}

function DeadComponentsNotice ({ status }) {
  if (!status || status.status === 'skipped') return null

  if (status.status === 'forbidden') {
    return (
      <StatusLight variant="negative">
        Dead-component scan skipped: the AEM technical account cannot read{' '}
        <code>{status.appsRoot}</code> (403). Grant <code>jcr:read</code> on{' '}
        <code>{status.appsRoot}{'/**'}</code> to detect unused components.
      </StatusLight>
    )
  }

  if (status.status === 'unavailable') {
    return (
      <StatusLight variant="negative">
        Dead-component scan failed: {status.reason}
      </StatusLight>
    )
  }

  if (status.status === 'unparsed') {
    return (
      <StatusLight variant="negative">
        Dead-component scan unreliable: {status.reason}. This instance does not
        expose a path key this action recognises.
      </StatusLight>
    )
  }

  if (status.status === 'partial') {
    return (
      <StatusLight variant="warning">
        Dead-component scan partial: {status.reason}
      </StatusLight>
    )
  }

  if (status.truncated) {
    return (
      <StatusLight variant="warning">
        Dead-component scan truncated at {status.definitionCount} definitions — the
        list below may be incomplete.
      </StatusLight>
    )
  }

  return null
}

export default function UsageTable ({
  rows = [],
  onSelect,
  deadStatus = null,
  truncated = false
}) {
  const [sort, setSort] = useState({ column: 'count', direction: 'descending' })
  const [showDead, setShowDead] = useState(true)

  const deadCount = useMemo(() => rows.filter(row => row.count === 0).length, [rows])

  const visible = useMemo(() => {
    const filtered = showDead ? rows : rows.filter(row => row.count > 0)
    return sortRows(filtered, sort)
  }, [rows, sort, showDead])

  const deadScanUsable = deadStatus?.scannedForDead === true

  return (
    <>
      {truncated && (
        <StatusLight variant="warning">
          Page query hit its result cap — usage counts may under-report.
        </StatusLight>
      )}

      <TableView
        aria-label="Component usage report"
        sortDescriptor={sort}
        onSortChange={setSort}
        density="compact"
        overflowMode="wrap"
        onAction={key => onSelect?.(rows.find(row => row.resourceType === key))}
      >
        <TableHeader>
          <Column id="componentName" allowsSorting>Component Name</Column>
          <Column id="resourceType" allowsSorting>Resource Type</Column>
          <Column id="count" allowsSorting>Usage Count</Column>
          <Column id="lastModified" allowsSorting>Last Modified</Column>
          <Column id="samplePages">Sample Pages</Column>
        </TableHeader>
        <TableBody rows={visible}>
          {row => (
            <Row id={row.resourceType}>
              <Cell>{componentName(row.resourceType)}</Cell>
              <Cell><Text>{row.resourceType}</Text></Cell>
              <Cell>{row.count}</Cell>
              <Cell>{formatDate(row.lastModified)}</Cell>
              <Cell>
                {row.samplePages.length
                  ? row.samplePages.map(page => page.path).join(', ')
                  : '—'}
              </Cell>
            </Row>
          )}
        </TableBody>
      </TableView>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <DeadComponentsNotice status={deadStatus} />
        {deadScanUsable && deadCount > 0 && (
          <Button variant="quiet" onPress={() => setShowDead(current => !current)}>
            {showDead
              ? `Hide ${deadCount} dead component${deadCount === 1 ? '' : 's'}`
              : `Show ${deadCount} dead component${deadCount === 1 ? '' : 's'}`}
          </Button>
        )}
        {deadScanUsable && deadCount === 0 && (
          <StatusLight variant="positive">
            No unused components found across {deadStatus.definitionCount} definitions.
          </StatusLight>
        )}
      </div>
    </>
  )
}