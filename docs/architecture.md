# AEM Component Usage Analytics — Architecture

## 1. Overview

The AEM Component Usage Analytics extension reports which `sling:resourceType` values are used by published pages in AEM as a Cloud Service. It also detects "dead components" (definitions under `/apps` with no active usage on published pages), surfaces them in a React Spectrum table, and lets authors export results as CSV or JSON. The extension runs inside Adobe Experience Manager's Extension Manager and is deployed via App Builder.

## 2. System Diagram

```
+---------------------------+    HTTPS + IMS Bearer Token     +----------------------------+
|  Browser (React UI)      | --------------------------------> |  I/O Runtime (Node.js)    |
|  ExC Shell iframe        | <-------------------------------- |  action: queryComponents  |
+---------------------------+    JSON (200 / 400 / 500 / 502)  +----------------------------+
                                                                       |
                                                                       |  IMS token endpoint
                                                                       |  POST client_credentials
                                                                       v
                                                            +----------------------------+
                                                            |  Adobe IMS                |
                                                            |  ims-na1.adobelogin.com   |
                                                            +----------------------------+
                                                                       ^
                                                                       |  HTTPS + Bearer token
                                                                       |  + X-Api-Key
                                                          +--------------------------------+
                                                          |  AEM Author                  |
                                                          |  GET /bin/querybuilder.json  |
                                                          |  (x3 queries, parallel)      |
                                                          +--------------------------------+
```

All three hops are HTTPS. The browser holds an IMS token from ExC Shell; the Runtime action holds its own IMS client-credentials secret and exchanges it at the IMS token endpoint, then calls AEM Author's Query Builder. AEM Author is the target because publication metadata (`cq:lastReplicationAction`) lives there and publish Dispatchers normally block Query Builder.

## 3. Components

### 3.1 Frontend (React + React Spectrum)

| File | Role |
|---|---|
| `src/index.js` | React 18 entry; mounts `<App />` into `#main`. |
| `src/index.html` | SPA template; webpack injects the bundle with a **relative** script path. |
| `src/App.js` | Shell: builds action URL, attaches auth header, fetches data, renders table/detail. |
| `src/components/UsageTable.js` (1-161) | Sortable `<TableView>` of usage rows; dead-component toggle and status warnings. |
| `src/components/DetailView.js` (1-69) | `<Dialog>` showing usage count, last-modified, and sample pages grouped by site/section. |
| `src/components/ExportButton.js` (1-71) | `<MenuTrigger>` exporting the current row set to CSV or JSON. |
| `src/webpack.config.js` | Bundling, Babel pipeline, `DefinePlugin` namespace injection, dev server. |

**State management.** Component-local `useState`/`useEffect`/`useCallback` only. No Redux, no Zustand, no data context provider. `App.js` owns three independent slices — `scope`, `{status, data, error}`, and `selected` — and lifts row selection up to itself so `UsageTable` stays stateless. Row sorting and the dead-component visibility toggle live inside `UsageTable`. This is deliberate: the data set is small enough to hold in one object and there is a single fetch source.

**Data fetching pattern.** `App.js:30-44` defines a memoized `load(path)` via `useCallback`, called once on mount by the `useEffect` at `App.js:46-50` and again by the Retry button. It POSTs JSON, treats a non-2xx response as an error by reading `payload.message || payload.error`, and funnels everything into a single `{status, data, error}` state machine (`loading` → `success` | `error`). There is no client-side cache and no polling; the report is a point-in-time snapshot.

**Namespace resolution.** `App.js:9-14` reads `process.env.AIO_RUNTIME_NAMESPACE` (injected at build time by `DefinePlugin`). When present it targets `https://<namespace>.adobeioruntime.net/api/v1/web/default/queryComponents`; when empty it falls back to the relative path so `aio app run`'s local proxy handles routing.

**Auth header.** `App.js:18-23` reads the ExC Shell context via `window.dx.getContext()` and forwards `ctx.imsToken` (or `ctx.auth.imsToken`) as `Authorization: Bearer ...`. This is required because `app.config.yaml` sets `require-adobe-auth: true` on the action.

### 3.2 Backend (I/O Runtime Action)

Entry point: `actions/queryComponents.js`, exporting `module.exports = { main }` (`queryComponents.js:329`).

**Auth flow.** `getAemToken()` (`queryComponents.js:52-61`) calls `context.set('aemcua', {...})` then `getToken('aemcua')` from `@adobe/aio-lib-ims` v7, performing the IMS client-credentials exchange. `queryBuilder()` (`queryComponents.js:71-97`) attaches `Authorization: Bearer <token>` and `X-Api-Key: <client_id>` to every AEM call.

