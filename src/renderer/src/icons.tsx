import type { JSX, ReactNode, SVGProps } from 'react'

export type IconName =
  | 'archive'
  | 'arrow-left'
  | 'book-open'
  | 'bot'
  | 'check'
  | 'chevron-down'
  | 'clock'
  | 'copy'
  | 'database'
  | 'external'
  | 'file'
  | 'folder'
  | 'folder-plus'
  | 'hash'
  | 'inbox'
  | 'layers'
  | 'link'
  | 'map-pin'
  | 'more'
  | 'note'
  | 'refresh'
  | 'search'
  | 'shield'
  | 'sparkles'
  | 'star'
  | 'terminal'
  | 'trash'
  | 'triangle-alert'
  | 'x'

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName
  size?: number
}

const paths: Record<IconName, ReactNode> = {
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" />
    </>
  ),
  'arrow-left': <path d="m15 18-6-6 6-6" />,
  'book-open': (
    <>
      <path d="M2.8 5.8A2.8 2.8 0 0 1 5.6 3H9a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H5.6a2.8 2.8 0 0 0-2.8 2.8Z" />
      <path d="M21.2 5.8A2.8 2.8 0 0 0 18.4 3H15a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3h3.4a2.8 2.8 0 0 1 2.8 2.8Z" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="7" width="16" height="13" rx="3" />
      <path d="M9 12h.01M15 12h.01M9 16h6M12 7V4M9.5 4h5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  external: (
    <>
      <path d="M15 3h6v6M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </>
  ),
  folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z" />,
  'folder-plus': (
    <>
      <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  hash: (
    <>
      <path d="M10 3 8 21M16 3l-2 18M4 9h17M3 15h17" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 4h16l2 11v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5Z" />
      <path d="M2 15h5l2 3h6l2-3h5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 9 5-9 5-9-5Z" />
      <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1" />
    </>
  ),
  'map-pin': (
    <>
      <path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  note: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 6v5h-5" />
      <path d="M19 11a8 8 0 1 0 1 5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3-1.2 3.3L7.5 7.5l3.3 1.2L12 12l1.2-3.3 3.3-1.2-3.3-1.2Z" />
      <path d="m18 13-.8 2.2L15 16l2.2.8L18 19l.8-2.2L21 16l-2.2-.8Z" />
      <path d="m5.5 12-.7 1.8-1.8.7 1.8.7.7 1.8.7-1.8 1.8-.7-1.8-.7Z" />
    </>
  ),
  star: <path d="m12 2.8 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.4 6.3-.9Z" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" />
    </>
  ),
  'triangle-alert': (
    <>
      <path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />
}

export function Icon({ name, size = 18, ...props }: IconProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      {...props}
    >
      {paths[name]}
    </svg>
  )
}
