// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LitRootBridge } from '../../src/shared/contracts.js'
import { FormattedTitle } from '../../src/renderer/src/FormattedTitle.js'
import { MarkdownReader, findTextRanges } from '../../src/renderer/src/MarkdownReader.js'
import { transportFor } from '../renderer-transport.js'

const markdownRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('react-markdown', async (original) => {
  const module = await original<typeof import('react-markdown')>()
  return { ...module, default: (props: React.ComponentProps<typeof module.default>) => {
    markdownRenders.count += 1
    return createElement(module.default, props)
  } }
})

describe('safe Markdown reader', () => {
  it('adjusts and remembers font size, searches text, highlights selections and copies images', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const highlights = new Map<string, unknown>()
    class TestHighlight {
      constructor(..._ranges: Range[]) {}
    }
    vi.stubGlobal('Highlight', TestHighlight)
    vi.stubGlobal('CSS', {
      highlights: {
        set: (key: string, value: unknown) => highlights.set(key, value),
        get: (key: string) => highlights.get(key),
        has: (key: string) => highlights.has(key),
        delete: (key: string) => highlights.delete(key),
        clear: () => highlights.clear(),
        keys: () => highlights.keys(),
        values: () => highlights.values(),
        entries: () => highlights.entries(),
        forEach: (callback: (value: unknown, key: string) => void) => highlights.forEach(callback),
        get size() { return highlights.size },
        [Symbol.iterator]: () => highlights[Symbol.iterator]()
      }
    })
    let copiedImage = ''
    let copiedText = ''
    const openImage = vi.fn(async (_projectId: string, _paperId: string, _source: string) => undefined)
    window.localStorage.clear()
    window.litroot = transportFor({
      system: {
        copyText: async (text: string) => { copiedText = text }
      },
      papers: {
        openImage,
        copyImage: async (_projectId: string, _paperId: string, source: string) => {
          copiedImage = source
        },
        assetUrl: (_projectId: string, _paperId: string, source: string) => `litroot-asset://paper/${source}`
      }
    } as unknown as LitRootBridge)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <MarkdownReader
            projectId="project_aaaaaaaaaaaaaaaaaaaaaaaa"
            paperId="paper_bbbbbbbbbbbbbbbbbbbbbbbb"
            title="Test paper"
            markdown={'Alpha body alpha\n\n![Figure](assets/figure.png)'}
          />
        )
      })
      const article = container.querySelector<HTMLElement>('.markdown-reader')!
      expect(article.style.fontSize).toBe('18px')
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="增大正文字号"]')?.click()
      })
      expect(article.style.fontSize).toBe('19px')
      expect(window.localStorage.getItem('litroot.reader-font-size')).toBe('19')

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      })
      const search = container.querySelector<HTMLInputElement>('[aria-label="在正文中搜索"]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'alpha')
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await Promise.resolve()
      })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 170)) })
      expect(container.querySelector('.reader-find span')?.textContent).toBe('1 / 2')

      const paragraph = article.querySelector('p')!
      const text = paragraph.firstChild!
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 5)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      await act(async () => {
        paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))
      })
      const copyText = [...document.body.querySelectorAll<HTMLButtonElement>('.reader-context-menu button')]
        .find((button) => button.textContent === '复制')
      await act(async () => { copyText?.click() })
      expect(copiedText).toBe('Alpha')

      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      await act(async () => {
        paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))
      })
      const highlightButton = [...document.body.querySelectorAll<HTMLButtonElement>('.reader-context-menu button')]
        .find((button) => button.textContent === '临时高亮')
      await act(async () => { highlightButton?.click() })
      expect(highlights.has('litroot-user-highlight')).toBe(true)

      const image = article.querySelector<HTMLImageElement>('img')!
      await act(async () => {
        image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))
      })
      const copyImage = document.body.querySelector<HTMLButtonElement>('.reader-context-menu button')
      await act(async () => { copyImage?.click() })
      expect(copiedImage).toBe('assets/figure.png')

      await act(async () => {
        image.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, clientX: window.innerWidth, clientY: window.innerHeight
        }))
      })
      const menu = document.body.querySelector<HTMLElement>('.reader-context-menu')!
      expect(Number.parseFloat(menu.style.top) + 78).toBeLessThanOrEqual(window.innerHeight - 8)
      const openImageButton = [...menu.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '打开大图')!
      expect(openImageButton).toBeDefined()
      await act(async () => { openImageButton.click() })
      expect(openImage).toHaveBeenCalledWith(
        'project_aaaaaaaaaaaaaaaaaaaaaaaa', 'paper_bbbbbbbbbbbbbbbbbbbbbbbb', 'assets/figure.png'
      )
      expect(document.body.querySelector('.reader-context-menu')).toBeNull()
      expect(container.querySelector('[role="status"] > span')?.textContent).toBe('已请求系统打开图片')

      openImage.mockRejectedValueOnce(new Error('No default viewer'))
      await act(async () => {
        image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      })
      await act(async () => {
        const button = [...document.body.querySelectorAll<HTMLButtonElement>('.reader-context-menu button')]
          .find((item) => item.textContent === '打开大图')!
        button.click()
      })
      expect(document.body.querySelector('.reader-context-menu')).toBeNull()
      expect(container.querySelector('[role="status"] > span')?.textContent).toBe('打开图片失败')
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
      window.localStorage.clear()
      delete window.litroot
      vi.unstubAllGlobals()
      globalThis.IS_REACT_ACT_ENVIRONMENT = false
    }
  })

  it('removes active HTML and dangerous links and does not request remote images', () => {
    const html = renderToStaticMarkup(
      <MarkdownReader
        projectId="project_aaaaaaaaaaaaaaaaaaaaaaaa"
        paperId="paper_bbbbbbbbbbbbbbbbbbbbbbbb"
        title="Test paper"
        markdown={'<script>alert(1)</script>\n<a href="javascript:alert(2)" onclick="steal()">bad</a>\n![remote](https://evil.test/tracker.png)\n<picture><source srcset="https://evil.test/source.png"><img src="https://evil.test/fallback.png"></picture>'}
      />
    )
    expect(html).not.toMatch(/<script|onclick|javascript:/i)
    expect(html).not.toContain('https://evil.test/tracker.png')
    expect(html).not.toContain('https://evil.test/source.png')
    expect(html).not.toContain('<source')
    expect(html).toContain('远程或不安全图片已阻止')
  })

  it('renders GFM tables, fenced code and KaTeX output', () => {
    const html = renderToStaticMarkup(
      <MarkdownReader
        projectId="project_aaaaaaaaaaaaaaaaaaaaaaaa"
        paperId="paper_bbbbbbbbbbbbbbbbbbbbbbbb"
        title="Test paper"
        markdown={'| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst safe = true\n```\n\n$E = mc^2$'}
      />
    )
    expect(html).toContain('<table>')
    expect(html).toContain('language-ts')
    expect(html).toContain('class="katex"')
  })

  it('renders a standalone formula in display mode while keeping prose math inline', () => {
    const displayHtml = renderToStaticMarkup(
      <MarkdownReader
        projectId="project_aaaaaaaaaaaaaaaaaaaaaaaa"
        paperId="paper_bbbbbbbbbbbbbbbbbbbbbbbb"
        title="Test paper"
        markdown={'$T_c - T_a = \\frac{R_n - G}{g_c C_p + g_H C_p VPD}$'}
      />
    )
    const inlineHtml = renderToStaticMarkup(
      <MarkdownReader
        projectId="project_aaaaaaaaaaaaaaaaaaaaaaaa"
        paperId="paper_bbbbbbbbbbbbbbbbbbbbbbbb"
        title="Test paper"
        markdown={'The relation $E = mc^2$ remains inline.'}
      />
    )
    expect(displayHtml).toContain('class="katex-display"')
    expect(inlineHtml).not.toContain('class="katex-display"')
  })

  it('lays out image formulas according to their Markdown source line', () => {
    vi.stubGlobal('window', {
      litroot: {
        papers: {
          assetUrl: (_projectId: string, _paperId: string, source: string) => `litroot-asset://paper/${source}`
        }
      }
    })
    const render = (markdown: string) => renderToStaticMarkup(
      <MarkdownReader
        projectId="project_aaaaaaaaaaaaaaaaaaaaaaaa"
        paperId="paper_bbbbbbbbbbbbbbbbbbbbbbbb"
        title="Test paper"
        markdown={markdown}
      />
    )

    try {
      expect(render('Before ![formula](assets/formula.png) after.')).toContain('class="markdown-image-inline"')
      expect(render('Before ![formula][f] after.\n\n[f]: assets/formula.png')).toContain('class="markdown-image-inline"')
      expect(render('![formula](assets/formula.png)')).not.toContain('markdown-image-inline')
      expect(render('Before\n  ![formula](assets/formula.png)  \nafter.')).not.toContain('markdown-image-inline')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders sanitized scientific title markup and decoded entities', () => {
    const html = renderToStaticMarkup(
      <FormattedTitle>
        {'Fluxes of <scp>CO<sub>2</sub></scp> &amp; H<sub>2</sub>O<script>alert(1)</script>'}
      </FormattedTitle>
    )
    expect(html).toContain('<scp>CO<sub>2</sub></scp> &amp; H<sub>2</sub>O')
    expect(html).not.toMatch(/script|alert/i)
  })

  it('omits only a leading level-one heading that duplicates the page title', () => {
    const render = (markdown: string) => renderToStaticMarkup(
      <MarkdownReader
        projectId="project_aaaaaaaaaaaaaaaaaaaaaaaa"
        paperId="paper_bbbbbbbbbbbbbbbbbbbbbbbb"
        title="Fluxes of CO2 & H2O"
        markdown={markdown}
      />
    )

    const duplicate = render('# Fluxes of CO2 &amp; H2O\n\n## Abstract\n\nBody')
    expect(duplicate).not.toContain('<h1>')
    expect(duplicate).toContain('<h2>Abstract</h2>')

    const distinct = render('# Introduction\n\nBody')
    expect(distinct).toContain('<h1>Introduction</h1>')
  })
})

