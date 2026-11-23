/*───────────────────── MyGeotab REST AddInData Gateway ─────────────────────*/
/* Replaces the PostgreSQL connection layer. All persistent data now flows
   through MyGeotab AddInData via the MyGeotab REST JSON-RPC API (Storage API).
   The Worker authenticates using the caller's session credentials (userName,
   sessionId, database) forwarded in request headers.
   No postgres, no Neon, no Hyperdrive, no external database. */

import type { Env } from "./env.ts";
import { withRetry, classifyError, DEFAULT_RETRY_CONFIG, type RetryConfig } from "./retry.ts";

type GeotabCredentials = {
  userName: string;
  database: string;
  sessionId: string;
};

type AddInDataRecordRaw = {
  id: string;
  addInId: string;
  details: string | Record<string, unknown>;
  groups?: Array<{ id: string }>;
  dateTime?: string;
};

const JSONRPC_ID = 1;

export class AddInDataRestGateway {
  public readonly server: string;
  public readonly database: string;
  public addInId: string = "";

  constructor(credentials: GeotabCredentials) {
    this.server = "my.geotab.com";
    this.database = credentials.database;
  }

  public async jsonRpc<T>(method: string, params: Record<string, unknown>, credentials: GeotabCredentials): Promise<T> {
    const body = {
      jsonrpc: "2.0",
      method,
      params: {
        credentials: {
          userName: credentials.userName,
          database: credentials.database,
          sessionId: credentials.sessionId,
        },
        ...params,
      },
      id: JSONRPC_ID,
    };

    const response = await fetch(`https://${this.server}/apiv1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`MYGEOTAB_HTTP_ERROR: ${response.status}`);
    }

    const result = (await response.json()) as {
      error?: { code?: number; message?: string; data?: unknown };
      result?: unknown;
    };
    if (result.error) {
      throw new Error(`MYGEOTAB_API_ERROR: ${result.error.message ?? String(result.error)}`);
    }
    return result.result as T;
  }

  async searchAddInData(addInId: string, search?: Record<string, unknown>): Promise<AddInDataRecordRaw[]> {
    const result = await this.jsonRpc<AddInDataRecordRaw[]>("Get", {
      typeName: "AddInData",
      search: { addInId, ...(search ?? {}) },
      resultsLimit: 1000,
    }, { userName: "", database: this.database, sessionId: "" });
    return result ?? [];
  }

  async addAddInData(addInId: string, details: unknown, groupId: string): Promise<{ id?: string } | null> {
    const result = await this.jsonRpc<{ id?: string } | null>("Add", {
      typeName: "AddInData",
      entity: {
        addInId,
        details,
        groups: [{ id: groupId }],
      },
    }, { userName: "", database: this.database, sessionId: "" });
    return result ?? null;
  }

  async setAddInData(addInId: string, recordId: string, details: unknown, groupId: string): Promise<unknown> {
    return this.jsonRpc("Set", {
      typeName: "AddInData",
      entity: {
        addInId,
        id: recordId,
        details,
        groups: [{ id: groupId }],
      },
    }, { userName: "", database: this.database, sessionId: "" });
  }

  async removeAddInData(recordId: string): Promise<unknown> {
    return this.jsonRpc("Remove", {
      typeName: "AddInData",
      entity: { id: recordId },
    }, { userName: "", database: this.database, sessionId: "" });
  }

  async getDevices(): Promise<Array<{ id: string; name?: string; serialNumber?: string }>> {
    return this.jsonRpc("Get", {
      typeName: "Device",
      resultsLimit: 1000,
    }, { userName: "", database: this.database, sessionId: "" });
  }

  async getUsers(): Promise<Array<{ id: string; name?: string }>> {
    return this.jsonRpc("Get", {
      typeName: "User",
      resultsLimit: 1000,
    }, { userName: "", database: this.database, sessionId: "" });
  }

  async verifySession(credentials: GeotabCredentials): Promise<{ valid: boolean; database: string; userName: string; role?: string }> {
    const result = await this.jsonRpc<unknown>("Get", {
      typeName: "User",
      search: { userName: credentials.userName },
      resultsLimit: 1,
    }, credentials);

    let role: string | undefined;
    if (Array.isArray(result) && result.length > 0) {
      const userRecord = result[0] as Record<string, unknown>;
      if (typeof userRecord.role === "string") {
        role = userRecord.role;
      }
    }

    return { valid: true, database: this.database, userName: credentials.userName, role };
  }
}

export function createGateway(credentials: GeotabCredentials): AddInDataRestGateway {
  return new AddInDataRestGateway(credentials);
}

/*───────────────────── Resilient Gateway (retry for read operations) ─────────────────────*/

/* Wraps an AddInDataRestGateway so that read-only methods (search, getDevices,
   getUsers, verifySession) are automatically retried on transient failures
   (rate limit, temporary network failure). Write methods (add, set, remove)
   are NOT retried by default — write safety depends on idempotency keys and
   version checks at the service layer.

   Read operations are safe to retry because they are idempotent and do not
   modify AddInData state.
   */
export function createResilientGateway(
  credentials: GeotabCredentials,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
) {
  const base = new AddInDataRestGateway(credentials);

  const retrySearch = async (
    addInId: string,
    search?: Record<string, unknown>,
  ): Promise<AddInDataRecordRaw[]> => {
    const result = await withRetry(
      () => base.searchAddInData(addInId, search),
      config,
    );
    return result.value;
  };

  const retryGetDevices = async (): Promise<Array<{ id: string; name?: string; serialNumber?: string }>> => {
    const result = await withRetry(() => base.getDevices(), config);
    return result.value;
  };

  const retryGetUsers = async (): Promise<Array<{ id: string; name?: string }>> => {
    const result = await withRetry(() => base.getUsers(), config);
    return result.value;
  };

  const retryVerifySession = async (
    creds: GeotabCredentials,
  ): Promise<{ valid: boolean; database: string; userName: string; role?: string }> => {
    const result = await withRetry(() => base.verifySession(creds), config);
    return result.value;
  };

  return {
    server: base.server,
    addInId: base.addInId,
    database: base.database,
    jsonRpc: base.jsonRpc.bind(base),
    searchAddInData: retrySearch,
    addAddInData: base.addAddInData.bind(base),
    setAddInData: base.setAddInData.bind(base),
    removeAddInData: base.removeAddInData.bind(base),
    getDevices: retryGetDevices,
    getUsers: retryGetUsers,
    verifySession: retryVerifySession,
  };
}

export type { GeotabCredentials, AddInDataRecordRaw };
