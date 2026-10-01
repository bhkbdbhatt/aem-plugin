const { context, getToken } = require('@adobe/aio-lib-ims')

const IMS_CONTEXT_NAME = 'aemcua'
const QUERY_BUILDER_PATH = '/bin/querybuilder.json'
const SAMPLE_PAGE_LIMIT = 5
const PAGE_RESULT_CAP = 20000
const REQUEST_TIMEOUT_MS = 60000
const APPS_ROOT = process.env.AEM_APPS_PATH || '/apps'
const CONTENT_ROOT = process.env.AEM_CONTENT_PATH || '/content'

// Hit writers disagree on the path key: `jcr:path` under p.hits=selective,
// `path` under the default writer. Probe all known spellings.
const PATH_KEYS = ['jcr:path', 'path', 'path_', 'jcr:path_']

function hitPath (hit) {
  for (const key of PATH_KEYS) {
    const value = hit && hit[key]
    if (typeof value === 'string' && value.startsWith('/')) return value
  }
  return null
}

function env (params, key) {
  return params[key] || process.env[key]
}

function requiredConfig (params) {
  const config = {
    client_id: env(params, 'IMS_CLIENT_ID'),
    client_secret: env(params, 'IMS_CLIENT_SECRET'),
    ims_org_id: env(params, 'IMS_ORG_ID'),
    technical_account_id: env(params, 'IMS_TECHNICAL_ACCOUNT_ID'),
    meta_scopes: env(params, 'IMS_SCOPES'),
    authorBaseUrl: env(params, 'AEM_AUTHOR_BASE_URL') || env(params, 'AEM_BASE_URL'),
    contentRoot: env(params, 'AEM_CONTENT_PATH') || CONTENT_ROOT,
    appsRoot: env(params, 'AEM_APPS_PATH') || APPS_ROOT
  }
  config.missing = Object.entries(config)
    .filter(([key, value]) => !['contentRoot', 'appsRoot'].includes(key) && !value)
    .map(([key]) => key)
  return config
}

function resolveScope (requested, contentRoot) {
  if (requested === undefined || requested === null || requested === '') return contentRoot
  if (typeof requested !== 'string' || !requested.startsWith('/')) return null
  const normalized = requested.replace(/\/+$/, '') || '/'
  if (normalized !== contentRoot && !normalized.startsWith(`${contentRoot}/`)) return null
  return normalized
}

async function getAemToken (config) {
  await context.set(IMS_CONTEXT_NAME, {
    client_id: config.client_id,
    client_secret: config.client_secret,
    ims_org_id: config.ims_org_id,
    technical_account_id: config.technical_account_id,
    meta_scopes: config.meta_scopes
  })
  return getToken(IMS_CONTEXT_NAME)
}

function jsonResponse (statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }
}

async function queryBuilder (config, scope, predicates) {
  const qs = new URLSearchParams({ path: scope, ...predicates }).toString()
  const url = `${config.authorBaseUrl.replace(/\/+$/, '')}${QUERY_BUILDER_PATH}?${qs}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${await getAemToken(config)}`,
        'X-Api-Key': config.client_id,
        Accept: 'application/json'
      }
    })
    if (!res.ok) {
      const error = new Error(`QueryBuilder responded ${res.status} for scope ${scope}`)
      error.status = res.status
      throw error
    }
    const body = await res.json()
    if (body.success === false) throw new Error('QueryBuilder reported success=false')
    return body
  } finally {
    clearTimeout(timer)
  }
}

const PUBLISHED_PAGE_PREDICATES = {
  type: 'cq:Page',
  '1_property': 'jcr:content/cq:lastReplicationAction',
  '1_property.value': 'Activate',
  '2_property': 'jcr:content/cq:lastReplicated',
  '2_property.operation': 'exists'
}

const RESOURCE_TYPE_PREDICATE = {
  '3_property': 'jcr:content/sling:resourceType',
  '3_property.operation': 'exists'
}

function extractResourceTypeBuckets (body) {
  const facets = Array.isArray(body.facets) ? body.facets : []
  const looksLikeResourceType = value =>
    typeof value === 'string' && value.includes('/') && !value.startsWith('/')

  for (const facet of facets) {
    const buckets = facet.buckets || []
    if (buckets.length && buckets.every(bucket => looksLikeResourceType(bucket.name ?? bucket.label))) {
      return buckets
    }
  }
  return facets.length ? facets[0].buckets || [] : []
}

async function fetchCounts (config, scope) {
  const body = await queryBuilder(config, scope, {
    ...PUBLISHED_PAGE_PREDICATES,
    ...RESOURCE_TYPE_PREDICATE,
    'p.facets': 'true',
    'p.facetStrategy': 'oak',
    'facet.property': 'sling:resourceType',
    'facet.limit': '-1',
    'facet.mincount': '1',
    'p.limit': '1',
    'p.hits': 'selective',
    'p.properties': 'jcr:path'
  })
  const counts = new Map()
  for (const bucket of extractResourceTypeBuckets(body)) {
    counts.set(bucket.name ?? bucket.label, Number(bucket.count) || 0)
  }
  return counts
}

async function fetchPageDetails (config, scope) {
  const body = await queryBuilder(config, scope, {
    ...PUBLISHED_PAGE_PREDICATES,
    ...RESOURCE_TYPE_PREDICATE,
    'p.hits': 'selective',
    'p.properties':
      'jcr:content/sling:resourceType jcr:content/cq:lastModified jcr:content/cq:lastModifiedBy jcr:content/jcr:title',
    'p.limit': '-1',
    'p.guessTotal': String(PAGE_RESULT_CAP)
  })
  return body.hits || []
}

