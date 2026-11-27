const LOCAL_NAME = 'kcoder_studio_session';
const HOST_NAME = '__Host-kcoder_studio_session';

/** HTTPS public hosts use a browser-enforced host cookie, immune to sibling-domain tossing. */
export function createBrowserSessionCookies({ publicOrigins, forceSecure = false }) {
  function policy(request, scope = '') {
    let hostScoped = false;
    try { hostScoped = publicOrigins.has(new URL(`https://${request.headers.host}`).origin); } catch {}
    return { name: (hostScoped ? HOST_NAME : LOCAL_NAME) + scope, secure: hostScoped || forceSecure, hostScoped };
  }
  return {
    read(request, scope) {
      const { name } = policy(request, scope);
      const matches = String(request.headers.cookie || '').split(';')
        .map(cookie => cookie.trim()).filter(cookie => cookie.startsWith(`${name}=`));
      if (matches.length !== 1) return null;
      try { return decodeURIComponent(matches[0].slice(name.length + 1)); } catch { return null; }
    },
    header(request, id, maxAgeSeconds, path = '/', scope) {
      const { name, secure, hostScoped } = policy(request, scope);
      return `${name}=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=${hostScoped ? '/' : path}; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
    },
  };
}
