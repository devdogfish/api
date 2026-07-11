import type { AuthVariables } from './middleware/auth'

export type AppEnv = {
  Bindings: Record<string, never>
  Variables: AuthVariables
}
