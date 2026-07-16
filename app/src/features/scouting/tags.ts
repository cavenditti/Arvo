// OWNER: fe-scouting — canonical scouting tag ids (labels come from i18n `tags.<id>`).
export const OBSERVATION_TAGS = [
  'malattia',
  'parassiti',
  'stress_idrico',
  'grandine',
  'allagamento',
  'altro',
] as const;

export type ObservationTag = (typeof OBSERVATION_TAGS)[number];
