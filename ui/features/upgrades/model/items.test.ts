import { ItemSpec, ItemType } from '@generated/proto/common';
import type { UIEnchant } from '@generated/proto/ui';
import type { Player } from '@sim/player/player';
import { PlayerSpecs } from '@sim/player/specs';
import { patchInventoryState, seedInventorySettings } from '@sim/settings/inventory_settings';
import { seedUpgradeSettings, upgradeState } from '@sim/settings/upgrade_settings';
import { createSimStore } from '@sim/state/sim_store';
import type { UpgradeResult } from '@sim/upgrade/types';
import { toastManager } from '@ui-kit/Toast';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getVisibleUpgradeResults, importInventoryAsCandidates } from './items';

const STORE_KEY = 0;

let store: ReturnType<typeof createSimStore>;
let enchants: UIEnchant[];
let toastSpy: ReturnType<typeof vi.spyOn>;
let player: Player<any>;

// A trinket passes canEquipItem for every spec without class or weapon checks, so the
// fake db only has to resolve ids and serve enchants.
const fakeEquippedItem = (spec: ItemSpec) => {
	const equippedItem = {
		item: { id: spec.id, name: `Item ${spec.id}`, type: ItemType.ItemTypeTrinket, classAllowlist: [] },
		withDynamicStats: () => equippedItem,
	};
	return equippedItem;
};

beforeEach(() => {
	store = createSimStore();
	enchants = [];
	const fakeDb = {
		lookupItemSpec: (spec: ItemSpec) => (spec.id > 0 ? fakeEquippedItem(spec) : null),
		getEnchants: () => enchants,
	};
	player = {
		storeKey: STORE_KEY,
		sim: { store, db: fakeDb },
		getPlayerSpec: () => PlayerSpecs.DpsWarrior,
	} as unknown as Player<any>;
	seedInventorySettings(player);
	seedUpgradeSettings(player);
	toastSpy = vi.spyOn(toastManager, 'add').mockImplementation(() => undefined as never);
});

describe('importInventoryAsCandidates', () => {
	it('imports each inventory entry with its stored gems and resolved enchant', () => {
		enchants = [{ effectId: 3000, name: 'Enchant A' } as UIEnchant, { effectId: 3001, name: 'Enchant B' } as UIEnchant];
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100, enchant: 3000, gems: [1, 2] }), ItemSpec.create({ id: 200 })] }, ['items']);

		importInventoryAsCandidates(player);

		const { candidates } = upgradeState(player);
		expect(candidates).toHaveLength(2);
		expect(candidates[0].spec).toEqual(ItemSpec.create({ id: 100, enchant: 3000, gems: [1, 2] }));
		expect(candidates[0].selectedEnchant?.effectId).toBe(3000);
		expect(candidates[0].equippedItem.item.id).toBe(100);
		expect(candidates[1].selectedEnchant).toBeNull();
		expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
	});

	it('skips exact-spec duplicates instead of re-adding them', () => {
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 })] }, ['items']);
		importInventoryAsCandidates(player);
		expect(upgradeState(player).candidates).toHaveLength(1);

		// Same id with a different setup is a different candidate and imports;
		// the identical entry skips.
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 }), ItemSpec.create({ id: 100, enchant: 3000 })] }, ['items']);
		enchants = [{ effectId: 3000, name: 'Enchant A' } as UIEnchant];
		importInventoryAsCandidates(player);

		expect(upgradeState(player).candidates).toHaveLength(2);
		expect(toastSpy).toHaveBeenLastCalledWith(expect.objectContaining({ variant: 'warning' }));
	});

	it('skips entries that do not resolve against the database', () => {
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 }), ItemSpec.create({ id: -1 })] }, ['items']);

		importInventoryAsCandidates(player);

		expect(upgradeState(player).candidates.map(c => c.spec.id)).toEqual([100]);
	});
});

describe('getVisibleUpgradeResults', () => {
	const resultOf = (id: number): UpgradeResult => ({ item: { item: { id } }, slot: 0, delta: id } as unknown as UpgradeResult);

	it('returns every result when the filter is off, even for owned items', () => {
		const results = [resultOf(100), resultOf(200)];
		expect(getVisibleUpgradeResults(results, new Set([100]), false)).toBe(results);
	});

	it('drops results whose item id is owned when the filter is on', () => {
		const results = [resultOf(100), resultOf(200), resultOf(300)];
		expect(getVisibleUpgradeResults(results, new Set([100, 300]), true)).toEqual([resultOf(200)]);
	});
});
