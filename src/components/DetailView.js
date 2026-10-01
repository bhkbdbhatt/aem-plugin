import React, { useMemo } from 'react'
import { Dialog, Content, Heading, Divider, Button, Text } from '@adobe/react-spectrum'

function groupBySite (pages) {
  const groups = new Map()
  for (const page of pages) {
    const segments = String(page.path || '').split('/').filter(Boolean)
    const site = segments[1] || '(root)'
    const section = segments.slice(2, -1).join('/') || '/'
    const key = `${site} ${section}`
    if (!groups.has(key)) groups.set(key, { site, section, pages: [] })
    groups.get(key).pages.push(page)
  }
  return [...groups.values()].sort(
    (a, b) => a.site.localeCompare(b.site) || a.section.localeCompare(b.section)
  )
}

function formatDate (value) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString()
}

export default function DetailView ({ component, onClose }) {
  const groups = useMemo(() => groupBySite(component.samplePages || []), [component])

  return (
    <Dialog isOpen onDismiss={onClose} maxWidth="size-600">
      <Heading>{component.resourceType}</Heading>
      <Divider />
      <Content>
        <dl style={{ marginTop: 0 }}>
          <dt>Usage count</dt>
          <dd style={{ margin: '0 0 8px' }}><strong>{component.count}</strong></dd>
          <dt>Last modified</dt>
          <dd style={{ margin: '0 0 8px' }}>
            <strong>{formatDate(component.lastModified)}</strong>
            {component.lastModifiedBy && <> by <strong>{component.lastModifiedBy}</strong></>}
          </dd>
        </dl>

        <Heading size="S">Sample pages by site / section</Heading>
        {!groups.length && <p>No page samples available for this component.</p>}

        {groups.map(group => (
          <div key={`${group.site}/${group.section}`} style={{ marginBottom: 16 }}>
            <Text UNSAFE_style={{ fontWeight: 600 }}>{group.site}</Text>
            <div style={{ color: '#6e6e6e', fontSize: 12 }}>{group.section}</div>
            <ul style={{ margin: '4px 0 0 18px' }}>
              {group.pages.map(page => (
                <li key={page.path}>
                  {page.title ? `${page.title} — ` : ''}
                  {page.path}
                  {page.lastModified ? ` (${formatDate(page.lastModified)})` : ''}
                </li>
              ))}
            </ul>
          </div>
        ))}

        <Divider />
        <div style={{ marginTop: 12 }}>
          <Button variant="primary" onPress={onClose}>Close</Button>
        </div>
      </Content>
    </Dialog>
  )
}