**Path-key tolerance.** `PATH_KEYS` (`queryComponents.js:13`) probes `jcr:path`, `path`, `path_`, `jcr:path_`. Query Builder hit writers disagree on the path key across AEM versions, and `p.hits=selective` does not reliably emit `path`. `hitPath()` returns the first string value beginning with `/`, else `null`.

**Query Builder queries.** All three target `GET {authorBaseUrl}/bin/querybuilder.json?...`.

*1. Facet counts* — `fetchCounts()`, `queryComponents.js:126-144`:

```text
path=<scope>
type=cq:Page
1_property=jcr:content/cq:lastReplicationAction
1_property.value=Activate
2_property=jcr:content/cq:lastReplicated
2_property.operation=exists
3_property=jcr:content/sling:resourceType
3_property.operation=exists
p.facets=true
p.facetStrategy=oak
facet.property=sling:resourceType
facet.limit=-1
facet.mincount=1
p.limit=1
p.hits=selective
p.properties=jcr:path
```

`extractResourceTypeBuckets()` (`:112-124`) does not trust facet ordering — it picks the first facet whose bucket names look like resource types (contain `/` and do not start with `/`), falling back to `facets[0]`.

*2. Page details* — `fetchPageDetails()`, `queryComponents.js:146-157`:

```text
path=<scope>
type=cq:Page
1_property=jcr:content/cq:lastReplicationAction
1_property.value=Activate
2_property=jcr:content/cq:lastReplicated
2_property.operation=exists
3_property=jcr:content/sling:resourceType
3_property.operation=exists
p.hits=selective
p.properties=jcr:content/sling:resourceType jcr:content/cq:lastModified jcr:content/cq:lastModifiedBy jcr:content/jcr:title
p.limit=-1
p.guessTotal=20000
```

*3. Component definitions* — `fetchDefinedComponents()`, `queryComponents.js:170-179`:

```text
path=<appsRoot>
type=cq:Component
p.limit=-1
p.guessTotal=5000
```

Deliberately uses the default `simple` hit writer (no `p.hits`/`p.properties`) because that writer emits `path` more reliably.

All three run concurrently under `Promise.all` (`queryComponents.js:293-300`).

**Aggregation.** `buildReport()` (`:214-259`) seeds one record per facet bucket, then walks the page hits: tracks the newest `cq:lastModified`/`cq:lastModifiedBy` per resource type and appends up to `SAMPLE_PAGE_LIMIT = 5` samples `{path, title, lastModified}`. Facet counts are treated as authoritative and overwrite the paged values; if the facet query failed, counts stay as derived from the page query and the response flags `countsFromFacets: false`. `buildDeadComponents()` (`:261-274`) diffs definition-derived resource types against used ones.

**Dead-component derivation.** `/apps` definition nodes carry no `sling:resourceType`, so `definitionPathToResourceType()` (`:161-166`) maps the node path to the resource type used on pages by stripping the apps root and any `.html` suffix — e.g. `/apps/wknd/components/title.html` → `wknd/components/title`.

**Failure isolation.** Two independent degradations, both deliberate:
- A facet-query failure is caught and downgraded to an empty `Map` (`:294-297`), so the report still renders with `countsFromFacets: false`.
- A `/apps` failure never collapses to "zero dead components." It is mapped to `forbidden` (401/403) or `unavailable` (`:181-182`) and surfaced in `deadComponentsStatus`, so the UI can distinguish "nothing is dead" from "definitions were unreadable."

**Response schema** (`queryComponents.js:305-322`):

```jsonc
{
  "scope": "/content/we-retail",
  "generatedAt": "2026-10-01T05:25:03.020Z",
  "countsFromFacets": true,          // false => counts came from paged scan
  "pageQueryTruncated": false,        // true => hit the 20000 cap, totals are floors
  "components": [
    {
      "resourceType": "wknd/components/title",
      "count": 412,
      "lastModified": "2026-09-14T10:02:11.000Z",
      "lastModifiedBy": "admin",
      "samplePages": [                 // max 5
        { "path": "/content/we-retail/us/en.html",
          "title": "US Home", "lastModified": "2026-09-14T10:02:11.000Z" }
      ]
    }
  ],
  "deadComponents": [ /* same shape, count: 0, isDead: true */ ],
  "deadComponentsStatus": {
    "status": "ok",                    // ok|partial|unparsed|forbidden|unavailable|skipped
    "reason": null,
    "truncated": false,
    "definitionCount": 318,
    "scannedForDead": true,            // ok|partial only; gates the dead toggle in the UI
    "appsRoot": "/apps"
  }
}
```

Error envelopes: `500 {"error":"missing_config","missing":[...]}` (`:279`), `400 {"error":"invalid_scope","message":...}` (`:283-288`), `502 {"error":"query_failed","message":...}` (`:325`).

### 3.3 AEM Side

