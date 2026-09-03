/** Who is acting, when someone is (M23 Series F). Every control verb that appends an event or
 *  creates a task takes this as its trailing optional parameter; the web fills it from the
 *  session, the CLI passes nothing. Until Series F lands the type exists and is never populated. */
export interface Principal {
  readonly userId: string
}
