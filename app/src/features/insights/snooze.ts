// OWNER: fe-dashboard — snooze-duration side channel.
// The frozen AlertList contract is onAction(id, action) with no duration argument, so the
// inline 1g/3g/7g choice in AlertList records the chosen days here and the alerts screen reads
// it synchronously inside the same onAction dispatch to build the `until` timestamp.
let snoozeDays = 3;

export function setSnoozeDays(d: number) {
  snoozeDays = d;
}

export function readSnoozeDays() {
  return snoozeDays;
}
