export class LitRootError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'LitRootError'
  }
}

export class NoteConflictError extends LitRootError {
  constructor(details: unknown) {
    super('note_conflict', '笔记已被外部修改，当前草稿没有覆盖磁盘文件。', 409, details)
    this.name = 'NoteConflictError'
  }
}

export class MetadataConflictError extends LitRootError {
  constructor(existingPaperId: string) {
    super('doi_conflict', '当前项目中已存在使用该 DOI 的论文。', 409, { existingPaperId })
    this.name = 'MetadataConflictError'
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
