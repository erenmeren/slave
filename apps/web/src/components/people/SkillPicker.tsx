'use client'

import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import type { SkillUse } from '@slave-of-ai/control'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { skillSourceWord } from './words'

/**
 * A searchable list of the library's skills to pick one from. Skills somebody already has, and
 * ones whose files are gone, are left out; `skills` null means the library is still being read.
 */
export function SkillPicker({ skills, exclude, onPick, label, testId }: { readonly skills: readonly SkillUse[] | null; readonly exclude: readonly string[]; readonly onPick: (skill: SkillUse) => void; readonly label: string; readonly testId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const offered = (skills ?? []).filter((skill) => !skill.missing && !exclude.includes(skill.id))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-fit" data-testid={testId}>
          <PlusIcon />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(420px,calc(100vw-2rem))] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search skills…" />
          <CommandList>
            <CommandEmpty>{skills === null ? 'Loading…' : skills.length === 0 ? 'The skill library is empty.' : 'No skill matches.'}</CommandEmpty>
            <CommandGroup>
              {offered.map((skill) => (
                <CommandItem
                  key={skill.id}
                  value={`${skill.name} ${skill.providerName} ${skill.description}`}
                  onSelect={() => {
                    setOpen(false)
                    onPick(skill)
                  }}
                  data-testid="skill-option"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">
                      {skill.name}
                      <span className="text-xs text-muted-foreground"> · {skillSourceWord(skill.providerName)}</span>
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
