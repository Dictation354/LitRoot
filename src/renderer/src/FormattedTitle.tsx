import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'

const titleSchema = {
  tagNames: ['p', 'em', 'strong', 'i', 'b', 'sub', 'sup', 'scp'],
  attributes: {}
}

interface FormattedTitleProps {
  children: string
}

export function FormattedTitle({ children }: FormattedTitleProps) {
  return (
    <span className="formatted-title">
      <ReactMarkdown
        rehypePlugins={[rehypeRaw, [rehypeSanitize, titleSchema]]}
        components={{ p: ({ children: content }) => <>{content}</> }}
      >
        {children}
      </ReactMarkdown>
    </span>
  )
}
