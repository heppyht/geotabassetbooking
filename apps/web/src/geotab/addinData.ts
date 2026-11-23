/*───────────────────── Geotab: AddInData API Wrapper ─────────────────────*/
/* Thin wrapper over the MyGeotab Add-In `geotab.addin.call()` JSON-RPC API.
   Used by the AddInData repository. No business logic here. */

export type GeotabApiCall = {
  call?: (method: string, params: Record<string, unknown>, success: (result: unknown) => void, error?: (error: unknown) => void) => void;
  getSession?: (callback: (session: { userName?: string; database?: string; server?: string } | null) => void) => void;
};

export type AddInDataRecordRaw = {
  id: string;
  addInId: string;
  details: string | Record<string, unknown>;
  groups?: Array<{ id: string }>;
  dateTime?: string;
};

export class GeotabAddInDataClient {
  private readonly api: GeotabApiCall | null;
  private readonly addInId: string | null;

  constructor(api: GeotabApiCall | null, addInId: string | null) {
    this.api = api;
    this.addInId = addInId;
  }

  isConfigured(): boolean {
    return !!this.api?.call && !!this.addInId;
  }

  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.api?.call) {
        reject(new Error("GEOTAB_API_NOT_AVAILABLE: running outside MyGeotab Add-In context"));
        return;
      }
      if ((method === "Add" || method === "Set" || method === "Remove") && !this.addInId) {
        reject(new Error("ADDIN_ID_NOT_CONFIGURED"));
        return;
      }
      this.api.call(method, params, (result: unknown) => resolve(result as T), (error: unknown) => reject(error ?? new Error("GEOTAB_API_ERROR")));
    });
  }

  async searchAddInData(search?: Record<string, unknown>): Promise<AddInDataRecordRaw[]> {
    if (!this.addInId) return [];
    const result = await this.call<AddInDataRecordRaw[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId, ...(search ?? {}) },
    });
    return result ?? [];
  }

  async addAddInData(details: unknown, groupId: string): Promise<{ id?: string } | null> {
    if (!this.addInId) throw new Error("ADDIN_ID_NOT_CONFIGURED");
    return this.call<{ id?: string } | null>("Add", {
      typeName: "AddInData",
      entity: { addInId: this.addInId, details, groups: [{ id: groupId }] },
    });
  }

  async setAddInData(recordId: string, details: unknown, groupId: string): Promise<unknown> {
    if (!this.addInId) throw new Error("ADDIN_ID_NOT_CONFIGURED");
    return this.call("Set", {
      typeName: "AddInData",
      entity: { addInId: this.addInId, id: recordId, details, groups: [{ id: groupId }] },
    });
  }

  async removeAddInData(recordId: string): Promise<unknown> {
    return this.call("Remove", { typeName: "AddInData", entity: { id: recordId } });
  }

  async getDevices(): Promise<Array<{ id: string; name?: string; serialNumber?: string }>> {
    return this.call<{ id: string; name?: string; serialNumber?: string }[]>("Get", { typeName: "Device", resultsLimit: 1000 });
  }

  async getUsers(): Promise<Array<{ id: string; name?: string; role?: string }>> {
    return this.call<{ id: string; name?: string; role?: string }[]>("Get", { typeName: "User", resultsLimit: 1000 });
  }

  async getSession(): Promise<{ userName?: string; database?: string; server?: string } | null> {
    if (!this.api?.getSession) return null;
    return new Promise(resolve => {
      this.api!.getSession!((session: { userName?: string; database?: string; server?: string } | null) => {
        resolve(session);
      });
    });
  }
}
