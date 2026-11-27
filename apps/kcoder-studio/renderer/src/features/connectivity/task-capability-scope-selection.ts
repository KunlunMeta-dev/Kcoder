import type { IntegrationTaskCapabilitySourceChoice, IntegrationTaskCapabilitySourceDescriptor, IntegrationTaskCapabilityScopeSelection } from '../../../../shared/generated/contracts'
import { isIntegrationTaskCapabilityScopeSelection } from '../../../../shared/generated/contractGuards.mjs'
export function sourceChoiceKey(choice: IntegrationTaskCapabilitySourceChoice) { return JSON.stringify([choice.sourceRef.id, choice.sourceRef.revision, choice.accountRef?.id ?? null, choice.accountRef?.revision ?? null]) }
export function sourceAccountKey(choice: IntegrationTaskCapabilitySourceChoice) { return JSON.stringify([choice.sourceRef.id, choice.accountRef?.id ?? null]) }
export function sourceChoice(descriptor: IntegrationTaskCapabilitySourceDescriptor): IntegrationTaskCapabilitySourceChoice { return { sourceRef: { ...descriptor.sourceRef }, accountRef: descriptor.accountRef === null ? null : { ...descriptor.accountRef } } }
export function validTaskCapabilityScopeSelection(selection: IntegrationTaskCapabilityScopeSelection): boolean {
  if (!isIntegrationTaskCapabilityScopeSelection(selection) || selection.sources.length > 64 || selection.mode === 'selected' && !selection.sources.length || selection.mode !== 'selected' && selection.sources.length > 0) return false
  const identities = selection.sources.map(sourceAccountKey)
  return new Set(identities).size === identities.length
}
export function replaceSourceChoice(selection: IntegrationTaskCapabilityScopeSelection, descriptor: IntegrationTaskCapabilitySourceDescriptor, selected: boolean): IntegrationTaskCapabilityScopeSelection {
  const choice = sourceChoice(descriptor), identity = sourceAccountKey(choice)
  const sources = selection.mode === 'selected' ? selection.sources.filter(value => sourceAccountKey(value) !== identity) : []
  if (selected) sources.push(choice)
  return { mode: 'selected', sources }
}
