/** Safe Native failure codes map to product recovery messages. */
export function nativeFailureMessageKey(code: string): string | undefined {
  switch (code) {
    case 'CHANNEL_HOST_NOT_RECOVERED': return 'nativeErrors.hostNotRecovered'
    case 'CHANNEL_HOST_CONFIGURATION_CHANGED': return 'nativeErrors.hostConfigurationChanged'
    case 'CHANNEL_CREDENTIAL_UNAVAILABLE': return 'nativeErrors.credentialUnavailable'
    case 'CHANNEL_AUTHORIZATION_REVOKED': return 'nativeErrors.authorizationRevoked'
    case 'CHANNEL_CONNECTION_STATE_CHANGED': return 'nativeErrors.connectionStateChanged'
    case 'CHANNEL_CONNECTION_STOP_REQUIRED': return 'nativeErrors.connectionStopRequired'
    case 'CHANNEL_CONNECTION_CREDENTIAL_PENDING': return 'nativeErrors.credentialPending'
    case 'CHANNEL_CONNECTION_CREDENTIAL_SHARED': return 'nativeErrors.credentialShared'
    case 'CHANNEL_CONNECTION_REMOVAL_UNCONFIRMED': return 'connections.removalUnconfirmed'
    default: return undefined
  }
}
