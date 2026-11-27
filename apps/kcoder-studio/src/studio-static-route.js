import { open, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { escapeHtml } from './gateway-login-presentation.js';
import { createStudioAssetSender, matchesAssetEtag, studioCompiledAssetPath } from './studio-asset-response.js';

/** Static application HTML is credential-bearing; widget documents use their own route. */
export function createStudioStaticRoute({ webRoot, gatewayToken, desktopHost, contentSecurityPolicy, requestPublicPrefix }) {
  const sendAsset = createStudioAssetSender();
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".pdf": "application/pdf",
  };

  async function collectStaticHtmlRoutes(directory = webRoot, prefix = "") {
    const routes = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (
          entry.name === "assets" ||
          entry.name === "_expo" ||
          entry.name === "widget-sandbox" ||
          entry.name.startsWith(".")
        )
          continue;
        routes.push(
          ...(await collectStaticHtmlRoutes(
            resolve(directory, entry.name),
            `${prefix}${entry.name}/`,
          )),
        );
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        routes.push(`${prefix}${entry.name}`);
      }
    }
    return routes;
  }

  function staticRouteExpression(relativeFile) {
    let route = relativeFile.replaceAll("\\", "/").replace(/\.html$/, "");
    route = route === "index" ? "" : route.replace(/\/index$/, "");
    const pattern = route
      .split("/")
      .filter(Boolean)
      .map((segment) =>
        /^\[[^/]+\]$/.test(segment)
          ? "[^/]+"
          : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/");
    return new RegExp(`^${pattern}$`);
  }

  let staticHtmlRoutesPromise;
  async function staticRouteFile(relative) {
    const directHtml = resolve(webRoot, `${relative}.html`);
    try {
      if ((await stat(directHtml)).isFile()) return directHtml;
    } catch {
      // Dynamic static routes are matched below using Expo Router [param] templates.
    }
    staticHtmlRoutesPromise ??= collectStaticHtmlRoutes().catch(() => []);
    const route = relative.replace(/^\/+|\/+$/g, "");
    const matched = (await staticHtmlRoutesPromise).find((file) =>
      staticRouteExpression(file).test(route),
    );
    return matched ? resolve(webRoot, matched) : null;
  }

  return async function serveStatic(request, response, pathname) {
    const relative =
      pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    // These assets must never acquire the credential-bearing application shell,
    // including encoded paths and extensionless static-route aliases.
    if (relative.replaceAll('\\', '/').split('/').includes('widget-sandbox') ||
        /^api\/widgets(?:\/|$)/.test(relative.replace(/^\/+/, ''))) {
      response.writeHead(404, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    let file = resolve(webRoot, relative);
    if (file !== webRoot && !file.startsWith(webRoot + sep))
      throw new Error("path outside root");
    const publicPrefix = requestPublicPrefix(request);
    const headers = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': contentSecurityPolicy,
    };
    let body;
    try {
      if (['GET', 'HEAD'].includes(request.method) && studioCompiledAssetPath.test(relative)) {
        // Reopen on every request: metadata is a freshness validator, not file access authority.
        const handle = await open(file, 'r');
        try {
          const info = await handle.stat({ bigint: true });
          if (info.isFile()) {
            headers.etag = `W/"source-${info.dev}-${info.ino}-${info.size}-${info.mtimeNs}-${info.ctimeNs}-${Buffer.from(publicPrefix).toString('base64url')}"`;
            headers['cache-control'] = 'private, no-cache';
            if (matchesAssetEtag(request.headers?.['if-none-match'], headers.etag)) {
              sendAsset(request, response, 304, { ...headers, 'content-type': mime[extname(file)] });
              return;
            }
          }
          body = await handle.readFile();
        } finally { await handle.close(); }
      } else body = await readFile(file);
    } catch (error) {
      const requestedExtension = extname(relative).toLowerCase();
      if (requestedExtension && mime[requestedExtension]) throw error;
      file =
        (await staticRouteFile(relative)) ?? resolve(webRoot, "index.html");
      body = await readFile(file);
    }
    if (extname(file) === ".html") {
      const desktopMeta = desktopHost
        ? '<meta name="kcoder-desktop-host" content="1">\n'
        : "";
      const basePathMeta = publicPrefix
        ? `<meta name="kcoder-app-base-path" content="${escapeHtml(publicPrefix)}">\n`
        : "";
      // Relative release assets resolve from the application root on nested routes.
      body = Buffer.from(body.toString("utf8").replace(
        /\b(src|href|action)=(["'])(?:\/(?!\/)|\.\/)(.*?)\2/g,
        (_match, attribute, quote, path) => `${attribute}=${quote}${mountedPath(`/${path}`, publicPrefix)}${quote}`,
      ));
      body = Buffer.from(
        body
          .toString("utf8")
          .replace(
            "</head>",
            `<meta name="kcoder-experience-api" content="v1">\n<meta name="kcoder-rpc-token" content="${gatewayToken}">\n${desktopMeta}${basePathMeta}</head>`,
          ),
      );
    } else if (extname(file) === ".css") {
      if (publicPrefix) {
        body = Buffer.from(body.toString("utf8").replace(
          /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^)'"\s\\])+))\s*\)/g,
          (match, doubleQuoted, singleQuoted, unquoted) => {
            const path = doubleQuoted ?? singleQuoted ?? unquoted;
            return path.startsWith('/') && !path.startsWith('//')
              ? match.replace(path, () => mountedPath(path, publicPrefix)) : match;
          },
        ));
      }
    }
    sendAsset(request, response, 200, {
      "content-type": mime[extname(file)] || "application/octet-stream",
      ...headers,
    }, body);
  };
}

function mountedPath(path, prefix) {
  // A build may already contain its configured mount; sibling prefixes are distinct.
  if (!prefix || (path.startsWith(prefix) && /^(?:[/?#]|$)/.test(path.slice(prefix.length)))) return path;
  return `${prefix}${path}`;
}
