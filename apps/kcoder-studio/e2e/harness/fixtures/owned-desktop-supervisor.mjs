// Model-independent lifecycle fixture. EOF deliberately does not stop this owner.
process.stdin.resume();
const keepAlive = setInterval(() => {}, 1000);
process.once('SIGTERM', () => {
  clearInterval(keepAlive);
  process.exit(0);
});
process.stdout.write('OWNED_DESKTOP_SUPERVISOR_READY\n');
