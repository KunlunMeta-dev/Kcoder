// Track disconnects while authentication or backend shutdown is awaited.
export function watchWebSocketUpgrade(socket) {
  let ended = false;
  const markEnded = () => { ended = true; };
  socket.once('end', markEnded);
  socket.once('close', markEnded);
  socket.once('error', markEnded);
  return {
    isAlive: () => !ended && !socket.destroyed && !socket.readableEnded && !socket.writableEnded && socket.writable,
    release() {
      socket.off('end', markEnded);
      socket.off('close', markEnded);
      socket.off('error', markEnded);
    },
  };
}
