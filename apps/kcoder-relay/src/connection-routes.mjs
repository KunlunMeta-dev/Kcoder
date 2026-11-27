const canonicalUrl = new URL('../../kcoder-studio/shared/gatewayConnectionRoutes.js', import.meta.url);
let contract;
try {
  contract = await import(canonicalUrl.href);
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== canonicalUrl.href) throw error;
  contract = await import(new URL('./gatewayConnectionRoutes.runtime.mjs', import.meta.url).href);
}

export const canonicalGatewayConnectionUrl = contract.canonicalGatewayConnectionUrl;
export const isLoopbackGatewayConnectionUrl = contract.isLoopbackGatewayConnectionUrl;
export const parseGatewayConnectionRoutes = contract.parseGatewayConnectionRoutes;
export const parseGatewayConnectionProofQuery = contract.parseGatewayConnectionProofQuery;
