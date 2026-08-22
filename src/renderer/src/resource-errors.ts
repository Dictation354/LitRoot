export type ResourceErrorKey = 'summary' | 'list' | 'load-more' | 'detail'

export type ResourceErrors = Record<ResourceErrorKey, string | null>

export const EMPTY_RESOURCE_ERRORS: ResourceErrors = {
  summary: null,
  list: null,
  'load-more': null,
  detail: null
}

export function withResourceError(
  current: ResourceErrors,
  resource: ResourceErrorKey,
  error: string | null
): ResourceErrors {
  if (current[resource] === error) return current
  return { ...current, [resource]: error }
}
