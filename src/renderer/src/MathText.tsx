import {
  type AuthorYearReferenceAlias,
  linkableCitationParts,
  referenceAnchorId
} from '../../shared/citation-crossrefs'
import { renderMathTokenToHtml } from '../../shared/math-render'
import { tokenizeMathText, type FormulaMathTextToken } from '../../shared/math-text'

function MathFormula({ token }: { token: FormulaMathTextToken }): React.JSX.Element {
  const markup = renderMathTokenToHtml(token)
  if (!markup) return <code className="paper-math-fallback">{token.raw}</code>

  return (
    <span
      className={`paper-math${token.display ? ' paper-math-display' : ''}`}
      data-tex={token.value}
      // KaTeX escapes source text and `trust: false` disables URL/HTML commands.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}

function PlainText({
  text,
  referenceNumbers,
  referenceAliases,
  linkNumericCitations
}: {
  text: string
  referenceNumbers: readonly number[]
  referenceAliases: readonly AuthorYearReferenceAlias[]
  linkNumericCitations: boolean
}): React.JSX.Element {
  return (
    <>
      {linkableCitationParts(text, referenceNumbers, referenceAliases, {
        numeric: linkNumericCitations
      }).map((part, index) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <a
            aria-label={
              part.referenceNumbers.length === 1
                ? `Reference ${part.targetNumber}`
                : `References ${part.referenceNumbers.join(', ')}`
            }
            className="paper-citation-link"
            data-reference-numbers={part.referenceNumbers.join(',')}
            href={`#${referenceAnchorId(part.targetNumber)}`}
            key={`${index}-${part.text}`}
            title={
              part.referenceNumbers.length === 1
                ? `Go to reference ${part.targetNumber}`
                : `Go to references ${part.referenceNumbers.join(', ')}`
            }
          >
            {part.text}
          </a>
        )
      )}
    </>
  )
}

export function MathText({
  text,
  referenceNumbers = [],
  referenceAliases = [],
  linkNumericCitations = true
}: {
  text: string
  referenceNumbers?: readonly number[]
  referenceAliases?: readonly AuthorYearReferenceAlias[]
  linkNumericCitations?: boolean
}): React.JSX.Element {
  return (
    <>
      {tokenizeMathText(text).map((token, index) =>
        token.kind === 'text' ? (
          <PlainText
            key={`${index}-${token.value}`}
            linkNumericCitations={linkNumericCitations}
            referenceAliases={referenceAliases}
            referenceNumbers={referenceNumbers}
            text={token.value}
          />
        ) : (
          <MathFormula key={`${index}-${token.raw}`} token={token} />
        )
      )}
    </>
  )
}
