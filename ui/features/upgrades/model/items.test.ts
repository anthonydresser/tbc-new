import { ArmorType, ItemSlot, ItemSpec, ItemType } from '@generated/proto/common';
import type { UIEnchant } from '@generated/proto/ui';
import type { Player } from '@sim/player/player';
import { PlayerSpecs } from '@sim/player/specs';
import type { Gear } from '@sim/proto/gear';
import { patchInventoryState, seedInventorySettings } from '@sim/settings/inventory_settings';
import { seedUpgradeSettings, upgradeState } from '@sim/settings/upgrade_settings';
import { createSimStore } from '@sim/state/sim_store';
import type { UpgradeCandidate, UpgradeResult } from '@sim/upgrade/types';
import { toastManager } from '@ui-kit/Toast';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUpgradeSimSlots, getVisibleUpgradeResults, importInventoryAsCandidates } from './items';

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

	it('drops results without a positive delta when hiding non-upgrades', () => {
		const loss = { ...resultOf(100), delta: -5 };
		const identity = { ...resultOf(200), delta: 0 };
		const gain = { ...resultOf(300), delta: 12 };

		expect(getVisibleUpgradeResults([loss, identity, gain], new Set(), false, true)).toEqual([gain]);
		// The filter is independent of the owned filter.
		expect(getVisibleUpgradeResults([loss, gain], new Set([300]), true, true)).toEqual([]);
	});
});

describe('getUpgradeSimSlots', () => {
	const T1 = ItemSlot.ItemSlotTrinket1;
	const T2 = ItemSlot.ItemSlotTrinket2;
	const F1 = ItemSlot.ItemSlotFinger1;
	const F2 = ItemSlot.ItemSlotFinger2;

	const candidateOf = (id: number, type: ItemType, unique = false): UpgradeCandidate => ({
		spec: ItemSpec.create({ id }),
		equippedItem: {
			item: { id, name: `Item ${id}`, type, armorType: ArmorType.ArmorTypeCloth, classAllowlist: [], unique },
		} as unknown as UpgradeCandidate['equippedItem'],
		selectedEnchant: null,
	});

	const gearWearing = (worn: Partial<Record<ItemSlot, number>>): Gear =>
		({
			getEquippedItem: (slot: ItemSlot) => {
				const id = worn[slot];
				return id == null ? null : { item: { id, name: `Item ${id}` } };
			},
		}) as unknown as Gear;

	it('simms every eligible slot when nothing worn matches', () => {
		expect(getUpgradeSimSlots(player, gearWearing({}), candidateOf(100, ItemType.ItemTypeTrinket))).toEqual([T1, T2]);
	});

	it('simms nothing when a unique-equipped item is worn in either of its slots', () => {
		expect(getUpgradeSimSlots(player, gearWearing({ [T1]: 100 }), candidateOf(100, ItemType.ItemTypeTrinket, true))).toEqual([]);
		expect(getUpgradeSimSlots(player, gearWearing({ [T2]: 100 }), candidateOf(100, ItemType.ItemTypeTrinket, true))).toEqual([]);
	});

	it('drops every slot when a single-slot item is already worn there', () => {
		expect(getUpgradeSimSlots(player, gearWearing({ [ItemSlot.ItemSlotHead]: 100 }), candidateOf(100, ItemType.ItemTypeHead))).toEqual([]);
	});

	it('simms a non-unique ring only in the slots not already wearing it', () => {
		expect(getUpgradeSimSlots(player, gearWearing({ [F1]: 100 }), candidateOf(100, ItemType.ItemTypeFinger))).toEqual([F2]);
	});

	it('simms nothing when a non-unique ring is already worn in both slots', () => {
		expect(getUpgradeSimSlots(player, gearWearing({ [F1]: 100, [F2]: 100 }), candidateOf(100, ItemType.ItemTypeFinger))).toEqual([]);
	});
});
