import type { SVGProps } from 'react'

export type IconName =
  | 'add'
  | 'book'
  | 'chevron-down'
  | 'columns'
  | 'folder'
  | 'library'
  | 'more'
  | 'refresh'
  | 'search'
  | 'unlink'
  | 'x'

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName
  size?: number
}

const paths: Record<IconName, React.ReactNode> = {
  add: <path d="M12 5v14M5 12h14" />,
  book: <><path d="M4 4h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4Z" /><path d="M20 4h-6a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h6Z" /></>,
  'chevron-down': <path d="m7 10 5 5 5-5" />,
  columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 4v16M15 4v16" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  library: <><path d="M4 5h4v15H4zM10 5h4v15h-4zM16 4l4-1 2 15-4 1z" /><path d="M3 21h19" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7.5 7.5 0 1 0 .5 5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  unlink: <><path d="m9 15-2 2a4 4 0 0 1-6-6l3-3a4 4 0 0 1 5-.6M15 9l2-2a4 4 0 0 1 6 6l-3 3a4 4 0 0 1-5 .6M8 2l8 20" /></>,
  x: <path d="m6 6 12 12M18 6 6 18" />
}

export function Icon({ name, size = 16, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {paths[name]}
    </svg>
  )
}
