import type { Dispatch, DragEvent, PointerEvent, SetStateAction } from 'react'
import { useRef } from 'react'
import type { PaperListItem, PaperSortField } from '../../shared/contracts'
import { Icon } from './Icon'
import type {
  LibraryColumnKey,
  LibraryPreferences
} from './library-preferences'
import { reorderLibraryColumns } from './library-preferences'

interface LibraryTableProps {
  items: PaperListItem[]
  loading: boolean
  query: string
  selectedPaperId: string
  preferences: LibraryPreferences
  setPreferences: Dispatch<SetStateAction<LibraryPreferences>>
  onSortChange(sortBy: PaperSortField): void
  onSelect(paperId: string): void
  onOpen(paper: PaperListItem): void
}

const COLUMN_LABELS: Record<LibraryColumnKey, string> = {
  title: '标题',
  authors: '作者',
  year: '年份',
  journal: '期刊 / 会议',
  contentKind: '内容',
  doi: 'DOI',
  source: '来源',
  modifiedAt: '修改时间'
}

const SORTABLE_COLUMNS = new Set<PaperSortField>([
  'title',
  'authors',
  'year',
  'journal',
  'contentKind',
  'source',
  'modifiedAt'
])

function contentLabel(paper: PaperListItem): string {
  if (paper.contentKind === 'fulltext') return '全文'
  if (paper.contentKind === 'abstract_only') return '仅摘要'
  return '仅元数据'
}

function cellValue(paper: PaperListItem, key: LibraryColumnKey): React.ReactNode {
  if (key === 'title') {
    return (
      <>
        <span className="paper-title-cell">
          {paper.title || '无标题'}
          {paper.hasOverrides && <span className="override-dot" title="包含本地元数据修改" />}
        </span>
        {paper.searchSnippet && (
          <small className="table-search-snippet">
            {paper.searchSnippet.replace(/<\/?mark>/g, '')}
          </small>
        )}
      </>
    )
  }
  if (key === 'authors') return paper.authors.join('; ') || '—'
  if (key === 'year') return paper.year ?? '—'
  if (key === 'journal') return paper.journal || '—'
  if (key === 'contentKind') {
    return <span className={`content-badge ${paper.contentKind}`}>{contentLabel(paper)}</span>
  }
  if (key === 'doi') return paper.doi || '—'
  if (key === 'source') return paper.source || '—'
  const date = new Date(paper.modifiedAt)
  return Number.isNaN(date.valueOf()) ? paper.modifiedAt || '—' : date.toLocaleDateString()
}

function resizeColumn(
  event: PointerEvent<HTMLSpanElement>,
  key: LibraryColumnKey,
  width: number,
  setPreferences: Dispatch<SetStateAction<LibraryPreferences>>
): void {
  event.preventDefault()
  event.stopPropagation()
  const startX = event.clientX
  const move = (nextEvent: globalThis.PointerEvent): void => {
    const nextWidth = Math.min(640, Math.max(64, Math.round(width + nextEvent.clientX - startX)))
    setPreferences((current) => ({
      ...current,
      columns: current.columns.map((column) => (
        column.key === key ? { ...column, width: nextWidth } : column
      ))
    }))
  }
  const finish = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish, { once: true })
}

