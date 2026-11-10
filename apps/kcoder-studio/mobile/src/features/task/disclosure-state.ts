/** A null choice means the node still follows the device default preference. */
export type DisclosureUserChoice = boolean | null;

export function resolveDisclosureExpanded(
  userChoice: DisclosureUserChoice,
  defaultExpanded: boolean,
): boolean {
  return userChoice ?? defaultExpanded;
}

export function toggleDisclosureChoice(
  userChoice: DisclosureUserChoice,
  defaultExpanded: boolean,
): boolean {
  return !resolveDisclosureExpanded(userChoice, defaultExpanded);
}
