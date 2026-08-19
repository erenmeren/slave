import type React from 'react'
import './globals.css'

export const metadata = { title: 'AI Team OS' }

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body className="flex min-h-screen">{children}</body>
    </html>
  )
}
