import type { MouseEvent as ReactMouseEvent } from 'react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { isSafeLocalImageSource, safeMarkdownLink } from '../../shared/markdown-security'
import { bridge, errorMessage } from './bridge'
import { useMenuFocus, type ReadingPosition } from './workspace-hooks'

interface MarkdownReaderProps {
  projectId: string
  paperId: string
  title: string
  markdown: string
  readingPosition?: ReadingPosition | undefined
}

interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
  data?: Record<string, unknown>
  position?: {
    start: { line: number; offset?: number }
    end: { line: number; offset?: number }
  }
}

interface MarkdownFile {
  value: unknown
}

const READER_FONT_SIZE_KEY = 'litroot.reader-font-size'
const DEFAULT_READER_FONT_SIZE = 18
const MIN_READER_FONT_SIZE = 14
const MAX_READER_FONT_SIZE = 24
const SEARCH_HIGHLIGHT = 'litroot-search-match'
const ACTIVE_SEARCH_HIGHLIGHT = 'litroot-search-active'
const USER_HIGHLIGHT = 'litroot-user-highlight'

function comparableTitle(value: string): string {
  return value
    .replace(/<[^>]*>/gu, '')
    .replace(/&#(x[\da-f]+|\d+);/giu, (_entity, code: string) => {
      const value = Number.parseInt(code.startsWith('x') || code.startsWith('X') ? code.slice(1) : code, code.toLowerCase().startsWith('x') ? 16 : 10)
      try {
        return String.fromCodePoint(value)
      } catch {
        return ''
      }
    })
    .replace(/&(amp|lt|gt|quot|apos);/giu, (entity) => ({
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'"
    })[entity.toLowerCase()] ?? entity)
    .replace(/[*_~`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase()
}

function withoutDuplicateTitle(markdown: string, title: string): string {
  const heading = /^(?:[ \t]*\r?\n)*[ \t]{0,3}#(?!#)[ \t]+(.+?)[ \t]*#?[ \t]*(?:\r?\n|$)/u.exec(markdown)
  if (!heading || comparableTitle(heading[1] ?? '') !== comparableTitle(title)) return markdown
  return markdown.slice(heading[0].length).replace(/^\r?\n/u, '')
}

function loadReaderFontSize(): number {
  try {
    const value = Number(window.localStorage.getItem(READER_FONT_SIZE_KEY))
    return Number.isFinite(value) && value > 0
      ? Math.min(MAX_READER_FONT_SIZE, Math.max(MIN_READER_FONT_SIZE, Math.round(value)))
      : DEFAULT_READER_FONT_SIZE
  } catch {
    return DEFAULT_READER_FONT_SIZE
  }
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && typeof Highlight !== 'undefined' && 'highlights' in CSS
    ? CSS.highlights
    : null
}

function remarkInlineImages() {
  return (tree: MarkdownNode, file: MarkdownFile): void => {
    const markdown = typeof file.value === 'string' ? file.value : ''
    const visit = (node: MarkdownNode): void => {
      if (node.type === 'image' || node.type === 'imageReference') {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start !== undefined && end !== undefined && node.position?.start.line === node.position?.end.line) {
          const lineStart = markdown.lastIndexOf('\n', start - 1) + 1
          const followingLineBreak = markdown.indexOf('\n', end)
          const lineEnd = followingLineBreak === -1 ? markdown.length : followingLineBreak
          const hasOtherContent = markdown.slice(lineStart, start).trim() || markdown.slice(end, lineEnd).trim()
          if (hasOtherContent) {
            const properties = (node.data?.hProperties ?? {}) as Record<string, unknown>
            node.data = {
              ...node.data,
              hProperties: {
                ...properties,
                className: ['markdown-image-inline']
              }
            }
          }
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

function remarkStandaloneMath() {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode): void => {
      if (!node.children) return
      node.children = node.children.map((child) => {
        if (
          child.type === 'paragraph' &&
          child.children?.length === 1 &&
          child.children[0]?.type === 'inlineMath'
        ) {
          const math = child.children[0]
          const properties = (math.data?.hProperties ?? {}) as Record<string, unknown>
          math.data = {
            ...math.data,
            hProperties: {
              ...properties,
              className: ['language-math', 'math-display']
            }
          }
          return math
        }
        visit(child)
        return child
      })
    }
    visit(tree)
  }
}

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []).filter((tagName) => !['picture', 'source'].includes(tagName)),
    'details', 'summary', 'figure', 'figcaption'
  ],
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []).filter((attribute) => attribute[0] !== 'className'),
      ['className', /^language-[\w-]+$/, /^math-(?:inline|display)$/]
    ],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^math-(?:inline|display)$/]],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', /^math-display$/]],
    img: [...(defaultSchema.attributes?.img ?? []), ['className', /^markdown-image-inline$/]],
    input: ['type', 'checked', 'disabled']
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https']
  }
}

const urlTransform: UrlTransform = (url, key) => {
  if (key === 'src') return url
  return safeMarkdownLink(url) ?? '#blocked-link'
}

const MarkdownBody = memo(function MarkdownBody({ projectId, paperId, title, markdown, onError }: MarkdownReaderProps & { onError(message: string): void }) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children, ...props }) => (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault()
          if (href?.startsWith('#') && href !== '#blocked-link') {
            document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' })
          } else if (href && /^https?:/i.test(href)) {
            void bridge().system.openExternal(href).catch((error) => onError(errorMessage(error)))
          }
        }}
        rel="noreferrer"
      >
        {children}
      </a>
    ),
    img: ({ src, alt, className }) => {
      const source = typeof src === 'string' ? src : ''
      if (!isSafeLocalImageSource(source)) {
        return <span className="blocked-image">远程或不安全图片已阻止{alt ? `：${alt}` : ''}</span>
      }
      return (
        <img
          src={bridge().papers.assetUrl(projectId, paperId, source)}
          data-image-source={source}
          alt={alt ?? ''}
          className={className}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )
    }
  }), [paperId, projectId, onError])
  const displayedMarkdown = useMemo(() => withoutDuplicateTitle(markdown, title), [markdown, title])

  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath, remarkStandaloneMath, remarkInlineImages]}
    rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
    urlTransform={urlTransform} components={components}
  >{displayedMarkdown}</ReactMarkdown>
})

// Match original UTF-16 text so Unicode case folding never shifts DOM offsets.
export function findTextRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const groups: Text[][] = []
  let block: Element | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode() as Text | null
  while (node) {
    const parent = node.parentElement
    if (parent && !parent.closest('.katex-mathml, annotation, [hidden], script, style') &&
      (!parent.closest('details:not([open])') || Boolean(parent.closest('summary')?.parentElement?.matches('details:not([open])')))) {
      const nextBlock = parent.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote, div, figcaption') ?? root
      if (nextBlock !== block || !groups.length) { groups.push([]); block = nextBlock }
      groups[groups.length - 1]!.push(node)
    } else block = null
    node = walker.nextNode() as Text | null
  }
  const ranges: Range[] = []
  for (const nodes of groups) {
    const text = nodes.map((node) => node.data).join('')
    for (const match of text.matchAll(expression)) {
      const start = match.index
      const end = start + match[0].length
      let offset = 0
      const range = document.createRange()
      for (const node of nodes) {
        const next = offset + node.length
        if (start >= offset && start < next) range.setStart(node, start - offset)
        if (end > offset && end <= next) { range.setEnd(node, end - offset); break }
        offset = next
      }
      ranges.push(range)
    }
  }
  return ranges
}

export const MarkdownReader = memo(function MarkdownReader({ projectId, paperId, title, markdown, readingPosition }: MarkdownReaderProps) {
  const articleRef = useRef<HTMLElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchRangesRef = useRef<Range[]>([])
  const userRangesRef = useRef<Range[]>([])
  const [fontSize, setFontSize] = useState(loadReaderFontSize)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const searchReturnRef = useRef<HTMLElement | null>(null)
  const tocButtonRef = useRef<HTMLButtonElement>(null)
  const tocRef = useRef<HTMLDivElement>(null)
  const [tocOpen, setTocOpen] = useState(false)
  const [headings, setHeadings] = useState<Array<{ title: string; level: number; element: HTMLElement }>>([])
  const localPosition = useRef<ReadingPosition>({ top: 0 })
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatch, setActiveMatch] = useState(0)
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState('')
  const reportLinkError = useCallback((message: string) => { setStatus('打开链接失败，请重试。'); setStatusError(message) }, [])
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    imageSource?: string
    text?: string
    range?: Range
  } | null>(null)

  const menuRef = useMenuFocus(Boolean(contextMenu), () => setContextMenu(null))
  useEffect(() => {
    if (composing) return
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 150)
    return () => clearTimeout(timer)
  }, [searchQuery, composing])
  useEffect(() => {
    if (!status || !status.startsWith('已')) return
    const timer = setTimeout(() => setStatus(''), 3000)
    return () => clearTimeout(timer)
  }, [status])
  useLayoutEffect(() => {
    const root = articleRef.current
    if (!root) return
    setHeadings(Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map((element) => ({
      title: element.textContent ?? '', level: Number(element.tagName.slice(1)), element
    })))
    const panel = root.closest<HTMLElement>('.reader-panel, .reader-window')
    if (!panel) return
    const position = readingPosition ?? localPosition.current
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6,pre,li,figure'))
    let adjusting = true
    const restore = (): void => {
      if (!adjusting) return
      const anchor = position.anchorIndex === undefined ? null : blocks[position.anchorIndex]
      if (anchor) panel.scrollTop += anchor.getBoundingClientRect().top - panel.getBoundingClientRect().top - (position.anchorOffset ?? 0)
      else panel.scrollTop = position.top
    }
    const remember = (): void => {
      position.top = panel.scrollTop
      const panelTop = panel.getBoundingClientRect().top
      const index = blocks.findIndex((block) => block.getBoundingClientRect().bottom > panelTop)
      if (index >= 0) {
        position.anchorIndex = index
        position.anchorOffset = blocks[index]!.getBoundingClientRect().top - panelTop
      }
    }
    const userScroll = (): void => { adjusting = false }
    const keyScroll = (event: KeyboardEvent): void => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) userScroll()
    }
    const scroll = (): void => { remember() }
    restore()
    panel.addEventListener('scroll', scroll)
    panel.addEventListener('wheel', userScroll, { passive: true })
    panel.addEventListener('touchstart', userScroll, { passive: true })
    panel.addEventListener('pointerdown', userScroll)
    panel.addEventListener('keydown', keyScroll)
    root.addEventListener('load', restore, true)
    return () => {
      if (panel.isConnected && root.isConnected) remember()
      panel.removeEventListener('scroll', scroll)
      panel.removeEventListener('wheel', userScroll)
      panel.removeEventListener('touchstart', userScroll)
      panel.removeEventListener('pointerdown', userScroll)
      panel.removeEventListener('keydown', keyScroll)
      root.removeEventListener('load', restore, true)
    }
  }, [projectId, paperId, markdown, readingPosition])
  useLayoutEffect(() => {
    const toc = tocRef.current
    if (!tocOpen || !toc) return
    const below = window.innerHeight - toc.getBoundingClientRect().top - 8
    if (below < 120) {
      toc.style.top = 'auto'
      toc.style.bottom = '100%'
      toc.style.maxHeight = `${Math.max(60, (tocButtonRef.current?.getBoundingClientRect().top ?? 0) - 8)}px`
    } else toc.style.maxHeight = `${Math.min(500, below)}px`
    toc.querySelector('button')?.focus({ preventScroll: true })
  }, [tocOpen])
  const openSearch = useCallback(() => {
    searchReturnRef.current = document.activeElement as HTMLElement | null
    setSearchOpen(true)
    window.requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(READER_FONT_SIZE_KEY, String(fontSize))
    } catch {
      // The reader remains adjustable when browser preferences are unavailable.
    }
  }, [fontSize])

  useEffect(() => {
    const handleSearch = (event: KeyboardEvent): void => {
      if (document.querySelector('dialog[open]') || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]'))) return
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      openSearch()
    }
    window.addEventListener('keydown', handleSearch)
    return () => window.removeEventListener('keydown', handleSearch)
  }, [])

  useEffect(() => {
    const registry = highlightRegistry()
    registry?.delete(SEARCH_HIGHLIGHT)
    registry?.delete(ACTIVE_SEARCH_HIGHLIGHT)
    searchRangesRef.current = []
    setMatchCount(0)
    setActiveMatch(0)
    const root = articleRef.current
    const query = debouncedQuery.trim()
    if (!searchOpen || !root || !query || composing) return
    const ranges = findTextRanges(root, query)
    searchRangesRef.current = ranges
    setMatchCount(ranges.length)
    if (registry) {
      registry.set(SEARCH_HIGHLIGHT, new Highlight(...ranges))
      if (ranges[0]) registry.set(ACTIVE_SEARCH_HIGHLIGHT, new Highlight(ranges[0]))
    }
    ranges[0]?.startContainer.parentElement?.scrollIntoView?.({ block: 'center' })
  }, [markdown, searchOpen, debouncedQuery, composing])

  useEffect(() => {
    const registry = highlightRegistry()
    const range = searchRangesRef.current[activeMatch]
    registry?.delete(ACTIVE_SEARCH_HIGHLIGHT)
    if (!range) return
    if (registry) registry.set(ACTIVE_SEARCH_HIGHLIGHT, new Highlight(range))
    const target = range.startContainer.parentElement
    target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [activeMatch])

  useEffect(() => {
    const registry = highlightRegistry()
    userRangesRef.current = []
    registry?.delete(USER_HIGHLIGHT)
  }, [markdown, paperId])

  useEffect(() => () => {
    const registry = highlightRegistry()
    registry?.delete(SEARCH_HIGHLIGHT)
    registry?.delete(ACTIVE_SEARCH_HIGHLIGHT)
    registry?.delete(USER_HIGHLIGHT)
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    const dismiss = (): void => setContextMenu(null)
    window.addEventListener('keydown', close)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [contextMenu])

  const closeSearch = (): void => {
    setSearchOpen(false)
    setSearchQuery('')
    setDebouncedQuery('')
    ;(searchReturnRef.current ?? searchButtonRef.current)?.focus()
  }

  const moveSearch = (direction: 1 | -1): void => {
    if (matchCount === 0) return
    if (matchCount === 1) searchRangesRef.current[0]?.startContainer.parentElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    setActiveMatch((current) => (current + direction + matchCount) % matchCount)
  }

  const openContextMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    const root = articleRef.current
    if (!root) return
    const target = event.target instanceof Element ? event.target : null
    const image = target?.closest<HTMLImageElement>('img[data-image-source]')
    const selection = window.getSelection()
    const selectedRange = selection && selection.rangeCount > 0 && !selection.isCollapsed
      ? selection.getRangeAt(0)
      : null
    const selectedNode = selectedRange?.commonAncestorContainer
    const selectionInside = selectedNode && root.contains(
      selectedNode.nodeType === Node.ELEMENT_NODE ? selectedNode : selectedNode.parentNode
    )
    if (!image && (!selectedRange || !selectionInside)) return
    event.preventDefault()
    const menuWidth = 154
    const menuHeight = 78
    setContextMenu({
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8)),
      ...(image?.dataset.imageSource
        ? { imageSource: image.dataset.imageSource }
        : { text: selection?.toString() ?? '', range: selectedRange!.cloneRange() })
    })
  }

  const copySelectedText = async (): Promise<void> => {
    const text = contextMenu?.text
    setContextMenu(null)
    if (!text) return
    try {
      await bridge().system.copyText(text)
      setStatusError('')
      setStatus('已复制文字')
    } catch (error) {
      setStatusError(errorMessage(error))
      setStatus('复制文字失败')
    }
  }

  const highlightSelectedText = (): void => {
    const range = contextMenu?.range
    setContextMenu(null)
    const registry = highlightRegistry()
    if (!range || !registry) {
      setStatus('当前环境不支持高亮')
      return
    }
    userRangesRef.current = [...userRangesRef.current, range]
    registry.set(USER_HIGHLIGHT, new Highlight(...userRangesRef.current))
    window.getSelection()?.removeAllRanges()
    setStatusError('')
      setStatus('已高亮文字')
  }

  const copySelectedImage = async (): Promise<void> => {
    const source = contextMenu?.imageSource
    setContextMenu(null)
    if (!source) return
    try {
      await bridge().papers.copyImage(projectId, paperId, source)
      setStatusError('')
      setStatus('已复制图片')
    } catch (error) {
      setStatusError(errorMessage(error))
      setStatus('复制图片失败')
    }
  }

  const openSelectedImage = async (): Promise<void> => {
    const source = contextMenu?.imageSource
    setContextMenu(null)
    if (!source) return
    try {
      await bridge().papers.openImage(projectId, paperId, source)
      setStatusError('')
      setStatus('已请求系统打开图片')
    } catch (error) {
      setStatusError(errorMessage(error))
      setStatus('打开图片失败')
    }
  }


  return (
    <>
      <div className="reader-tools" aria-label="阅读工具">
        <div className="reader-font-controls">
          <button
            type="button"
            aria-label="减小正文字号"
            disabled={fontSize <= MIN_READER_FONT_SIZE}
            onClick={() => setFontSize((value) => Math.max(MIN_READER_FONT_SIZE, value - 1))}
          >A−</button>
          <output aria-label="当前正文字号">{fontSize}px</output>
          <button
            type="button"
            aria-label="增大正文字号"
            disabled={fontSize >= MAX_READER_FONT_SIZE}
            onClick={() => setFontSize((value) => Math.min(MAX_READER_FONT_SIZE, value + 1))}
          >A+</button>
        </div>
        <button ref={searchButtonRef} type="button" className="reader-search-button" onClick={openSearch}>搜索正文</button>
        {headings.length > 0 && <button ref={tocButtonRef} type="button" aria-expanded={tocOpen} onClick={() => setTocOpen((value) => !value)}>目录</button>}
        {tocOpen && <div ref={tocRef} className="reader-toc" role="navigation" aria-label="章节目录" onKeyDown={(event) => {
          if (event.key === 'Escape') { setTocOpen(false); tocButtonRef.current?.focus({ preventScroll: true }) }
        }}>
          {headings.map((heading, index) => <button type="button" key={index} style={{ paddingLeft: 12 + (heading.level - 1) * 14 }} onClick={() => {
            heading.element.scrollIntoView?.({ block: 'start' }); setTocOpen(false); tocButtonRef.current?.focus({ preventScroll: true })
          }}>{heading.title}</button>)}
        </div>}
        {status && <div className="reader-tool-status" role="status"><span>{status}</span>
          {statusError && <details><summary>错误详情</summary>{statusError}</details>}
          <button type="button" className="text-button" aria-label="关闭阅读消息" onClick={() => { setStatus(''); setStatusError('') }}>×</button>
        </div>}
      </div>
      {searchOpen && (
        <div className="reader-find" role="search">
          <input
            ref={searchInputRef}
            type="search"
            aria-label="在正文中搜索"
            placeholder="在正文中搜索…"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || composing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                moveSearch(event.shiftKey ? -1 : 1)
              }
              if (event.key === 'Escape') closeSearch()
            }}
          />
          <span aria-live="polite">{searchQuery ? `${matchCount ? activeMatch + 1 : 0} / ${matchCount}` : '0 / 0'}</span>
          <button type="button" aria-label="上一个匹配" disabled={matchCount === 0} onClick={() => moveSearch(-1)}>↑</button>
          <button type="button" aria-label="下一个匹配" disabled={matchCount === 0} onClick={() => moveSearch(1)}>↓</button>
          <button type="button" aria-label="关闭正文搜索" onClick={closeSearch}>×</button>
        </div>
      )}
      <article
        className="markdown-reader"
        ref={articleRef}
        style={{ fontSize: `${fontSize}px` }}
        onContextMenu={openContextMenu}
      >
        <MarkdownBody projectId={projectId} paperId={paperId} title={title} markdown={markdown} onError={reportLinkError} />
      </article>
      {contextMenu && createPortal(
        <div className="reader-context-layer" onMouseDown={() => setContextMenu(null)}>
          <div
            ref={menuRef}
            className="reader-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {contextMenu.imageSource ? (
              <>
                <button type="button" role="menuitem" onClick={() => void copySelectedImage()}>复制图片</button>
                <button type="button" role="menuitem" onClick={() => void openSelectedImage()}>打开大图</button>
              </>
            ) : (
              <>
                <button type="button" role="menuitem" onClick={() => void copySelectedText()}>复制</button>
                <button type="button" role="menuitem" onClick={highlightSelectedText} title="仅本次阅读有效，关闭或刷新正文后清除">临时高亮</button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
})
