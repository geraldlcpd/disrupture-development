/**
 * Map GeolocationPositionError codes to user-friendly copy.
 * @param {GeolocationPositionError | { code?: number; message?: string }} err
 */
export function getGeolocationErrorMessage(err) {
  const code = err?.code;
  switch (code) {
    case 1: // PERMISSION_DENIED
      return 'Location access was blocked. Search a monitored area instead.';
    case 2: // POSITION_UNAVAILABLE
      return 'Could not determine your location. Try again or search by area.';
    case 3: // TIMEOUT
      return 'Location request timed out. Try again or search by area.';
    default:
      if (err?.message?.includes('denied')) {
        return 'Location access was blocked. Search a monitored area instead.';
      }
      return 'Could not use your location. Search a monitored area instead.';
  }
}
