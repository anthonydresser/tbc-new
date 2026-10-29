import { ItemSpec } from '@generated/proto/common';
import type { Player } from '@sim/player/player';
import { PlayerSpecs } from '@sim/player/specs';
import { Database } from '@sim/proto/database';
import type { EquippedItem } from '@sim/proto/equipped_item';
import {
	applyStoredInventory,
	inventoryItems,
	isItemOwned,
	loadStoredInventory,
	patchInventoryState,
	seedInventorySettings,
	storeInventory,
} from '@sim/settings/inventory_settings';
import { createSimStore } from '@sim/state/sim_store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addEquippedGearToInventory, addOwnedItem, clearInventory, removeInventoryItem, toggleOwnedItem, updateInventoryItem } from './items';

// The leftover-DB loader fetches over the network; the fake db resolves everything,
// so the load decision never matters here.
vi.spyOn(Database, 'loadLeftoversIfNecessary').mockResolvedValue(undefined as never);

const STORE_KEY = 0;

let store: ReturnType<typeof createSimStore>;
let storage: Record<string, string>;
let equippedGear: EquippedItem[];
let player: Player<any>;

beforeEach(() => {
	store = createSimStore();
	seedInventorySettings({ storeKey: STORE_KEY, sim: { store } } as unknown as Player<any>);
	storage = {};
	equippedGear = [];
	player = {
		storeKey: STORE_KEY,
		sim: {
			store,
			db: { lookupItemSpec: (spec: ItemSpec) => (spec.id > 0 ? ({ item: { id: spec.id, name: `item-${spec.id}` } } as unknown) : null) },
			env: {
				storage: {
					getItem: (key: string) => storage[key] ?? null,
					setItem: (key: string, value: string) => {
						storage[key] = value;
					},
					removeItem: (key: string) => {
						delete storage[key];
					},
				},
			},
		},
		getPlayerSpec: () => PlayerSpecs.DpsWarrior,
		getGear: () => ({ getEquippedItems: () => equippedGear }),
	} as unknown as Player<any>;
});

describe('inventory model', () => {
	it('toggleOwnedItem adds a bare entry and removes it again', () => {
		toggleOwnedItem(player, ItemSpec.create({ id: 100 }));
		expect(isItemOwned(player, 100)).toBe(true);
		expect(inventoryItems(player).map(s => s.id)).toEqual([100]);

		toggleOwnedItem(player, ItemSpec.create({ id: 100 }));
		expect(isItemOwned(player, 100)).toBe(false);
	});

	it('keeps identity at the item id: one entry per id regardless of setup', () => {
		updateInventoryItem(player, 100, ItemSpec.create({ id: 100, enchant: 3000 }));
		toggleOwnedItem(player, ItemSpec.create({ id: 100, gems: [1, 2] }));
		expect(inventoryItems(player)).toEqual([]);
	});

	it('updateInventoryItem replaces the stored setup and preserves other entries', () => {
		updateInventoryItem(player, 100, ItemSpec.create({ id: 100, enchant: 3000 }));
		updateInventoryItem(player, 200, ItemSpec.create({ id: 200, gems: [10] }));
		updateInventoryItem(player, 100, ItemSpec.create({ id: 100, enchant: 4000, gems: [5] }));

		expect(inventoryItems(player)).toEqual([ItemSpec.create({ id: 100, enchant: 4000, gems: [5] }), ItemSpec.create({ id: 200, gems: [10] })]);
	});

	it('removeInventoryItem and clearInventory drop entries', () => {
		updateInventoryItem(player, 100, ItemSpec.create({ id: 100 }));
		updateInventoryItem(player, 200, ItemSpec.create({ id: 200 }));
		removeInventoryItem(player, 100);
		expect(inventoryItems(player).map(s => s.id)).toEqual([200]);
		clearInventory(player);
		expect(inventoryItems(player)).toEqual([]);
	});

	it('addEquippedGearToInventory upserts equipped setups, overwriting stored ones by id', () => {
		updateInventoryItem(player, 100, ItemSpec.create({ id: 100, gems: [9] }));
		equippedGear = [
			{ asSpec: () => ItemSpec.create({ id: 100, enchant: 3000, gems: [1] }) },
			{ asSpec: () => ItemSpec.create({ id: 200, enchant: 3001 }) },
			null,
		] as unknown as EquippedItem[];

		addEquippedGearToInventory(player);

		expect(inventoryItems(player)).toEqual([ItemSpec.create({ id: 100, enchant: 3000, gems: [1] }), ItemSpec.create({ id: 200, enchant: 3001 })]);
	});

	it('addEquippedGearToInventory is a no-op when nothing changed', () => {
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 })] }, ['items']);
		const before = store.getState().inventory[STORE_KEY].v.items;
		equippedGear = [{ asSpec: () => ItemSpec.create({ id: 100 }) }] as unknown as EquippedItem[];

		addEquippedGearToInventory(player);

		expect(store.getState().inventory[STORE_KEY].v.items).toBe(before);
	});

	it('addOwnedItem adds a bare entry and returns true', () => {
		expect(addOwnedItem(player, ItemSpec.create({ id: 100 }))).toBe(true);
		expect(isItemOwned(player, 100)).toBe(true);
		expect(inventoryItems(player).map(s => s.id)).toEqual([100]);
	});

	it('addOwnedItem is a no-op on an already-owned id — the stored setup survives', () => {
		updateInventoryItem(player, 100, ItemSpec.create({ id: 100, enchant: 3000, gems: [5] }));

		expect(addOwnedItem(player, ItemSpec.create({ id: 100 }))).toBe(false);
		expect(inventoryItems(player)).toEqual([ItemSpec.create({ id: 100, enchant: 3000, gems: [5] })]);
	});

	it('addOwnedItem refuses an id the database cannot resolve', () => {
		expect(addOwnedItem(player, ItemSpec.create({ id: -1 }))).toBe(false);
		expect(inventoryItems(player)).toEqual([]);
	});
});

describe('inventory persistence', () => {
	it('round-trips the blob through storage', async () => {
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100, enchant: 3000, gems: [1, 0] })] }, ['items']);

		expect(storeInventory(player)).toBe(true);
		const stored = loadStoredInventory(player);
		expect(stored).not.toBeNull();
		const { dropped } = await applyStoredInventory(player, stored!);

		expect(dropped).toBe(0);
		expect(inventoryItems(player)).toEqual([ItemSpec.create({ id: 100, enchant: 3000, gems: [1, 0] })]);
	});

	it('returns null for an absent blob', () => {
		expect(loadStoredInventory(player)).toBeNull();
	});

	it('backs up a corrupt blob and returns null', () => {
		const key = Object.keys({ ...storage });
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 })] }, ['items']);
		storeInventory(player);
		const blobKey = Object.keys(storage).find(k => !key.includes(k))!;
		storage[blobKey] = '{not json';

		expect(loadStoredInventory(player)).toBeNull();
		// The corrupt blob was preserved aside, not deleted.
		expect(storage[`${blobKey}.corrupt-backup`]).toBe('{not json');
		expect(storage[blobKey]).toBe('{not json');
	});

	it('drops entries that do not resolve against the database and counts them', async () => {
		const stored = { items: [ItemSpec.toJson(ItemSpec.create({ id: 100 })) as Record<string, unknown>, { id: -5 }] };

		const { dropped } = await applyStoredInventory(player, stored);

		expect(dropped).toBe(1);
		expect(inventoryItems(player).map(s => s.id)).toEqual([100]);
	});
});