it('matches visible inline phrases and literal special characters without Unicode offset corruption', () => {
  const article = document.createElement('article')
  article.innerHTML = '<p>Alpha <strong>bold</strong> <em>and</em> <a>linked</a> phrase. İX [a+b].</p><p>Next paragraph</p><span class="katex-mathml">duplicate</span><span class="katex-html">duplicate</span>'
  expect(findTextRanges(article, 'bold and linked').map((range) => range.toString())).toEqual(['bold and linked'])
  expect(findTextRanges(article, 'x').map((range) => range.toString())).toEqual(['X', 'x'])
  expect(findTextRanges(article, 'İx').map((range) => range.toString())).toEqual(['İX'])
  expect(findTextRanges(article, '[a+b]').map((range) => range.toString())).toEqual(['[a+b]'])
  expect(findTextRanges(article, 'phrase. İX [a+b].Next')).toHaveLength(0)
  expect(findTextRanges(article, 'duplicate')).toHaveLength(1)
})

it('debounces replacement queries, locates each first result, supports IME and restores search and TOC focus', async () => {
  vi.useFakeTimers()
  const scroll = vi.fn()
  HTMLElement.prototype.scrollIntoView = scroll
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<MarkdownReader projectId="p" paperId="one" title="Title" markdown={'## First\n\nAlpha **beta**\n\n### Second\n\nBeta 中文'} />))
    const tocButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '目录')!
    tocButton.focus()
    await act(async () => tocButton.click())
    const toc = container.querySelector('.reader-toc')!
    expect(toc.querySelectorAll('button')).toHaveLength(2)
    expect(document.activeElement).toBe(toc.querySelector('button'))
    await act(async () => toc.querySelectorAll('button')[1]!.click())
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.reader-toc')).toBeNull()
    expect(document.activeElement).toBe(tocButton)
    await act(async () => tocButton.click())
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('.reader-toc')).toBeNull()
    const searchButton = container.querySelector<HTMLButtonElement>('.reader-search-button')!
    searchButton.focus()
    await act(async () => searchButton.click())
    await act(async () => vi.advanceTimersByTimeAsync(20))
    const input = container.querySelector<HTMLInputElement>('.reader-find input')!
    const enter = async (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await enter('alpha')
    await enter('beta')
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(container.querySelector('.reader-find span')?.textContent).toBe('1 / 2')
    expect(scroll).toHaveBeenCalledTimes(2)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(container.querySelector('.reader-find span')?.textContent).toBe('2 / 2')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })))
    expect(container.querySelector('.reader-find span')?.textContent).toBe('1 / 2')
    await enter('alpha')
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(scroll).toHaveBeenCalledTimes(5)
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    await enter('中文')
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(container.querySelector('.reader-find span')?.textContent).toBe('0 / 0')
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(container.querySelector('.reader-find span')?.textContent).toBe('1 / 1')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.activeElement).toBe(searchButton)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
  }
})

it('parses a long body only once while adjusting tools and font size', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const markdown = Array.from({ length: 1000 }, (_, index) => `## Section ${index}\n\nLong paragraph **bold ${index}** with a [link](https://example.org).`).join('\n\n')
  const before = markdownRenders.count
  const start = performance.now()
  try {
    await act(async () => root.render(<MarkdownReader projectId="p" paperId="one" title="Title" markdown={markdown} />))
    const parsedAt = performance.now()
    expect(markdownRenders.count - before).toBe(1)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="增大正文字号"]')?.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.reader-search-button')?.click())
    expect(markdownRenders.count - before).toBe(1)
    console.log(`Long Markdown ${markdown.length} characters: mount ${(parsedAt - start).toFixed(1)} ms, tools ${(performance.now() - parsedAt).toFixed(1)} ms, body parses 1`)
  } finally { await act(async () => root.unmount()); container.remove() }
})
