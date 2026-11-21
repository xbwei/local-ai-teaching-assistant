/** Finite observations for human review, never grading/model/History input. */
export type MongoStatus =
  | "PRESENT"
  | "EMPTY"
  | "MISSING"
  | "PARTIAL"
  | "DENIED"
  | "UNAVAILABLE"
  | "UNSUPPORTED"
  | "UNCHECKED";
export interface MongoObservation {
  status: MongoStatus;
  reason?:
    | "ACCESS"
    | "TIMEOUT"
    | "CANCELLED"
    | "LIMIT"
    | "INVALID"
    | "NETWORK"
    | "UNKNOWN"
    | "NOT_RUN"
    | "CLEANUP";
}
export interface MongoCollectionEvidence extends MongoObservation {
  collection: string;
  count?: number;
  countMode?: "EXACT" | "CAPPED";
  fields: ({
    field: string;
    expectedType: string;
    nonempty: boolean;
    mode: "EXACT" | "SAMPLED";
    inspected: number;
    present: number;
    matchingType: number;
    empty: number;
  } & MongoObservation)[];
}
export interface MongoEvidence {
  connection: MongoObservation;
  database: MongoObservation;
  collections: MongoCollectionEvidence[];
  cleanup: "COMPLETE" | "FAILED";
}
