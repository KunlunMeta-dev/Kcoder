import { createContext, useContext } from 'react'
import type { User } from '@/types/api'

export interface AuthContextValue {
  user: User | null
  isLoading: boolean
  logout: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
