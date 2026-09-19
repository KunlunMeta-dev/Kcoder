export class TranscriptPageGate {
  private epoch = 0
  begin(identity: string) {
    return { identity, epoch: this.epoch }
  }
  invalidate() {
    this.epoch += 1
  }
  current(ticket: { identity: string; epoch: number }, identity: string | undefined) {
    return ticket.identity === identity && ticket.epoch === this.epoch
  }
  accept(
    ticket: { identity: string; epoch: number },
    identity: string | undefined,
    reset: boolean
  ) {
    if (!this.current(ticket, identity)) return false
    if (reset) this.invalidate()
    return true
  }
}
