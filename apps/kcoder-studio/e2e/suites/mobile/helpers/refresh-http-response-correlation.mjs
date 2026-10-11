export function findHttpResponseForRouteRequest(responses, request) {
  if (!Array.isArray(responses) || !Number.isSafeInteger(request?.routeRequestOrdinal)) return undefined;
  return responses.find(response => response?.routeRequestOrdinal === request.routeRequestOrdinal);
}
