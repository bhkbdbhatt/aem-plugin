import React from 'react'
import { Menu, MenuTrigger, ActionButton, Item } from '@adobe/react-spectrum'

const COLUMNS = ['componentName', 'resourceType', 'usageCount', 'lastModified', 'samplePages']

function componentName (resourceType) {
  const parts = String(resourceType || '').split('/')
  return parts[parts.length - 1] || resourceType
}

function cell (row, column) {
  switch (column) {
    case 'componentName': return componentName(row.resourceType)
    case 'resourceType': return row.resourceType || ''
    case 'usageCount': return row.count ?? 0
    case 'lastModified': return row.lastModified || ''
    case 'samplePages': return (row.samplePages || []).map(page => page.path).join('; ')
    default: return ''
  }
}

function download (filename, mimeType, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function toCsv (rows) {
  const escape = value => {
    const text = String(value ?? '')
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return [
    COLUMNS.join(','),
    ...rows.map(row => COLUMNS.map(column => escape(cell(row, column))).join(','))
  ].join('\r\n')
}

export default function ExportButton ({ rows = [] }) {
  const disabled = rows.length === 0
  const stamp = new Date().toISOString().slice(0, 10)

  return (
    <MenuTrigger
      isDisabled={disabled}
      trigger={<ActionButton isDisabled={disabled}>Export</ActionButton>}
    >
      <Menu
        onAction={key => {
          if (key === 'csv') {
            download(`component-usage-${stamp}.csv`, 'text/csv;charset=utf-8', toCsv(rows))
          } else {
            download(
              `component-usage-${stamp}.json`,
              'application/json',
              JSON.stringify(rows, null, 2)
            )
          }
        }}
      >
        <Item key="csv">Export as CSV</Item>
        <Item key="json">Export as JSON</Item>
      </Menu>
    </MenuTrigger>
  )
}