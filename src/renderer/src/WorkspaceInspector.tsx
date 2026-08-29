import type { PaperDetail, ProjectSummary, ServiceEvent } from '../../shared/contracts'
import { FormattedTitle } from './FormattedTitle'
import { MetadataEditor } from './MetadataEditor'
import { NoteEditor } from './NoteEditor'

export type InspectorTab = 'metadata' | 'paper-note' | 'project-note'

interface WorkspaceInspectorProps {
  project: ProjectSummary
  paper: PaperDetail | null
  loadingPaper: boolean
  tab: InspectorTab
  event: ServiceEvent | null
  onTabChange(tab: InspectorTab): void
  onPaperChange(paper: PaperDetail): void
  onLocatePaper(paperId: string): void
}

export function WorkspaceInspector({
  project,
  paper,
  loadingPaper,
  tab,
  event,
  onTabChange,
  onPaperChange,
  onLocatePaper
}: WorkspaceInspectorProps) {
  return (
    <aside className="inspector-panel">
      <header className="inspector-heading">
        <span>{paper ? '当前文献' : '当前项目'}</span>
        <strong title={paper?.title ?? project.name}>
          {paper ? <FormattedTitle>{paper.title}</FormattedTitle> : project.name}
        </strong>
      </header>
      <nav className="inspector-tabs" aria-label="详情栏">
        <button
          type="button"
          className={tab === 'metadata' ? 'active' : ''}
          disabled={!paper}
          onClick={() => onTabChange('metadata')}
        >
          信息
        </button>
        <button
          type="button"
          className={tab === 'paper-note' ? 'active' : ''}
          disabled={!paper}
          onClick={() => onTabChange('paper-note')}
        >
          论文笔记
        </button>
        <button
          type="button"
          className={tab === 'project-note' ? 'active' : ''}
          onClick={() => onTabChange('project-note')}
        >
          项目笔记
        </button>
      </nav>
      <div className="inspector-content">
        {tab === 'metadata' && paper && (
          <MetadataEditor
            key={`${project.id}:${paper.id}`}
            projectId={project.id}
            paper={paper}
            onChange={onPaperChange}
            onLocatePaper={onLocatePaper}
          />
        )}
        {tab === 'paper-note' && paper && (
          <NoteEditor
            key={`${project.id}:${paper.id}:paper-note`}
            projectId={project.id}
            kind="paper"
            paperId={paper.id}
            event={event}
          />
        )}
        {tab === 'project-note' && (
          <NoteEditor
            key={`${project.id}:project-note`}
            projectId={project.id}
            kind="project"
            event={event}
          />
        )}
        {tab !== 'project-note' && !paper && (
          <div className="inspector-empty">
            <strong>{loadingPaper ? '正在载入…' : '尚未选择文献'}</strong>
            <span>在表格中选择一篇文献以查看详细信息。</span>
          </div>
        )}
      </div>
    </aside>
  )
}
