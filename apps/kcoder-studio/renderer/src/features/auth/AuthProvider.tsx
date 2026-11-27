import { useState, type ReactNode } from 'react'
import { removeToken } from '@/api/auth'
import { getLocalUser } from '@/api/local/localSession'
import {
  isKCoderDesktopHostPage,
  isKCoderGatewayPage,
  submitKCoderGatewayLogout,
} from '@/kcoder/gatewayRpc'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import { AuthContext } from './useAuth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState(() =>
    isKCoderGatewayPage() || isLocalFirstAppRuntime() ? getLocalUser() : null
  )

  function logout() {
    if (isKCoderGatewayPage() && !isKCoderDesktopHostPage()) {
      submitKCoderGatewayLogout()
      return
    }
    removeToken()
    if (user) setUser(getLocalUser())
  }

  return (
    <AuthContext.Provider value={{ user, isLoading: false, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
