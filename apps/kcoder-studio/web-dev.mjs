// Source Web development uses the authenticated Gateway with Vite middleware.
process.env.KCODER_STUDIO_RENDERER_MODE ??= process.argv.includes('--static') ? 'static' : 'vite';
await import('./dev-server.mjs');
