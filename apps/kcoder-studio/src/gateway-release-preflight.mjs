import { join } from 'node:path';
import { readResource } from './integrations/office/resource-verifier.mjs';

/** Explicit startup boundary only; ordinary HTTP requests never rebuild or scan the resource tree. */
export async function assertGatewayReleaseResources({ env = process.env, webRoot, mobileRoot, prepareMobile }) {
  if (env.NODE_ENV !== 'production' && env.KCODER_STUDIO_DEPLOYMENT_MODE !== 'release') return;
  for (const root of [webRoot, mobileRoot]) {
    let html;
    try { html = (await readResource(join(root, 'index.html'), 2 * 1024 * 1024)).toString('utf8'); }
    catch { throw new Error('Release web resources are missing or unreadable; build Studio and Mobile before starting the Gateway'); }
    if (/__vite_hmr|\/@vite\/client|Bundling in progress|\bdev=true|<script\b[^>]*\bsrc=["'][^"']*\/src\/[^"']*\.[tj]sx?(?:[?"'])/i.test(html))
      throw new Error('Development web resources cannot be served by a release Gateway');
  }
  try {
    if (typeof prepareMobile !== 'function') throw new Error('Mobile verifier is required');
    await prepareMobile();
  }
  catch { throw new Error('Release Mobile inventory is unavailable; build the verified static Mobile package before startup'); }
}
