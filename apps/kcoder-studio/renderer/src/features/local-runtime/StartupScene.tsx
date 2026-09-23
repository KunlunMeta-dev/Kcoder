import { useId } from 'react'
import { FileText, FolderOpen, MessageSquareText, Send, Sparkles } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import './startup-scene.css'

export function StartupBrand() {
  const gradient = useId()
  return (
    <div className="kcoder-startup-brand">
      <svg aria-hidden="true" viewBox="0 0 76 44" fill="none">
        <defs>
          <linearGradient
            id={gradient}
            x1="8"
            y1="8"
            x2="64"
            y2="40"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#2358ff" />
            <stop offset="1" stopColor="#38c8f9" />
          </linearGradient>
        </defs>
        <path
          d="M8 33 25 16 39 30M31 22 46 7 68 33"
          stroke={`url(#${gradient})`}
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>KunlunMeta</span>
      <small className="kcoder-startup-motto">BUILD MORE WITH AI</small>
    </div>
  )
}

export function StartupIllustration() {
  const { t } = useTranslation('localRuntime')
  const orbit = useId()
  const cards = [
    { id: 'project', label: t('animation_project'), Icon: FolderOpen },
    { id: 'files', label: t('animation_files'), Icon: FileText },
    { id: 'chat', label: t('animation_chat'), Icon: MessageSquareText },
  ]
  return (
    <div className="kcoder-startup-scene" data-testid="kcoder-startup-scene">
      <div className="kcoder-startup-halo" aria-hidden="true" />
      <div className="kcoder-startup-glass-plane" aria-hidden="true" />
      <div className="kcoder-startup-platform" aria-hidden="true" />
      <i className="kcoder-startup-pearl kcoder-startup-pearl-left" aria-hidden="true" />
      <i className="kcoder-startup-pearl kcoder-startup-pearl-right" aria-hidden="true" />
      <svg className="kcoder-startup-orbit" viewBox="0 0 960 360" aria-hidden="true">
        <defs>
          <linearGradient
            id={orbit}
            x1="100"
            y1="100"
            x2="870"
            y2="280"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#51a2ff" stopOpacity=".85" />
            <stop offset=".35" stopColor="#d5eaff" stopOpacity=".15" />
            <stop offset="1" stopColor="#468aff" stopOpacity=".65" />
          </linearGradient>
        </defs>
        <ellipse
          cx="500"
          cy="193"
          rx="394"
          ry="76"
          transform="rotate(-5 500 193)"
          fill="none"
          stroke={`url(#${orbit})`}
          strokeWidth="5"
        />
        <ellipse
          className="kcoder-startup-orbit-light"
          cx="500"
          cy="193"
          rx="394"
          ry="76"
          transform="rotate(-5 500 193)"
          fill="none"
          stroke="#8bbcff"
          strokeWidth="5"
          pathLength="100"
          strokeDasharray="8 92"
        />
      </svg>
      {cards.map(({ id, label, Icon }) => (
        <div
          key={id}
          className={`kcoder-startup-card-slot kcoder-startup-card-${id}`}
          aria-hidden="true"
        >
          <div className="kcoder-startup-card">
            <span className="kcoder-startup-card-icon">
              <Icon strokeWidth={1.8} />
            </span>
            <span>{label}</span>
            {id === 'files' && <Sparkles className="kcoder-startup-stars" strokeWidth={1.4} />}
          </div>
        </div>
      ))}
      <div className="kcoder-startup-dock" role="progressbar" aria-label={t('starting_title')}>
        <Send aria-hidden="true" strokeWidth={1.7} />
        <div className="kcoder-startup-track">
          <span />
        </div>
      </div>
    </div>
  )
}

export function StartupWordmark() {
  const gradient = useId()
  return (
    <div className="kcoder-startup-wordmark" aria-label="KCoder Studio">
      <strong>
        <svg viewBox="0 0 76 80" aria-hidden="true" fill="none">
          <defs>
            <linearGradient
              id={gradient}
              x1="12"
              y1="68"
              x2="64"
              y2="12"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#5dd2f8" />
              <stop offset="1" stopColor="#2376ff" />
            </linearGradient>
          </defs>
          <path
            d="M13 14V65M61 14 14 48M36 34 63 65"
            stroke={`url(#${gradient})`}
            strokeWidth="15"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>coder</span>
      </strong>
      <span>studio</span>
    </div>
  )
}

export function StartupSteps() {
  const { t } = useTranslation('localRuntime')
  const steps = [
    { key: 'step_workspace', Icon: FolderOpen },
    { key: 'step_files', Icon: FileText },
    { key: 'step_assistant', Icon: MessageSquareText },
  ]
  return (
    <div className="kcoder-startup-steps" aria-hidden="true">
      {steps.map(({ key, Icon }) => (
        <div className="kcoder-startup-step" key={key}>
          <i />
          <Icon strokeWidth={1.8} />
          <span>{t(key)}</span>
        </div>
      ))}
    </div>
  )
}

export function StartupSignature() {
  return (
    <div className="kcoder-startup-signature" aria-hidden="true">
      <small>Kcoder studio</small>
      <div>
        <span />
        KUNLUNMETA
        <span />
      </div>
      <small>BUILD MORE WITH AI</small>
    </div>
  )
}
