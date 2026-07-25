import { useCallback, useEffect, useRef, useState } from 'react'
import { AxiosError } from 'axios'
import { ArrowRight, Eye, EyeOff, GraduationCap, LoaderCircle, Lock, Mail } from 'lucide-react'

import backgroundUrl from '../assets/canvex-paper-bg.png'
import { getAuthConfig, googleLogin, institutionalRegister, login, register } from '../lib/api'
import type { AuthConfig, AuthSession } from '../types'

type AuthPanelProps = {
  onAuthenticated: (session: AuthSession) => void
}

// ── Google Identity Services (loaded on demand only when configured) ────────
type GoogleCredentialResponse = { credential?: string }
type GoogleIdConfig = { client_id: string; callback: (response: GoogleCredentialResponse) => void }
type GoogleButtonOptions = {
  theme?: string
  size?: string
  width?: number
  text?: string
  shape?: string
  logo_alignment?: string
}
type GoogleAccountsId = {
  initialize: (config: GoogleIdConfig) => void
  renderButton: (parent: HTMLElement, options: GoogleButtonOptions) => void
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } }
  }
}

const GOOGLE_SCRIPT_SRC = 'https://accounts.google.com/gsi/client'
let googleScriptPromise: Promise<void> | null = null

const loadGoogleScript = (): Promise<void> => {
  if (window.google?.accounts?.id) return Promise.resolve()
  if (googleScriptPromise) return googleScriptPromise
  googleScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GOOGLE_SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => {
      googleScriptPromise = null
      reject(new Error('Failed to load Google Identity Services'))
    }
    document.head.appendChild(script)
  })
  return googleScriptPromise
}

const describeAuthError = (err: unknown, fallback: string): string => {
  const axiosError = err instanceof AxiosError ? err : null
  const detail = axiosError?.response?.data?.detail
  if (axiosError && !axiosError.response) {
    // Request left the browser but no response came back → the API is
    // unreachable (wrong VITE_API_URL, backend asleep, or CORS blocked).
    return "Couldn't reach the server. It may be waking up — wait a few seconds and try again."
  }
  if (typeof detail === 'string') return detail // e.g. "Email is already registered"
  return fallback
}

const emailIsInstitutional = (email: string, domains: string[]): boolean => {
  const domain = (email.split('@')[1] ?? '').trim().toLowerCase()
  if (!domain || !domain.includes('.')) return false
  // "edu"/"ac" must be the TLD (.edu) or second level (.edu.bd, .ac.uk) — not
  // just any label, or "edu.attacker.com" would pass. Matches the backend.
  const labels = domain.split('.')
  const tld = labels[labels.length - 1]
  const sld = labels[labels.length - 2]
  if (tld === 'edu' || tld === 'ac' || sld === 'edu' || sld === 'ac') return true
  // Configured extras only *add* non-academic institutional domains.
  return domains.some((raw) => {
    const d = raw.trim().toLowerCase().replace(/^\.+/, '')
    return d !== '' && (domain === d || domain.endsWith('.' + d))
  })
}

const defaultState = { email: '', displayName: '', password: '' }
const disabledConfig: AuthConfig = { google_enabled: false, google_client_id: '', institutional_domains: [] }