export function LibraryTable({
  items,
  loading,
  query,
  selectedPaperId,
  preferences,
  setPreferences,
  onSortChange,
  onSelect,
  onOpen
}: LibraryTableProps) {
  const draggedColumn = useRef<LibraryColumnKey | null>(null)
  const visibleColumns = preferences.columns.filter((column) => column.visible)
  const gridTemplateColumns = visibleColumns.map((column) => `${column.width}px`).join(' ')
  const minWidth = visibleColumns.reduce((sum, column) => sum + column.width, 0)

  const dropColumn = (event: DragEvent, target: LibraryColumnKey): void => {
    event.preventDefault()
    const source = draggedColumn.current
    draggedColumn.current = null
    if (!source) return
    setPreferences((current) => ({
      ...current,
      columns: reorderLibraryColumns(current.columns, source, target)
    }))
  }

  const toggleColumn = (key: LibraryColumnKey): void => {
    setPreferences((current) => {
      const selected = current.columns.find((column) => column.key === key)
      const visibleCount = current.columns.filter((column) => column.visible).length
      if (selected?.visible && visibleCount === 1) return current
      return {
        ...current,
        columns: current.columns.map((column) => (
          column.key === key ? { ...column, visible: !column.visible } : column
        ))
      }
    })
  }

  return (
    <div className="library-table-frame" aria-busy={loading}>
      <div className="library-table-scroll">
        <div className="library-table" role="table" style={{ minWidth }} aria-label="文献列表">
          <div className="table-header" role="rowgroup">
            <div className="table-grid" role="row" style={{ gridTemplateColumns }}>
              {visibleColumns.map((column) => {
                const sortable = SORTABLE_COLUMNS.has(column.key as PaperSortField)
                const active = preferences.sortBy === column.key
                return (
                  <div
                    className={`table-column-header ${active ? 'sorted' : ''}`}
                    draggable
                    key={column.key}
                    onDragStart={() => { draggedColumn.current = column.key }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropColumn(event, column.key)}
                    role="columnheader"
                  >
                    <button
                      type="button"
                      disabled={!sortable}
                      onClick={() => sortable && onSortChange(column.key as PaperSortField)}
                    >
                      <span>{COLUMN_LABELS[column.key]}</span>
                      {active && (
                        <span className={`sort-arrow ${preferences.sortDirection}`} aria-label={preferences.sortDirection === 'asc' ? '升序' : '降序'} />
                      )}
                    </button>
                    <span
                      className="column-resizer"
                      onPointerDown={(event) => resizeColumn(event, column.key, column.width, setPreferences)}
                      role="separator"
                      aria-label={`调整${COLUMN_LABELS[column.key]}列宽`}
                    />
                  </div>
                )
              })}
            </div>
          </div>
          <div className="table-body" role="rowgroup">
            {items.map((paper) => (
              <div
                aria-selected={paper.id === selectedPaperId}
                className={`paper-row ${paper.id === selectedPaperId ? 'selected' : ''}`}
                data-paper-id={paper.id}
                key={paper.id}
                onClick={() => onSelect(paper.id)}
                onDoubleClick={() => onOpen(paper)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onOpen(paper)
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                  event.preventDefault()
                  const rows = Array.from(
                    event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('.paper-row') ?? []
                  )
                  const current = rows.indexOf(event.currentTarget)
                  const delta = event.key === 'ArrowDown' ? 1 : -1
                  const next = rows[Math.min(rows.length - 1, Math.max(0, current + delta))]
                  if (next) {
                    onSelect(next.dataset.paperId ?? '')
                    next.focus()
                  }
                }}
                role="row"
                style={{ gridTemplateColumns }}
                tabIndex={paper.id === selectedPaperId ? 0 : -1}
              >
                {visibleColumns.map((column) => (
                  <div className={`paper-cell ${column.key}`} key={column.key} role="cell">
                    {cellValue(paper, column.key)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <details className="column-picker">
        <summary aria-label="选择显示列" title="选择显示列"><Icon name="columns" /></summary>
        <div className="column-picker-menu">
          <strong>显示列</strong>
          {preferences.columns.map((column) => (
            <label key={column.key}>
              <input
                checked={column.visible}
                disabled={column.visible && visibleColumns.length === 1}
                onChange={() => toggleColumn(column.key)}
                type="checkbox"
              />
              <span>{COLUMN_LABELS[column.key]}</span>
            </label>
          ))}
          <small>拖动表头排序，拖动分隔线调整宽度。</small>
        </div>
      </details>
      {!loading && items.length === 0 && (
        <div className="table-empty">
          <Icon name={query ? 'search' : 'book'} size={30} />
          <strong>{query ? '没有匹配的文献' : '这个项目还没有文献'}</strong>
          <span>{query ? '尝试其他关键词或清空筛选条件。' : '使用右上角的“添加文献”开始构建文献库。'}</span>
        </div>
      )}
      {loading && items.length === 0 && <div className="table-loading">正在载入文献…</div>}
    </div>
  )
}
