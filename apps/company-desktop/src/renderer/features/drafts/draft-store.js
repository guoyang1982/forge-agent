(function (root) {
  function createDraftStore(storage, namespace) {
    const fallback = new Map();
    const storageKey = (id) => `forgeCompany.draft.v1:${namespace}:${id}`;
    const valid = (value) => value && typeof value === "object" && !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === "string");
    return {
      get(id) {
        if (fallback.has(id)) return fallback.get(id) || undefined;
        try {
          const record = JSON.parse(storage().getItem(storageKey(id)) || "null");
          return record?.version === 1 && valid(record.value) ? record.value : undefined;
        } catch { return undefined; }
      },
      set(id, value) {
        if (!valid(value)) return false;
        const copy = { ...value };
        try {
          storage().setItem(storageKey(id), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), value: copy }));
          fallback.delete(id);
          return true;
        } catch { fallback.set(id, copy); return false; }
      },
      delete(id) {
        try { storage().removeItem(storageKey(id)); fallback.delete(id); return true; }
        catch { fallback.set(id, null); return false; }
      },
    };
  }
  root.ForgeDraftStore = { createDraftStore };
})(globalThis);
