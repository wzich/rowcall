# ADR 0002: Use TanStack Query For Server State

## Status

Accepted

## Context

The UI needs to load, validate, and eventually run, save, and reload graphs.
These operations depend on external state owned by the runtime or a future
document service. Managing that with component-level effects would spread fetch
lifecycle, loading, error, retry, and cache behavior throughout the UI.

## Decision

Plain API helpers live under `app/ui/src/api`. They should be framework-neutral
TypeScript functions that call backend/runtime endpoints and return the backend
contract.

TanStack Query integration lives under `app/ui/src/query`. It owns query keys,
cache behavior, retries, and conversion of backend failures into React query
error states.

Components should consume query and mutation state instead of using `useEffect`
for normal remote data loading.

## Consequences

- API contract code remains testable outside React.
- Components stay focused on rendering UI states.
- Future execution actions should use TanStack Query mutations with the same
  API/query split.
- Temporary query behavior, such as local-dev retry defaults, should be kept in
  query configuration rather than scattered through components.
