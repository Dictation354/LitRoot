import { memo, useMemo } from 'react'
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

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []).filter((tagName) => !['picture', 'source'].includes(tagName)),
    'details', 'summary', 'figure', 'figcaption'
  ],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-[\w-]+$/]],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^math-(?:inline|display)$/]],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', /^math-display$/]],
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
    img: ({ src, alt }) => {
      const source = typeof src === 'string' ? src : ''
      if (!isSafeLocalImageSource(source)) {
        return <span className="blocked-image">远程或不安全图片已阻止{alt ? `：${alt}` : ''}</span>
      }
      return (
        <img
          src={bridge().papers.assetUrl(projectId, paperId, source)}
          alt={alt ?? ''}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )
    }
  }), [paperId, projectId])

  return (
    <article className="markdown-reader">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
        urlTransform={urlTransform}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  )
})
