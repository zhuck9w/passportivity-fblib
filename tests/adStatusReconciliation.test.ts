import { describe, expect, it } from 'vitest';
import { reconcileScanLibraryIds } from '../src/server/adStatusReconciliation';

describe('reconcileScanLibraryIds', () => {
  it('uses the first complete scan as a baseline instead of marking every ad new', () => {
    expect(reconcileScanLibraryIds([], ['300', '100', '300'], false)).toEqual({
      activeIds: ['100', '300'],
      newIds: [],
      stoppedIds: []
    });
  });

  it('marks repeated, new, and missing library ids against the previous complete scan', () => {
    expect(reconcileScanLibraryIds(['100', '200', '300'], ['200', '400'], true)).toEqual({
      activeIds: ['200'],
      newIds: ['400'],
      stoppedIds: ['100', '300']
    });
  });
});
