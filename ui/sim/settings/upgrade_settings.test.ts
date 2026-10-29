import { ItemSpec } from '@generated/proto/common';
import { describe, expect, it } from 'vitest';

import { upgradeRunsEqual } from './upgrade_settings';
import type { SavedUpgradeRun } from '../upgrade/types';

const baseRun = (overrides: Partial<SavedUpgradeRun> = {}): SavedUpgradeRun => ({
	name: 'Fury Warrior Upgrades',
	timestamp: 1755800000,
	items: [ItemSpec.toJson(ItemSpec.create({ id: 100 })) as Record<string, any>],
	fallbackGems: [0, 0, 0, 0, 0],
	optimizeGems: false,
	compareBisEnabled: false,
	bisReferenceName: '',
	bisReferenceIsPreset: false,
	hideOwnedResults: false,
	hideNonUpgrades: false,
	baselineResult: null,
	bisResult: null,
	upgradeResults: [],
	...overrides,
});

describe('upgradeRunsEqual', () => {
	it('ignores name and timestamp (bookkeeping)', () => {
		expect(upgradeRunsEqual(baseRun(), baseRun({ name: 'renamed', timestamp: 999 }))).toBe(true);
	});

	it('ignores the hide-* result filters (view state, not run content)', () => {
		expect(upgradeRunsEqual(baseRun(), baseRun({ hideOwnedResults: true }))).toBe(true);
		expect(upgradeRunsEqual(baseRun(), baseRun({ hideOwnedResults: true, hideNonUpgrades: true }))).toBe(true);
	});

	it('still detects different run content', () => {
		expect(upgradeRunsEqual(baseRun(), baseRun({ items: [ItemSpec.toJson(ItemSpec.create({ id: 200 })) as Record<string, any>] }))).toBe(false);
		expect(upgradeRunsEqual(baseRun(), baseRun({ optimizeGems: true }))).toBe(false);
	});
});