// Component definitions under /apps carry no sling:resourceType; the type used on
// pages is derived from the definition node's own path relative to /apps.
function definitionPathToResourceType (nodePath, appsRoot) {
  const prefix = `${appsRoot}/`
  if (!nodePath || !nodePath.startsWith(prefix)) return null
  const relative = nodePath.slice(prefix.length).replace(/\.html$/, '')
  return relative || null
}

// Never collapse failure into an empty list. Callers must be able to tell
// "no dead components" from "definitions unreadable".
async function fetchDefinedComponents (config) {
  let body
  try {
    // Default `simple` hit writer (no p.hits/p.properties) is used deliberately:
    // it reliably emits `path`, unlike selective mode across AEM versions.
    body = await queryBuilder(config, config.appsRoot, {
      type: 'cq:Component',
      'p.limit': '-1',
      'p.guessTotal': '5000'
    })
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 'forbidden' : 'unavailable'
    return { status, reason: err.message, truncated: false, resourceTypes: [] }
  }

  const hits = body.hits || []
  const resourceTypes = new Set()
  let unparsed = 0
  for (const hit of hits) {
    const resourceType = definitionPathToResourceType(hitPath(hit), config.appsRoot)
    if (resourceType) resourceTypes.add(resourceType)
    else unparsed++
  }

  const reported = Number(body.total) || hits.length
  let status = 'ok'
  let reason = null
  if (reported > 0 && resourceTypes.size === 0) {
    status = 'unparsed'
    reason = `${reported} cq:Component nodes returned but none exposed a usable path key`
  } else if (unparsed > 0) {
    status = 'partial'
    reason = `${unparsed} of ${reported} component nodes had an unusable path key`
  }

  return {
    status,
    reason,
    truncated: Boolean(body.more),
    definitionCount: reported,
    resourceTypes: [...resourceTypes]
  }
}

function buildReport (counts, hits) {
  const records = new Map()
  const blank = resourceType => ({
    resourceType,
    count: 0,
    lastModified: null,
    lastModifiedBy: null,
    samplePages: []
  })

  for (const resourceType of counts.keys()) records.set(resourceType, blank(resourceType))

  for (const hit of hits) {
    const content = hit['jcr:content'] || {}
    const resourceType = content['sling:resourceType']
    const path = hitPath(hit)
    if (!resourceType || !path) continue
    if (!records.has(resourceType)) records.set(resourceType, blank(resourceType))

    const record = records.get(resourceType)
    const modified = content['cq:lastModified']
    if (modified && (!record.lastModified || modified > record.lastModified)) {
      record.lastModified = modified
      record.lastModifiedBy = content['cq:lastModifiedBy'] || null
    }
    if (record.samplePages.length < SAMPLE_PAGE_LIMIT) {
      record.samplePages.push({
        path,
        title: content['jcr:title'] || null,
        lastModified: modified || null
      })
    }
  }

  const components = [...records.values()].sort((a, b) => b.count - a.count)

  // Facet counts are authoritative; fall back to the paged query when the facet
  // request failed. If that query was also truncated, totals are floors.
  if (counts.size) {
    for (const record of components) {
      if (counts.has(record.resourceType)) record.count = counts.get(record.resourceType)
    }
  }

  return components
}

function buildDeadComponents (components, definitions) {
  const used = new Set(components.map(component => component.resourceType))
  return definitions.resourceTypes
    .filter(resourceType => !used.has(resourceType))
    .sort()
    .map(resourceType => ({
      resourceType,
      count: 0,
      lastModified: null,
      lastModifiedBy: null,
      samplePages: [],
      isDead: true
    }))
}

async function main (params) {
  const config = requiredConfig(params || {})
  if (config.missing.length) {
    return jsonResponse(500, { error: 'missing_config', missing: config.missing })
  }

  const scope = resolveScope(params.path, config.contentRoot)
  if (!scope) {
    return jsonResponse(400, {
      error: 'invalid_scope',
      message: `path must be ${config.contentRoot} or a descendant of it`
    })
  }

  try {
    const includeDead = params.includeDead !== false && params.includeDead !== 'false'

    const [counts, hits, definitions] = await Promise.all([
      fetchCounts(config, scope).catch(err => {
        console.warn('facet counts unavailable, falling back to page query:', err.message)
        return new Map()
      }),
      fetchPageDetails(config, scope),
      includeDead ? fetchDefinedComponents(config) : Promise.resolve(null)
    ])

    const components = buildReport(counts, hits)
    const deadComponents = definitions ? buildDeadComponents(components, definitions) : []

    return jsonResponse(200, {
      scope,
      generatedAt: new Date().toISOString(),
      countsFromFacets: counts.size > 0,
      pageQueryTruncated: hits.length >= PAGE_RESULT_CAP,
      components,
      deadComponents,
      deadComponentsStatus: definitions
        ? {
            status: definitions.status,
            reason: definitions.reason,
            truncated: definitions.truncated,
            definitionCount: definitions.definitionCount ?? 0,
            scannedForDead: definitions.status === 'ok' || definitions.status === 'partial',
            appsRoot: config.appsRoot
          }
        : { status: 'skipped', scannedForDead: false }
    })
  } catch (err) {
    console.error('queryComponents failed:', err.message)
    return jsonResponse(502, { error: 'query_failed', message: err.message })
  }
}

module.exports = { main }