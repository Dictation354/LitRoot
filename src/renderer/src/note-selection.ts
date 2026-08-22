export function hasUnsavedNoteDraft(
  currentPaperId: string | null,
  dirtyPaperId: string | null
): boolean {
  return Boolean(currentPaperId && dirtyPaperId === currentPaperId)
}

export function shouldConfirmDiscardNoteDraft(
  currentPaperId: string | null,
  nextPaperId: string,
  dirtyPaperId: string | null
): boolean {
  return Boolean(
    currentPaperId &&
      nextPaperId !== currentPaperId &&
      hasUnsavedNoteDraft(currentPaperId, dirtyPaperId)
  )
}
