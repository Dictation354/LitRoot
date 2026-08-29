import type { MouseEvent as ReactMouseEvent } from 'react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { isSafeLocalImageSource, safeMarkdownLink } from '../../shared/markdown-security'
import { bridge } from './bridge'

interface MarkdownReaderProps {
  projectId: string
  paperId: string
  markdown: string
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

export const MarkdownReader = memo(function MarkdownReader({ projectId, paperId, markdown }: MarkdownReaderProps) {
  const articleRef = useRef<HTMLElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchRangesRef = useRef<Range[]>([])
  const userRangesRef = useRef<Range[]>([])
  const [fontSize, setFontSize] = useState(loadReaderFontSize)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatch, setActiveMatch] = useState(0)
  const [status, setStatus] = useState('')
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    imageSource?: string
    text?: string
    range?: Range
  } | null>(null)

  useEffect(() => {
    try {
      window.localStorage.setItem(READER_FONT_SIZE_KEY, String(fontSize))
    } catch {
      // The reader remains adjustable when browser preferences are unavailable.
    }
  }, [fontSize])

  useEffect(() => {
    const openSearch = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      setSearchOpen(true)
      window.requestAnimationFrame(() => searchInputRef.current?.focus())
    }
    window.addEventListener('keydown', openSearch)
    return () => window.removeEventListener('keydown', openSearch)
  }, [])

  useEffect(() => {
    const registry = highlightRegistry()
    registry?.delete(SEARCH_HIGHLIGHT)
    registry?.delete(ACTIVE_SEARCH_HIGHLIGHT)
    searchRangesRef.current = []
    setMatchCount(0)
    setActiveMatch(0)
    const root = articleRef.current
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
    if (!searchOpen || !root || !normalizedQuery || !registry) return

    const ranges: Range[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const value = node.textContent ?? ''
      const normalizedValue = value.toLocaleLowerCase()
      let offset = normalizedValue.indexOf(normalizedQuery)
      while (offset >= 0) {
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + normalizedQuery.length)
        ranges.push(range)
        offset = normalizedValue.indexOf(normalizedQuery, offset + normalizedQuery.length)
      }
      node = walker.nextNode()
    }
    searchRangesRef.current = ranges
    setMatchCount(ranges.length)
    registry.set(SEARCH_HIGHLIGHT, new Highlight(...ranges))
    if (ranges[0]) registry.set(ACTIVE_SEARCH_HIGHLIGHT, new Highlight(ranges[0]))
  }, [markdown, searchOpen, searchQuery])

  useEffect(() => {
    const registry = highlightRegistry()
    const range = searchRangesRef.current[activeMatch]
    registry?.delete(ACTIVE_SEARCH_HIGHLIGHT)
    if (!registry || !range) return
    registry.set(ACTIVE_SEARCH_HIGHLIGHT, new Highlight(range))
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
  }

  const moveSearch = (direction: 1 | -1): void => {
    if (matchCount === 0) return
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
    const menuHeight = image ? 43 : 78
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
      setStatus('已复制文字')
    } catch {
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
    setStatus('已高亮文字')
  }

  const copySelectedImage = async (): Promise<void> => {
    const source = contextMenu?.imageSource
    setContextMenu(null)
    if (!source) return
    try {
      await bridge().papers.copyImage(projectId, paperId, source)
      setStatus('已复制图片')
    } catch {
      setStatus('复制图片失败')
    }
  }

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
            void bridge().system.openExternal(href)
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
  }), [paperId, projectId])

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
        <button type="button" className="reader-search-button" onClick={() => {
          setSearchOpen(true)
          window.requestAnimationFrame(() => searchInputRef.current?.focus())
        }}>搜索正文</button>
        {status && <span className="reader-tool-status" role="status">{status}</span>}
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
            onKeyDown={(event) => {
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
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkStandaloneMath, remarkInlineImages]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
          urlTransform={urlTransform}
          components={components}
        >
          {markdown}
        </ReactMarkdown>
      </article>
      {contextMenu && createPortal(
        <div className="reader-context-layer" onMouseDown={() => setContextMenu(null)}>
          <div
            className="reader-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {contextMenu.imageSource ? (
              <button type="button" role="menuitem" onClick={() => void copySelectedImage()}>复制图片</button>
            ) : (
              <>
                <button type="button" role="menuitem" onClick={() => void copySelectedText()}>复制</button>
                <button type="button" role="menuitem" onClick={highlightSelectedText}>高亮</button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
})
