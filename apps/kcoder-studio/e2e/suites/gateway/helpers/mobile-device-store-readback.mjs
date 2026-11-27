export function findPersistedMobileDeviceById(devices, targetDeviceId) {
  if (!Array.isArray(devices) || typeof targetDeviceId !== "string") return null;
  return devices.find(device => device?.id === targetDeviceId) ?? null;
}
