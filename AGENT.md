# AGENTS.md

## Project: AEM Component Usage Analytics Extension
## Stack
- React 18 + React Spectrum (@adobe/react-spectrum)
- Adobe I/O Runtime (Node.js serverless action)
- AEM Query Builder API for content queries
- Auth: IMS OAuth 2.0 (via @adobe/aio-lib-ims)

## Rules
- Use React Spectrum only (no Ant Design, MUI, etc.)
- All AEM API calls go through I/O Runtime actions (never from browser)
- No hardcoded AEM URLs; use env vars from .env / .aio
- Output complete files, not snippets   