export type ScanReconciliationResult = {
  activeIds: string[];
  newIds: string[];
  stoppedIds: string[];
};

function uniqueIds(ids: Iterable<string>) {
  return Array.from(new Set(Array.from(ids).filter(Boolean)));
}

export function reconcileScanLibraryIds(
  previousLibraryIds: Iterable<string>,
  currentLibraryIds: Iterable<string>,
  hasPreviousCompleteScan: boolean
): ScanReconciliationResult {
  const previous = new Set(uniqueIds(previousLibraryIds));
  const current = new Set(uniqueIds(currentLibraryIds));

  if (!hasPreviousCompleteScan) {
    return {
      activeIds: Array.from(current).sort(),
      newIds: [],
      stoppedIds: []
    };
  }

  return {
    activeIds: Array.from(current).filter((id) => previous.has(id)).sort(),
    newIds: Array.from(current).filter((id) => !previous.has(id)).sort(),
    stoppedIds: Array.from(previous).filter((id) => !current.has(id)).sort()
  };
}
