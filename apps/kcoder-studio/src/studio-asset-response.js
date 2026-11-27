import compression from 'compression';

// Filename eligibility alone never grants public access or an integrity verdict.
export const studioCompiledAssetPath = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

/** Both asset routes emit comma-free tags; GET/HEAD use weak comparison. */
export function matchesAssetEtag(header, etag) {
  if (typeof header !== 'string' || typeof etag !== 'string') return false;
  const opaque = etag.replace(/^W\//, '');
  return header.split(',').some(value => {
    const candidate = value.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === opaque;
  });
}

/** Compress asset bytes before transport; personalized HTML never enters the codec. */
export function createStudioAssetSender() {
  const compressAssets = compression();
  return (request, response, status, headers, body) => {
    const html = headers['content-type']?.startsWith('text/html');
    const hasBody = status !== 304 && request.method !== 'HEAD';
    const send = () => {
      response.writeHead(status, { ...(!html ? { vary: 'Accept-Encoding' } : {}), ...headers });
      response.end(hasBody ? body : undefined);
    };
    if (html || !hasBody || !request.headers?.['accept-encoding']) send();
    else compressAssets(request, response, send);
  };
}
