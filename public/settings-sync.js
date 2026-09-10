(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FlyingMouseSettings = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  function mergeSettings(base, patch) {
    const merged = { ...base, ...patch };
    // An absent field is different from an explicit empty map: the main-process
    // store replaces targetBySource when it is present in a patch.
    if (Object.prototype.hasOwnProperty.call(base || {}, "targetBySource")
        || Object.prototype.hasOwnProperty.call(patch || {}, "targetBySource")) {
      merged.targetBySource = { ...base?.targetBySource, ...patch?.targetBySource };
    }
    return merged;
  }

  function createSynchronizer({ get, set, save }) {
    let edits = {};
    let pending = {};
    let sequence = 0;
    let tail = Promise.resolve();
    function restore(stored) {
      set(mergeSettings(stored || {}, edits));
    }
    function persist(patch) {
      edits = mergeSettings(edits, patch);
      pending = mergeSettings(pending, patch);
      sequence += 1;
      set(mergeSettings(get(), patch));
      const operation = tail.catch(() => {}).then(async () => {
        const sentSequence = sequence;
        const sent = Object.prototype.hasOwnProperty.call(pending, "targetBySource")
          ? { ...pending, targetBySource: { ...get()?.targetBySource, ...pending.targetBySource } }
          : { ...pending };
        const stored = await save(sent);
        // Only the matching acknowledgement can retire pending local edits.
        // Newer edits remain queued, including fields whose earlier save failed.
        if (sentSequence === sequence) pending = {};
        set(mergeSettings(stored || get(), edits));
      });
      tail = operation;
      return operation;
    }
    return { persist, restore };
  }
  return { createSynchronizer, mergeSettings };
});
