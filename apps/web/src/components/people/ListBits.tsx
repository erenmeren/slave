'use client'

import { useEffect, useState } from 'react'
import { CheckIcon, ChevronsUpDownIcon, SearchIcon, XIcon } from 'lucide-react'
import type { DivisionFacet } from '@slave-of-ai/control'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { divisionMark, divisionParam, divisionWord } from './words'

/** A search box that tells its owner what was typed once the typing pauses, and clears on Escape. */
export function SearchBox({ value, onChange, placeholder, label, testId }: { readonly value: string; readonly onChange: (value: string) => void; readonly placeholder: string; readonly label: string; readonly testId: string }): React.JSX.Element {
  const [typed, setTyped] = useState(value)
  useEffect((): void => setTyped(value), [value])
  useEffect((): (() => void) | undefined => {
    if (typed === value) return undefined
    const timer = setTimeout(() => onChange(typed), 250)
    return (): void => clearTimeout(timer)
    // `onChange` is a new function each render; only what was typed restarts the wait.
  }, [typed])
  return (
    <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={label}
        placeholder={placeholder}
        className="pr-8 pl-8"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && typed !== '') {
            setTyped('')
            onChange('')
          }
        }}
        data-testid={testId}
      />
      {typed !== '' && (
        <button
          type="button"
          aria-label="Clear the search"
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setTyped('')
            onChange('')
          }}
        >
          <XIcon className="size-4" />
        </button>
      )}
    </div>
  )
}

/** One choice of a filter: what it is asked for by, how it reads, and how many rows carry it. */
export interface FilterOption {
  readonly value: string
  readonly label: string
  readonly mark?: string
  readonly count?: number
  /** More text the search may match and the row shows under the label. */
  readonly detail?: string
}

/** A filter as a searchable dropdown: "All …" when nothing is chosen, the choice when one is. */
export function FilterSelect({ all, value, options, onChange, testId, searchPlaceholder }: { readonly all: string; readonly value: string | null; readonly options: readonly FilterOption[]; readonly onChange: (value: string | null) => void; readonly testId: string; readonly searchPlaceholder: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const chosen = options.find((option) => option.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className={cn('max-w-[220px] justify-between font-normal', value !== null && 'border-primary/50 bg-accent text-accent-foreground')} data-testid={testId}>
          <span className="truncate">
            {chosen?.mark !== undefined && <span aria-hidden>{chosen.mark} </span>}
            {chosen?.label ?? (value === null ? all : 'One choice')}
          </span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={all}
                onSelect={() => {
                  setOpen(false)
                  onChange(null)
                }}
              >
                <CheckIcon className={value === null ? 'opacity-100' : 'opacity-0'} />
                {all}
              </CommandItem>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.detail ?? ''} ${option.value}`}
                  onSelect={() => {
                    setOpen(false)
                    onChange(option.value === value ? null : option.value)
                  }}
                  data-testid={`${testId}-option`}
                >
                  <CheckIcon className={option.value === value ? 'opacity-100' : 'opacity-0'} />
                  {option.mark !== undefined && <span aria-hidden>{option.mark}</span>}
                  <span className="truncate">{option.label}</span>
                  {option.count !== undefined && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{option.count}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function divisionOptions(divisions: readonly DivisionFacet[]): readonly FilterOption[] {
  return divisions.map((facet) => ({ value: divisionParam(facet.key), label: divisionWord(facet.key), mark: divisionMark(facet.key), count: facet.count }))
}

/** A filter that is on or off, as a button that stays pressed. */
export function FilterToggle({ on, onChange, children, testId }: { readonly on: boolean; readonly onChange: (on: boolean) => void; readonly children: React.ReactNode; readonly testId: string }): React.JSX.Element {
  return (
    <Button variant="outline" aria-pressed={on} className={cn('font-normal', on && 'border-primary/50 bg-accent text-accent-foreground')} onClick={() => onChange(!on)} data-testid={testId}>
      {on && <CheckIcon />}
      {children}
    </Button>
  )
}

/** The foot of a long list: how much of it is shown, and the button that reads the next page. */
export function ListFoot({ shown, total, noun, loading, onMore }: { readonly shown: number; readonly total: number; readonly noun: string; readonly loading: boolean; readonly onMore: () => void }): React.JSX.Element | null {
  if (total === 0) return null
  return (
    <div className="flex flex-col items-center gap-2 pt-2" data-testid="list-foot">
      <p className="text-xs text-muted-foreground tabular-nums">
        Showing {shown} of {total} {noun}
      </p>
      {shown < total && (
        <Button variant="outline" disabled={loading} onClick={onMore} data-testid="list-more">
          {loading ? 'Loading…' : `Show ${String(Math.min(total - shown, 48))} more`}
        </Button>
      )}
    </div>
  )
}
