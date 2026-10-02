/**
 * Input limits shared by client-side form validation and server-side request
 * validation. The server is authoritative; the client mirrors these so users
 * get immediate feedback.
 */
export const LIMITS = {
  titleMin: 4,
  titleMax: 120,
  descriptionMax: 1000,
  locationLabelMax: 120,
  sourceUrlMax: 2048,
  searchQueryMax: 100,
  disputeReasonMax: 300,
  updateTextMax: 500,
  /** Largest viewport (degrees, each axis) the list endpoint will serve. */
  maxBboxSpanDegrees: 8,
  /** Upper bound on events returned for one viewport. */
  maxEventsPerQuery: 500,
} as const;
