import { Component, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { type Options as SanitizeOptions } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { safeExternalHttpUrl } from '../../shared/external-url'
import { isSafeMathSource } from '../../shared/math-render'

interface NoteAstNode {
  type?: string
  tagName?: string
  value?: unknown
  children?: NoteAstNode[]
  properties?: Record<string, unknown>
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
  [key: string]: unknown
}

const MAX_NOTE_FORMULAS = 200
const CURRENCY_FORMULA =
  /^[+-]?\d[\d,.]*(?:[\u00a0\s]+)(?:thousand|million|billion|trillion|dollars?|usd|cad|aud|euros?|yuan|renminbi|pounds?|sterling)\b/iu
const NOTE_MATH_CLASSES = new Set(['language-math', 'math-display', 'math-inline'])

const NOTE_SANITIZE_SCHEMA: SanitizeOptions = {
  allowComments: false,
  allowDoctypes: false,
  ancestors: {
    tbody: ['table'],
    td: ['tr'],
    tfoot: ['table'],
    th: ['tr'],
    thead: ['table'],
    tr: ['table', 'thead', 'tbody', 'tfoot']
  },
  attributes: {
    a: ['href', 'title'],
    code: [['className', 'math-inline', 'math-display']],
    ol: ['start'],
    td: [['align', 'left', 'right', 'center']],
    th: [['align', 'left', 'right', 'center']]
  },
  clobber: ['id', 'name'],
  clobberPrefix: 'paperrelay-note-',
  protocols: { href: ['http', 'https'] },
  required: {},
  strip: [
    'audio',
    'base',
    'button',
    'canvas',
    'dialog',
    'embed',
    'form',
    'iframe',
    'img',
    'input',
    'link',
    'math',
    'meta',
    'object',
    'option',
    'picture',
    'script',
    'select',
    'source',
    'style',
    'svg',
    'textarea',
    'video'
  ],
  tagNames: [
    'a',
    'abbr',
    'b',
    'blockquote',
    'br',
    'code',
    'del',
    'div',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'kbd',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    's',
    'samp',
    'small',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
    'var'
  ]
}

function rawMathNode(node: NoteAstNode): void {
  const display = node.type === 'math'
  node.type = 'text'
  node.value = display ? `$$${String(node.value)}$$` : `$${String(node.value)}$`
  delete node.children
  delete node.data
}

function remarkGuardNoteMath(): (tree: NoteAstNode) => void {
  return (tree) => {
    let formulaCount = 0
    const visit = (node: NoteAstNode): void => {
      if (node.type === 'math' || node.type === 'inlineMath') {
        formulaCount += 1
        if (
          typeof node.value !== 'string' ||
          formulaCount > MAX_NOTE_FORMULAS ||
          !isSafeMathSource(node.value) ||
          (node.type === 'inlineMath' && CURRENCY_FORMULA.test(node.value.trim()))
        ) {
          rawMathNode(node)
        }
        return
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

function classNames(node: NoteAstNode): string[] {
  const value = node.properties?.className
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? value.split(/\s+/u).filter(Boolean) : []
}

function nodeText(node: NoteAstNode): string {
  if (node.type === 'text') return typeof node.value === 'string' ? node.value : ''
  return node.children?.map(nodeText).join('') ?? ''
}

function sourceSlice(markdown: string, node: NoteAstNode): string | null {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    start < 0 ||
    end < start ||
    end > markdown.length
  ) {
    return null
  }
  return markdown.slice(start, end)
}

function hasExpectedMathDelimiters(source: string | null, display: boolean): boolean {
  if (!source) return false
  const trimmed = source.trim()
  if (display) return trimmed.startsWith('$$') && trimmed.endsWith('$$')
  return trimmed.startsWith('$') && !trimmed.startsWith('$$') && trimmed.endsWith('$')
}

/**
 * Only delimiter-created math may reach KaTeX. Raw HTML and fenced code can
 * otherwise spoof remark-math's CSS classes after rehypeRaw has parsed them.
 */
function rehypeGuardNoteMath(options: { markdown: string }): (tree: NoteAstNode) => void {
  return (tree) => {
    let formulaCount = 0

    const visit = (node: NoteAstNode, parent?: NoteAstNode): void => {
      if (node.type === 'element') {
        const classes = classNames(node)
        const inline = classes.includes('math-inline')
        const display = classes.includes('math-display')
        const hasMathClass = inline || display || classes.includes('language-math')

        if (hasMathClass) {
          const positionedNode = display && parent?.tagName === 'pre' ? parent : node
          const value = nodeText(node)
          const trustedDelimiterSource =
            (inline || display) &&
            hasExpectedMathDelimiters(
              sourceSlice(options.markdown, positionedNode),
              display
            )

          if (trustedDelimiterSource) formulaCount += 1
          const allowed =
            trustedDelimiterSource &&
            formulaCount <= MAX_NOTE_FORMULAS &&
            isSafeMathSource(value)

          const remainingClasses = classes.filter(
            (className) => !NOTE_MATH_CLASSES.has(className)
          )
          if (allowed) remainingClasses.push(display ? 'math-display' : 'math-inline')

          if (remainingClasses.length > 0) {
            node.properties = { ...node.properties, className: remainingClasses }
          } else if (node.properties) {
            const { className: _className, ...remainingProperties } = node.properties
            node.properties = remainingProperties
          }
        }
      }

      node.children?.forEach((child) => visit(child, node))
    }

    visit(tree)
  }
}

const noteUrlTransform: UrlTransform = (url, key) =>
  key === 'href' ? safeExternalHttpUrl(url) : null

function NoteLink({
  children,
  href,
  title
}: {
  children?: ReactNode
  href?: string | undefined
  title?: string | undefined
}): React.JSX.Element {
  const safeHref = safeExternalHttpUrl(href)
  if (!safeHref) return <span className="note-inert-link">{children}</span>

  return (
    <a
      href={safeHref}
      referrerPolicy="no-referrer"
      rel="noopener noreferrer"
      target="_blank"
      title={title}
    >
      {children}
    </a>
  )
}

const noteComponents: Components = {
  a: ({ children, href, title }) => (
    <NoteLink href={href} title={title ?? undefined}>
      {children}
    </NoteLink>
  ),
  code: ({ children, node, ...properties }) => (
    <code {...properties}>
      {node ? nodeText(node as unknown as NoteAstNode) : children}
    </code>
  ),
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h4>{children}</h4>,
  h5: ({ children }) => <h4>{children}</h4>,
  h6: ({ children }) => <h4>{children}</h4>,
  table: ({ children, node: _node, ...properties }) => (
    <div className="note-table-scroll">
      <table {...properties}>{children}</table>
    </div>
  ),
  th: ({ children, node: _node, ...properties }) => (
    <th {...properties} scope="col">
      {children}
    </th>
  )
}

function NoteMarkup({ markdown }: { markdown: string }): React.JSX.Element {
  return (
    <div className="note-preview-content">
      <ReactMarkdown
        components={noteComponents}
        rehypePlugins={[
          rehypeRaw,
          [rehypeGuardNoteMath, { markdown }],
          [rehypeSanitize, NOTE_SANITIZE_SCHEMA],
          [
            rehypeKatex,
            {
              maxExpand: 1_000,
              maxSize: 20,
              output: 'htmlAndMathml',
              strict: 'ignore',
              throwOnError: false,
              trust: false
            }
          ]
        ]}
        remarkPlugins={[remarkGfm, remarkMath, remarkGuardNoteMath]}
        urlTransform={noteUrlTransform}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

class NotePreviewBoundary extends Component<
  { children: ReactNode; markdown: string },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidUpdate(previous: Readonly<{ markdown: string }>): void {
    if (this.state.failed && previous.markdown !== this.props.markdown) {
      this.setState({ failed: false })
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="note-preview-fallback">
          <strong>Preview unavailable</strong>
          <pre>{this.props.markdown}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

export function NotePreview({ markdown }: { markdown: string }): React.JSX.Element {
  if (!markdown.trim()) {
    return <div className="note-preview-empty">Nothing to preview yet.</div>
  }

  return (
    <NotePreviewBoundary markdown={markdown}>
      <NoteMarkup markdown={markdown} />
    </NotePreviewBoundary>
  )
}
