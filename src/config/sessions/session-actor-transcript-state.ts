import type { DatabaseSync } from "node:sqlite";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";

type TranscriptState = SessionActorStoredState["transcript"];

/** Read-only facts borrowed from the serialized writer, never a mutable working copy. */
export type SessionActorTranscriptState = {
  readonly hot: {
    readonly transcript: {
      readonly version: Readonly<SessionActorStoredState["hot"]["transcript"]["version"]>;
      readonly watermark: Readonly<SessionActorStoredState["hot"]["transcript"]["watermark"]>;
    };
  };
  readonly transcript: {
    readonly coldArchive: Readonly<TranscriptState["coldArchive"]>;
    readonly projection: Readonly<TranscriptState["projection"]>;
    readonly identities: ReadonlyMap<
      string,
      TranscriptState["identities"] extends Map<string, infer Row> ? Readonly<Row> : never
    >;
    readonly active: ReadonlyMap<
      number,
      TranscriptState["active"] extends Map<number, infer Row> ? Readonly<Row> : never
    >;
    readonly navigation: ReadonlyArray<Readonly<TranscriptState["navigation"][number]>>;
  };
};

type TranscriptReader = (sessionId: string) => SessionActorTranscriptState | undefined;
const readers = new WeakMap<DatabaseSync, TranscriptReader>();
let current:
  | { database: DatabaseSync; sessionId: string; state: SessionActorTranscriptState }
  | undefined;

export function registerSessionActorTranscriptReader(
  database: { db: DatabaseSync },
  read: TranscriptReader,
): void {
  readers.set(database.db, read);
}

/** Only the execution owner's synchronous read operation may borrow committed residency. */
export function withSessionActorTranscriptRead<T>(
  database: { db: DatabaseSync },
  sessionId: string,
  read: () => T,
): T {
  const state = readers.get(database.db)?.(sessionId);
  const previous = current;
  current = state ? { database: database.db, sessionId, state } : undefined;
  try {
    return read();
  } finally {
    current = previous;
  }
}

export function readSessionActorTranscriptState(
  database: { db: DatabaseSync },
  target: { sessionId: string },
): SessionActorTranscriptState | undefined {
  const working = readSessionActorTransactionState(database, target);
  if (working) {
    return working;
  }
  return current?.database === database.db && current.sessionId === target.sessionId
    ? current.state
    : undefined;
}
