export async function requestBody(request, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  // Keep the socket available for the caller's bounded error response.
  const body = typeof request.iterator === 'function' ? request.iterator({ destroyOnReturn: false }) : request;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) {
      request.resume?.();
      throw Object.assign(new Error("Request body is too large"), { code: 'REQUEST_BODY_TOO_LARGE', statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
