import { OLDER_TASK_WORDS, type UserTaskState } from '@slave-of-ai/domain'
import type { ProjectView } from '@slave-of-ai/control'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/** "3 Done and merged · 1 Being worked on" (design section 8), in the order the states first appear. */
export function taskCounts(tasks: NonNullable<ProjectView['older']>['tasks']): string {
  const counts = new Map<UserTaskState, number>()
  for (const task of tasks) counts.set(task.state, (counts.get(task.state) ?? 0) + 1)
  return [...counts].map(([state, count]) => `${String(count)} ${OLDER_TASK_WORDS[state]}`).join(' · ')
}

/**
 * Lead UX design section 8: a project still in the packages flow opens here, readable and not
 * driven -- an explanation, and its newest build's tasks in words.
 */
export function OlderTasks({ project }: { readonly project: ProjectView }): React.JSX.Element | null {
  const older = project.older
  if (older === null) return null
  return (
    <>
      <Alert data-testid="older-notice">
        <AlertTitle>This project uses the older way of building</AlertTitle>
        <AlertDescription>
          Many separate tasks, each with its own review. You can read it here; to drive it, use the command line, or switch it to the lead in Settings once its open work is finished.
          {older.pendingDecisions > 0 && ` ${String(older.pendingDecisions)} decision(s) wait for an answer: supervisor-decisions --workspace ${project.id}.`}
        </AlertDescription>
      </Alert>
      <Card data-testid="older-tasks">
        <CardHeader>
          <CardTitle className="text-base">Tasks</CardTitle>
          {older.tasks.length > 0 && <CardDescription>{taskCounts(older.tasks)}</CardDescription>}
        </CardHeader>
        <CardContent>
          {older.tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead className="w-44">State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {older.tasks.map((task) => (
                  <TableRow key={task.id} data-testid="older-task">
                    <TableCell className="whitespace-normal">{task.title}</TableCell>
                    <TableCell title={task.status} data-status={task.status} className="text-muted-foreground">
                      {OLDER_TASK_WORDS[task.state]}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  )
}
