// How Studio presents each built-in KCoder slash command. Every entry of
// `kcoderSlashCatalog.json` (generated from the REPL registry) must be listed;
// `studioSlashPolicy.test.ts` fails when the REPL adds a command without a decision.
//
// - studio:   handled by Studio desktop features only. The KCoder terminal is never
//             opened, so a missing Studio handler reports "unavailable" instead.
// - hybrid:   Studio handles the arguments that have a desktop equivalent; other
//             arguments open the KCoder terminal on the selected target.
// - terminal: no desktop equivalent; listed as opening the KCoder terminal.
// - hidden:   only meaningful inside a terminal REPL; not offered in Studio.
export type StudioSlashDisposition = 'studio' | 'hybrid' | 'terminal' | 'hidden'

export const studioSlashDisposition: Readonly<Record<string, StudioSlashDisposition>> = {
  '/help': 'studio',
  '/quit': 'hidden',
  '/outline': 'studio',
  '/jump': 'studio',
  '/agent': 'studio',
  '/new': 'studio',
  '/luna': 'terminal',
  '/init': 'studio',
  '/clear': 'studio',
  '/copy': 'studio',
  '/raw': 'hidden',
  '/model': 'studio',
  '/theme': 'hybrid',
  '/mention': 'studio',
  '/permission': 'studio',
  '/allow': 'terminal',
  '/deny': 'terminal',
  '/remember': 'studio',
  '/memories': 'hybrid',
  '/skill': 'studio',
  '/skills': 'studio',
  '/skill-usage': 'hybrid',
  '/curator': 'terminal',
  '/evolution': 'hybrid',
  '/rate': 'studio',
  '/skill-sync': 'terminal',
  '/skills-hub': 'hybrid',
  '/tools': 'studio',
  '/history': 'studio',
  '/btw': 'studio',
  '/undo': 'terminal',
  '/queue': 'studio',
  '/compact': 'studio',
  '/rewind': 'terminal',
  '/review': 'studio',
  '/ocr': 'studio',
  '/learn': 'studio',
  '/moa': 'studio',
  '/moa-plan': 'studio',
  '/rename': 'studio',
  '/diff': 'studio',
  '/context': 'studio',
  '/settings': 'studio',
  '/set': 'terminal',
  '/status': 'studio',
  '/hooks': 'studio',
  '/plugins': 'studio',
  '/apps': 'studio',
  '/rollout': 'terminal',
  '/ps': 'studio',
  '/stop': 'studio',
  '/workflow': 'hybrid',
  '/migration': 'hybrid',
  '/migrate': 'hybrid',
  '/wiki': 'hybrid',
  '/mcp': 'studio',
  '/plan': 'studio',
  '/unplan': 'studio',
  '/planstatus': 'studio',
  '/goal': 'studio',
  '/goal-pro': 'studio',
  '/orchestrate': 'studio',
  '/work': 'terminal',
  '/roster': 'terminal',
  '/ultgoal': 'studio',
  '/spec': 'terminal',
  '/export': 'terminal',
  '/import': 'terminal',
  '/debug': 'hybrid',
  '/todos': 'studio',
  '/tasks': 'studio',
  '/sessions': 'hybrid',
  '/resume': 'hybrid',
  '/keys': 'studio',
  '/usage': 'studio',
}

/** Whether the KCoder terminal may run this command for arguments Studio does not handle. */
export function opensKcoderTerminal(name: string) {
  const disposition = studioSlashDisposition[name]
  return disposition === 'terminal' || disposition === 'hybrid'
}
