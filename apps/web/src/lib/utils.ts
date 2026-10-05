import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui's class joiner: conditional classes, with later Tailwind utilities winning a conflict. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
