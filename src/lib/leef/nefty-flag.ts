/**
 * Kill-switch for the Nefty venue. Lives outside venue-adapters so the bot
 * store can flip it without downloading the table-sweep code.
 */
let enabled = true;

export function setNeftyVenueEnabled(on: boolean): void {
  enabled = on === true;
}

export function neftyVenueEnabledNow(): boolean {
  return enabled;
}