- **Endpoint**: `/bin/querybuilder.json`. The commonly cited `/bin/qb.json` does **not** exist; `/bin/querybuilder.json` is the real Query Builder servlet path and is used throughout `actions/queryComponents.js`.
- **Config file**: registration is in **`app.config.yaml`**, not `app.config.json`. App Builder reads the YAML form.
- **Permissions**: the technical account needs `jcr:read` on `/apps/**` (for dead components) and on `/content/**` (for usage). Missing `/apps` read surfaces as `deadComponentsStatus.status === "forbidden"`.
- **Custom OSGi bundle**: none required for v1. Everything uses the out-of-the-box Query Builder REST API.

## 4. Data Flow (sequence)

1. User opens the extension from AEM's Extension Manager; ExC Shell loads the SPA and exposes `window.dx`.
2. `App.js` mount effect reads `?path=` from the URL and calls `load(scope)`.
3. `load()` POSTs `{path, includeDead: true}` to the I/O Runtime web action with `Content-Type: application/json` plus the ExC Shell `Authorization: Bearer <token>` header.
4. The Runtime rejects the request with 401 if that IMS token is absent or invalid (`require-adobe-auth: true`).
5. `main()` validates config and resolves scope; a path outside `AEM_CONTENT_PATH` returns 400.
6. Three Query Builder calls are issued in parallel; each first exchanges IMS client credentials for an AEM-facing bearer token via `context.set` + `getToken`.
7. Facet counts and page details are aggregated by `buildReport()`; `/apps` definitions are diffed by `buildDeadComponents()`.
8. The action returns 200 with the schema in §3.2, or 500/400/502 on the error paths.
9. `App.js` stores the payload and renders `UsageTable`, merging `components` and `deadComponents` into one row set; selecting a row opens `DetailView`; `ExportButton` downloads the same row set.

## 5. Authentication

**Flow.** IMS OAuth 2.0 Client Credentials (server-to-server), implemented in `getAemToken()` via `@adobe/aio-lib-ims@7`:

```js
await context.set('aemcua', {
  client_id, client_secret, ims_org_id,
  technical_account_id, meta_scopes
})
const token = await getToken('aemcua')
```

The token is sent to AEM as `Authorization: Bearer <token>` with `X-Api-Key: <client_id>`. IMS token endpoint is the library default `https://ims-na1.adobelogin.com/ims/token/v3`.

**Two distinct identities**, often confused:

| Caller | Credential | Purpose |
|---|---|---|
| Browser → Runtime action | ExC Shell IMS token, `window.dx.getContext().imsToken` | Satisfies `require-adobe-auth: true` |
| Runtime action → AEM Author | `client_credentials` token from its own secrets | Authenticates to Query Builder |

**Token caching.** Not implemented in application code. `getAemToken()` is invoked inside `queryBuilder()` (`queryComponents.js:81`), so each of the three AEM calls requests a token; any caching is whatever `@adobe/aio-lib-ims` provides internally. The three calls run in parallel, so a single invocation may mint three tokens. Memoizing per invocation is a straightforward optimisation if latency matters.

**Core variables**: `IMS_CLIENT_ID`, `IMS_CLIENT_SECRET`, plus `IMS_ORG_ID`, `IMS_TECHNICAL_ACCOUNT_ID`, `IMS_SCOPES`, and `AEM_AUTHOR_BASE_URL` (see §7).

## 6. Deployment

**Registration** — `app.config.yaml`:

```yaml
extensions:
  dx/excshell/1:
    runtime: nodejs18
    web: src/index.html
    operations:
      - impl: index.html
    runtimeManifest:
      packages:
        aem-component-usage-analytics:
          actions:
            queryComponents:
              web: 'yes'
              runtime: nodejs18
              require-adobe-auth: true
              inputs: ...
```

**Workflow**

```bash
aio login
aio app use -w Stage          # writes .aio/.env for the workspace
aio app deploy                # build + deploy actions and web assets
aio app deploy -e Stage       # explicit workspace
aio app run                   # local dev server with proxy
npm run build                 # aio app build
```

**Workspaces.** Stage and Production are configured in Adobe Developer Console. `aio app use -w` populates `.env`/`.aio` with that workspace's namespace and credentials. Stage is where you validate; Production requires an approved domain/subdomain.

**Extension Manager.** After deploying to the environment backing your AEM as a Cloud Service instance, the extension is listed in AEM's Extension Manager. It is then enabled for the relevant organisation/site and surfaces as an ExC Shell tool. Stage and Production appear as separate entries, so enable the one matching the environment you deployed.

## 7. Configuration

