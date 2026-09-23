import { SettingsSelect } from './SettingsSelect'
import { Eye, EyeOff } from 'lucide-react'
import { clsx } from 'clsx'
import { useState } from 'react'
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from 'react'

type SettingsPageWidth = 'standard' | 'narrow'

const PAGE_WIDTH_CLASS: Record<SettingsPageWidth, string> = {
  standard: 'max-w-3xl',
  narrow: 'max-w-[560px]',
}

interface SettingsPageProps extends HTMLAttributes<HTMLDivElement> {
  width?: SettingsPageWidth
}

export function SettingsPage({ width = 'standard', className = '', ...props }: SettingsPageProps) {
  return (
    <div
      className={`mx-auto w-full ${PAGE_WIDTH_CLASS[width]} pb-10 ${className}`.trim()}
      {...props}
    />
  )
}

interface SettingsPageHeaderProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}

export function SettingsPageHeader({
  title,
  description,
  actions,
  className = '',
}: SettingsPageHeaderProps) {
  return (
    <div
      className={`mb-8 flex items-start justify-between gap-4 border-b border-border/60 pb-5 max-sm:flex-col ${className}`.trim()}
    >
      <div className="min-w-0">
        <h1 className="heading-base tracking-normal text-text-primary">{title}</h1>
        {description && (
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-text-secondary">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function SettingsGroup({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface/30 [&>*:not(:last-child)]:relative [&>*:not(:last-child)]:after:pointer-events-none [&>*:not(:last-child)]:after:absolute [&>*:not(:last-child)]:after:inset-x-4 [&>*:not(:last-child)]:after:bottom-0 [&>*:not(:last-child)]:after:h-px [&>*:not(:last-child)]:after:bg-border [&>*:not(:last-child)]:after:content-[''] ${className}`.trim()}
      {...props}
    />
  )
}

interface SettingsRowProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode
  description?: ReactNode
  control?: ReactNode
  labelClassName?: string
}

export function SettingsRow({
  label,
  description,
  control,
  labelClassName = '',
  className = '',
  ...props
}: SettingsRowProps) {
  return (
    <div
      className={`flex items-center justify-between gap-6 px-4 py-4 transition-colors focus-within:bg-background/60 hover:bg-background/40 max-sm:flex-col max-sm:items-stretch max-sm:gap-3 ${className}`.trim()}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className={`min-w-0 text-sm font-medium text-text-primary ${labelClassName}`.trim()}>
          {label}
        </div>
        {description && (
          <div className="min-w-0 text-sm leading-relaxed text-text-secondary">{description}</div>
        )}
      </div>
      {control && (
        <div className="flex max-w-full shrink-0 items-center gap-2 max-sm:justify-end">
          {control}
        </div>
      )}
    </div>
  )
}

interface SettingsSwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-checked' | 'onChange' | 'onClick' | 'role'
> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function SettingsSwitch({
  checked,
  onCheckedChange,
  className = '',
  disabled,
  ...props
}: SettingsSwitchProps) {
  const state = checked ? 'checked' : 'unchecked'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={state}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`inline-flex min-h-6 min-w-8 items-center justify-center rounded-full max-md:min-h-11 max-md:min-w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 ${className}`.trim()}
      {...props}
    >
      <span
        data-state={state}
        className={`relative inline-flex h-5 w-8 shrink-0 items-center overflow-hidden rounded-full transition-colors ${
          checked ? 'bg-blue-500' : 'bg-text-muted/30'
        }`}
      >
        <span
          data-state={state}
          className={`block h-4 w-4 rounded-full border border-white bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-[14px]' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  )
}

// ---------- Shared form/status primitives (settings redesign Phase 0) ----------
// Recipes follow renderer/DESIGN.md: 4px base unit, 16px decoration icons,
// semantic tokens, and non-color status cues. Decoration icons are always
// aria-hidden because the visible field label carries the accessible name.

export type FieldTextSize = 'sm' | 'base'

const FIELD_TEXT_CLASS: Record<FieldTextSize, string> = {
  sm: 'text-sm',
  base: 'text-base',
}

const FIELD_ICON_CLASS =
  'pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted'

const FIELD_CONTROL_CLASS =
  'mt-1 h-10 w-full rounded-xl border border-border bg-background text-text-primary shadow-sm outline-none transition-all duration-150 hover:border-text-muted/30 focus:border-focus/60 focus:ring-2 focus:ring-focus/15 disabled:cursor-not-allowed disabled:opacity-40 max-md:h-11'

interface InputWithIconProps extends InputHTMLAttributes<HTMLInputElement> {
  icon: ReactNode
  textSize?: FieldTextSize
  /** React 19 ref-as-prop; callers use it to auto-focus the first field. */
  ref?: Ref<HTMLInputElement>
}

export function InputWithIcon({
  icon,
  textSize = 'base',
  className = '',
  ref,
  ...props
}: InputWithIconProps) {
  return (
    <span className="relative block">
      <span aria-hidden="true" className={FIELD_ICON_CLASS}>
        {icon}
      </span>
      <input
        ref={ref}
        {...props}
        className={clsx(
          FIELD_CONTROL_CLASS,
          'pl-10 pr-3 focus-visible:outline-none aria-[invalid=true]:border-red-500',
          FIELD_TEXT_CLASS[textSize],
          className
        )}
      />
    </span>
  )
}

interface IconSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  icon: ReactNode
  textSize?: FieldTextSize
}

export function IconSelect({
  icon,
  textSize = 'base',
  className = '',
  children,
  ...props
}: IconSelectProps) {
  return (
    <SettingsSelect icon={icon} className={clsx(FIELD_TEXT_CLASS[textSize], className)} {...props}>
      {children}
    </SettingsSelect>
  )
}

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  icon: ReactNode
  toggleLabel: string
  hideLabel?: string
  toggleTestId?: string
  textSize?: FieldTextSize
}

export function PasswordInput({
  icon,
  toggleLabel,
  hideLabel,
  toggleTestId = 'password-input-toggle',
  textSize = 'base',
  className = '',
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  return (
    <span className="relative block">
      <span aria-hidden="true" className={FIELD_ICON_CLASS}>
        {icon}
      </span>
      <input
        type={visible ? 'text' : 'password'}
        {...props}
        className={clsx(
          FIELD_CONTROL_CLASS,
          'pl-10 pr-10 focus-visible:outline-none aria-[invalid=true]:border-red-500',
          FIELD_TEXT_CLASS[textSize],
          className
        )}
      />
      <button
        type="button"
        data-testid={toggleTestId}
        aria-label={visible ? (hideLabel ?? toggleLabel) : toggleLabel}
        aria-pressed={visible}
        disabled={props.disabled}
        onClick={() => setVisible(value => !value)}
        className="absolute inset-y-0 right-1 my-auto flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary max-md:h-11 max-md:w-11"
      >
        {visible ? (
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Eye className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </span>
  )
}

interface InfoBoxProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: 'info' | 'hint'
  icon?: ReactNode
  title?: ReactNode
}

export function InfoBox({
  variant = 'info',
  icon,
  title,
  className = '',
  children,
  ...props
}: InfoBoxProps) {
  if (variant === 'hint') {
    return (
      <p className={clsx('text-sm text-text-secondary', className)} {...props}>
        {children}
      </p>
    )
  }
  return (
    <div
      className={clsx(
        'flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-sm text-text-secondary',
        className
      )}
      {...props}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="mt-0.5 flex shrink-0 text-text-secondary [&>svg]:h-4 [&>svg]:w-4"
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        {title && <p className="font-medium text-text-primary">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  )
}

interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'neutral' | 'success' | 'destructive'
}

const STATUS_CHIP_CLASS: Record<NonNullable<StatusChipProps['variant']>, string> = {
  neutral: 'bg-text-muted/10 text-text-secondary',
  success: 'bg-green-500/10 text-green-600 dark:text-green-400',
  destructive: 'bg-red-500/10 text-red-500',
}

export function StatusChip({
  variant = 'neutral',
  className = '',
  children,
  ...props
}: StatusChipProps) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-4',
        STATUS_CHIP_CLASS[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}

interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
}

export function SectionHeader({
  icon,
  title,
  description,
  className = '',
  ...props
}: SectionHeaderProps) {
  return (
    <div className={clsx('flex items-start gap-3', className)} {...props}>
      {icon && (
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background text-text-secondary shadow-sm [&>svg]:h-4 [&>svg]:w-4"
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h2 className="heading-sm tracking-normal text-text-primary">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-text-secondary">{description}</p>}
      </div>
    </div>
  )
}

interface ModelMarkProps extends HTMLAttributes<HTMLSpanElement> {
  label: string
}

export function ModelMark({ label, className = '', ...props }: ModelMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-background text-code-sm font-medium text-text-secondary ring-1 ring-border',
        className
      )}
      {...props}
    >
      {Array.from(label.trim())[0]?.toUpperCase() ?? '?'}
    </span>
  )
}