const AuthPanel = ({ onAuthenticated }: AuthPanelProps) => {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [form, setForm] = useState(defaultState)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [institutional, setInstitutional] = useState(false)
  const [authConfig, setAuthConfig] = useState<AuthConfig>(disabledConfig)
  const googleButtonRef = useRef<HTMLDivElement | null>(null)

  const domainsLabel = authConfig.institutional_domains.length
    ? `.edu / .ac / ${authConfig.institutional_domains.join(' / ')}`
    : '.edu / .ac'
  const institutionalHint = `Use your institutional email (${domainsLabel}), e.g. name@university.ac.bd.`

  const showComingSoon = (feature: string) => {
    setError('')
    setNotice(`${feature} is coming soon.`)
  }

  useEffect(() => {
    let active = true
    getAuthConfig().then((config) => {
      if (active) setAuthConfig(config)
    })
    return () => {
      active = false
    }
  }, [])

  const handleGoogleCredential = useCallback(
    async (response: GoogleCredentialResponse) => {
      if (!response.credential) return
      setError('')
      setNotice('')
      setIsSubmitting(true)
      try {
        onAuthenticated(await googleLogin(response.credential))
      } catch (err) {
        setError(describeAuthError(err, 'Google sign-in failed. Please try again.'))
      } finally {
        setIsSubmitting(false)
      }
    },
    [onAuthenticated],
  )

  // Render Google's official button once we know a client ID is configured.
  useEffect(() => {
    if (!authConfig.google_enabled || !authConfig.google_client_id) return
    let cancelled = false
    loadGoogleScript()
      .then(() => {
        if (cancelled || !window.google || !googleButtonRef.current) return
        window.google.accounts.id.initialize({
          client_id: authConfig.google_client_id,
          callback: handleGoogleCredential,
        })
        googleButtonRef.current.innerHTML = ''
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: 'outline',
          size: 'large',
          width: 320,
          text: 'continue_with',
          shape: 'pill',
          logo_alignment: 'center',
        })
      })
      .catch(() => {
        // Script blocked/offline — the standard email form still works.
      })
    return () => {
      cancelled = true
    }
  }, [authConfig, handleGoogleCredential])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setNotice('')

    // Only gate account *creation* by domain — an existing account can always
    // sign in regardless of how its email looks.
    if (institutional && mode === 'register' && !emailIsInstitutional(form.email, authConfig.institutional_domains)) {
      setError(institutionalHint)
      return
    }

    setIsSubmitting(true)
    try {
      let session: AuthSession
      if (mode === 'login') {
        session = await login(form.email, form.password)
      } else if (institutional) {
        session = await institutionalRegister(form.email, form.displayName, form.password)
      } else {
        session = await register(form.email, form.displayName, form.password)
      }
      onAuthenticated(session)
    } catch (err) {
      setError(
        describeAuthError(
          err,
          mode === 'register'
            ? 'Registration failed. Please check your details and try again.'
            : 'Authentication failed. Please check your details and try again.',
        ),
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="auth-notebook min-h-screen text-slate-950">
      <img src={backgroundUrl} alt="" className="auth-notebook-art" aria-hidden="true" />
      <div className="auth-notebook-lines" />
      <div className="paper-margin-line" />

      <main className="auth-ink-login">
        <h1 className="stamped-logo text-center font-reading-serif text-5xl font-normal uppercase leading-none tracking-[0.16em] text-indigo-950/20 sm:text-6xl">
          Canvex
        </h1>
        <p className="mt-2 font-handwriting text-xl text-indigo-800/45">
          collaborative research canvas
        </p>

        <div className="auth-tab-shell mt-9 w-full">
          <div className="grid grid-cols-2">
            <button
              type="button"
              onClick={() => {
                setMode('login')
                setError('')
                setNotice('')
              }}
              className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register')
                setError('')
                setNotice('')
              }}
              className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            >
              Create Account
            </button>
          </div>
        </div>

        {institutional && (
          <div className="mt-5 flex w-full items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50/70 px-4 py-2 text-sm text-indigo-800 backdrop-blur-sm">
            <span className="flex items-center gap-2 font-semibold">
              <GraduationCap size={16} />
              {mode === 'register'
                ? `New institutional account — use your ${domainsLabel} email`
                : `Institutional sign-in — use your ${domainsLabel} email`}
            </span>
            <button
              type="button"
              className="shrink-0 font-handwriting text-base text-indigo-700 underline decoration-indigo-400/50"
              onClick={() => {
                setInstitutional(false)
                setError('')
              }}
            >
              standard sign-in
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-6 w-full space-y-5">
          <div className="ink-field">
            <label className="auth-label" htmlFor="email">
              Email Address
            </label>
            <div className="relative">
              <Mail className="auth-input-icon" size={22} />
              <input
                id="email"
                className="auth-input"
                type="email"
                required
                value={form.email}
                onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
                placeholder={institutional ? 'researcher@university.edu' : 'researcher@institution.edu'}
              />
            </div>
          </div>

          <div className={`auth-register-field ${mode === 'register' ? 'open' : ''}`} aria-hidden={mode !== 'register'}>
            <div className="ink-field">
              <label className="auth-label" htmlFor="display-name">
                Display Name
              </label>
              <div className="relative">
                <GraduationCap className="auth-input-icon" size={22} />
                <input
                  id="display-name"
                  className="auth-input"
                  type="text"
                  required={mode === 'register'}
                  tabIndex={mode === 'register' ? 0 : -1}
                  value={form.displayName}
                  onChange={(event) => setForm((prev) => ({ ...prev, displayName: event.target.value }))}
                  placeholder="Canvas Captain"
                />
              </div>
            </div>
          </div>

          <div className="ink-field">
            <label className="auth-label" htmlFor="password">
              Password
            </label>
            <div className="relative">
              <Lock className="auth-input-icon" size={22} />
              <input
                id="password"
                className="auth-input pr-12"
                type={showPassword ? 'text' : 'password'}
                required
                value={form.password}
                onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder="••••••••"
              />
              <button
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-500 hover:text-indigo-700"
                onClick={() => setShowPassword((prev) => !prev)}
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {mode === 'login' && (
              <div className="pt-2 text-right">
                <button
                  type="button"
                  className="font-handwriting text-lg text-indigo-700 underline decoration-wavy decoration-indigo-400/50"
                  onClick={() => showComingSoon('Password recovery')}
                >
                  Forgot Password?
                </button>
              </div>
            )}
          </div>

          {error && <p key={error} className="auth-feedback-error rounded-lg bg-rose-50/80 px-4 py-2 text-sm font-semibold text-rose-700 backdrop-blur-sm">{error}</p>}
          {notice && <p className="rounded-lg bg-indigo-50/80 px-4 py-2 text-sm font-semibold text-indigo-700 backdrop-blur-sm">{notice}</p>}

          <button type="submit" disabled={isSubmitting} className="auth-submit">
            {isSubmitting ? 'Working...' : mode === 'login' ? 'Continue to Workspace' : 'Create Workspace'}
            {isSubmitting ? <LoaderCircle className="animate-spin" size={18} /> : <ArrowRight size={18} />}
          </button>
        </form>

        <div className="my-5 flex w-full items-center gap-4">
          <div className="h-px flex-1 bg-slate-300/60" />
          <span className="font-reading-serif text-sm italic text-slate-700">or</span>
          <div className="h-px flex-1 bg-slate-300/60" />
        </div>

        <div className="w-full space-y-3">
          {authConfig.google_enabled ? (
            <div ref={googleButtonRef} className="flex min-h-[44px] justify-center" />
          ) : (
            <button type="button" className="auth-secondary-action" onClick={() => showComingSoon('Google login')}>
              <span className="text-xl font-bold text-blue-600">G</span>
              Continue with Google
            </button>
          )}
          <button
            type="button"
            className="auth-secondary-action"
            onClick={() => {
              setInstitutional(true)
              setError('')
              setNotice('')
            }}
          >
            <GraduationCap size={18} />
            Institutional Login
          </button>
        </div>
      </main>
    </div>
  )
}

export default AuthPanel