| Variable | Read at | Default | Notes |
|---|---|---|---|
| `AEM_AUTHOR_BASE_URL` | `queryComponents.js:34` | — | Author base URL, e.g. `https://author-p12345-e67890.adobeaemcloud.com`. Takes precedence over `AEM_BASE_URL`. Trailing slashes stripped. |
| `AEM_BASE_URL` | `queryComponents.js:34` | — | Fallback author base URL. |
| `AEM_CONTENT_PATH` | `queryComponents.js:9,35` | `/content` | Content root. A requested `path` must be this or a descendant. |
| `AEM_APPS_PATH` | `queryComponents.js:8,36` | `/apps` | Root scanned for `cq:Component` definitions. |
| `IMS_CLIENT_ID` | `queryComponents.js:29` | — | Required. Also sent as `X-Api-Key`. |
| `IMS_CLIENT_SECRET` | `queryComponents.js:30` | — | Required. |
| `IMS_ORG_ID` | `queryComponents.js:31` | — | Required. |
| `IMS_TECHNICAL_ACCOUNT_ID` | `queryComponents.js:32` | — | Required. |
| `IMS_SCOPES` | `queryComponents.js:33` | — | Required. Maps to IMS `meta_scopes`. |
| `AIO_RUNTIME_NAMESPACE` | `App.js:9` | `''` | Build-time, injected by `DefinePlugin`. Empty locally so the dev proxy handles routing. |

Request-level parameters override env (`env()`, `queryComponents.js:23-25`): `path` (scope, must be under `AEM_CONTENT_PATH`) and `includeDead` (default `true`).

Hard-coded constants (`queryComponents.js:4-7`): `QUERY_BUILDER_PATH='/bin/querybuilder.json'`, `SAMPLE_PAGE_LIMIT=5`, `PAGE_RESULT_CAP=20000`, `REQUEST_TIMEOUT_MS=60000`.

Secrets come from `.env`/`.aio`, never from `.env.example` (which is a non-secret template) or from git (`.gitignore` excludes both).

## 8. Future Extensions (v2+)

| Item | Status | Notes |
|---|---|---|
| OSGi scheduled snapshot bundle | **Planned** | Persist periodic snapshots so trends do not require re-scanning content on every UI load. |
| 30-day trend sparkline | **Planned** | Requires the snapshot history above. |
| Multi-site support | **Planned** | Current `resolveScope()` accepts a single subtree under `AEM_CONTENT_PATH`. |
| Jira/Confluence export | **Planned** | `ExportButton.js` already isolates export serialisation, so this extends one file. |

## 9. Tech Stack Summary

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Frontend | React | 18.2.0 | SPA framework |
| Frontend | `@adobe/react-spectrum` | ^3.47.0 | Design system (Provider, TableView, Dialog, MenuTrigger) |
| Frontend | `@react-spectrum/table` | ^3.18.0 | Table primitives |
| Routing | `react-router-dom` | ^6.20.0 | Declared; not exercised by the current shell |
| Build | webpack / webpack-cli / webpack-dev-server | ^5.90.0 / ^5.1.0 / ^5.0.0 | Bundling, dev server |
| Build | Babel (`preset-env`, `preset-react`) | ^7.24.0 | JSX + ES2022 transpilation |
| Backend | Node.js (I/O Runtime) | nodejs18 | Action runtime |
| Backend | `@adobe/aio-lib-ims` | ^7.0.0 | IMS client-credentials token exchange |
| Integration | AEM Query Builder (`/bin/querybuilder.json`) | AEMaaCS out-of-box | Page and component-definition reads |
| Platform | Adobe App Builder | — | Extension + Runtime deployment |
| Tooling | ESLint + `eslint-plugin-react` | ^8.57.0 / ^7.37.0 | Linting |
| Tooling | Jest + `babel-jest` | ^29.7.0 | Test harness (`--passWithNoTests`; no tests written yet) |

## 10. Known Limitations (v1)

1. **Page-level granularity.** Usage is derived from `jcr:content/sling:resourceType` on `cq:Page` nodes. A component used only deep inside a content page tree, never as the page's own resource type, is not counted. Instance-level counting requires a full traversal.
2. **Facet parameter names unverified.** `facet.property`, `facet.limit`, `facet.mincount`, and `p.facetStrategy=oak` vary across AEM versions. If they are ignored, `extractResourceTypeBuckets()` yields nothing, the facet query is downgraded to an empty Map, and the UI shows the "verify totals" warning.
3. **Caps.** Page details stop at 20 000 hits and `/apps` at 5 000 definitions; both set truncation flags rather than silently under-reporting.
4. **No caching.** Every action invocation performs three IMS token exchanges and three Query Builder scans.
5. **Token type assumptions.** The action assumes its IMS client-credentials token is accepted as an AEM bearer token with `X-Api-Key`. Some AEMaaCS setups expect a different subject/audience mapping; verify against your org.
