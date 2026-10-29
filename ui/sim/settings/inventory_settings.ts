// The owned-items inventory: store slice and its persisted blob. Derived from the
// player like bulk/upgrades: the slice is `inventory[player.storeKey]` and the
// storage key is the player's spec prefix + `inventory.v1`.
//
// The blob is deliberately never deleted on a quota error and never clobbered when
// it can't be parsed — a previously stored inventory is better than none; corrupt
// blobs are copied aside to `.corrupt-backup` first.
import { EquipmentSpec, ItemSpec } from '@generated/proto/common';

import type { Player } from '../player/player';
import { Database } from '../proto/database';
import { sanitizeProtoJson } from '../state/proto_json';
import { patchKeyed, seedKeyed, type InventorySlice } from '../state/sim_store';
import { specStorageKey } from '../state/storage_keys';

export const INVENTORY_STORAGE_KEY = 'inventory.v1';
const CORRUPT_BACKUP_SUFFIX = '.corrupt-backup';

const initialInventorySlice = (): InventorySlice => ({
	items: [],
	v: { items: 0 },
});

// Seeds the slice before any subscriber exists (emit-less).
export const seedInventorySettings = (player: Player<any>) => seedKeyed(player.sim.store, 'inventory', player.storeKey, initialInventorySlice());

export const inventoryState = (player: Player<any>): InventorySlice => player.sim.store.getState().inventory[player.storeKey];

// A bump with an empty patch is a bare emit; a patch with no bumps is a silent field write.
export const patchInventoryState = (player: Player<any>, patch: Partial<Omit<InventorySlice, 'v'>>, bumps: ReadonlyArray<keyof InventorySlice['v']> = []) =>
	patchKeyed(player.sim.store, 'inventory', player.storeKey, patch, bumps);

// ---------------------------------------------------------------------------
// Blob serialization. ItemSpecs only — names/stats resolve from the database at
// restore time, so the blob stays small against the shared localStorage quota.

interface StoredInventory {
	items: Array<Record<string, unknown>>;
}

// Writes the inventory. Returns false on a quota error, keeping the previously
// stored blob in place — the caller surfaces the toast.
export const storeInventory = (player: Player<any>): boolean => {
	const { storage } = player.sim.env;
	const key = specStorageKey(player.getPlayerSpec(), INVENTORY_STORAGE_KEY);
	try {
		const blob: StoredInventory = { items: inventoryState(player).items.map(spec => ItemSpec.toJson(spec) as Record<string, unknown>) };
		storage.setItem(key, JSON.stringify(blob));
		return true;
	} catch (e) {
		console.error('Failed to persist inventory:', e);
		return false;
	}
};

// Reads the persisted blob as raw ItemSpec JSON entries (database resolution happens
// in applyStoredInventory, which is async). Returns null when nothing is stored; a
// corrupt blob is copied to `.corrupt-backup` and then treated as absent.
export const loadStoredInventory = (player: Player<any>): StoredInventory | null => {
	const { storage } = player.sim.env;
	const key = specStorageKey(player.getPlayerSpec(), INVENTORY_STORAGE_KEY);
	const stored = storage.getItem(key);
	if (stored == null) return null;

	try {
		const parsed = JSON.parse(stored);
		if (!parsed || !Array.isArray(parsed.items)) return null;
		return { items: parsed.items };
	} catch (e) {
		console.error('Failed to parse saved inventory:', e);
		try {
			storage.setItem(`${key}${CORRUPT_BACKUP_SUFFIX}`, stored);
		} catch (backupError) {
			console.error('Failed to back up corrupt inventory:', backupError);
		}
		return null;
	}
};

// Applies a stored blob to the slice. Entries that fail to resolve against the
// database are dropped, not fatal, and the count comes back for the toast. The
// leftover item DB is loaded first so entries referencing items removed from the
// current DB still restore.
export const applyStoredInventory = async (player: Player<any>, stored: StoredInventory): Promise<{ dropped: number }> => {
	const { db } = player.sim;

	const specs: ItemSpec[] = [];
	(stored.items || []).forEach(itemJson => {
		try {
			const spec = ItemSpec.fromJson(sanitizeProtoJson(itemJson));
			if (spec.id) specs.push(spec);
		} catch {
			// Malformed entries are reported as dropped below.
		}
	});

	if (specs.length) {
		try {
			await Database.loadLeftoversIfNecessary(EquipmentSpec.create({ items: specs }));
		} catch (error) {
			console.error('Failed to load leftover item database for saved inventory:', error);
		}
	}

	let dropped = (stored.items?.length ?? 0) - specs.length;
	const keep = specs.filter(spec => {
		if (db.lookupItemSpec(spec)) return true;
		console.warn('Saved inventory: item not found in database:', spec.id);
		dropped++;
		return false;
	});

	patchInventoryState(player, { items: keep }, keep.length || dropped ? ['items'] : []);
	return { dropped };
};

// ---------------------------------------------------------------------------
// Read helpers for UIs. Badge/filter call sites should build a Set from
// inventoryItems once per change instead of calling isItemOwned per row.

export const inventoryItems = (player: Player<any>): ReadonlyArray<ItemSpec> => inventoryState(player)?.items ?? [];

export const isItemOwned = (player: Player<any>, itemId: number): boolean => inventoryItems(player).some(spec => spec.id === itemId);
