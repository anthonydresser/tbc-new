// DOM-free mutations of the owned-items inventory. All writes go through
// patchInventoryState with an 'items' bump; reads go through the
// inventory_settings facade. Identity is the item id: one entry per id, so
// toggling and upserts converge regardless of the stored setup.
import { ItemSpec } from '@generated/proto/common';
import i18n from '@i18n/config';

import type { Player } from '@sim/player/player';

import { inventoryItems, patchInventoryState } from '@sim/settings/inventory_settings';
import { toastManager } from '@ui-kit/Toast';

const setItems = (player: Player<any>, items: ItemSpec[]) => patchInventoryState(player, { items }, ['items']);

// The selector modal toggle: rows carry no enchant/gems, so a fresh entry stores
// the bare id (plus a random suffix if the tab has one). Existing entries are
// removed entirely — the toggle is "mark unowned", not "reset the setup".
export const toggleOwnedItem = (player: Player<any>, spec: ItemSpec) => {
	const items = inventoryItems(player);
	if (items.some(s => s.id === spec.id)) {
		setItems(player, items.filter(s => s.id !== spec.id).map(s => ItemSpec.clone(s)) as ItemSpec[]);
	} else {
		setItems(player, [...items.map(s => ItemSpec.clone(s)), ItemSpec.create({ id: spec.id, randomSuffix: spec.randomSuffix || undefined })]);
	}
};

export const removeInventoryItem = (player: Player<any>, itemId: number) => {
	setItems(player, inventoryItems(player).filter(s => s.id !== itemId).map(s => ItemSpec.clone(s)) as ItemSpec[]);
};

export const clearInventory = (player: Player<any>) => setItems(player, []);

// Replaces the setup stored for an item id (edit via the selector modal), or
// appends it if the item isn't in the inventory yet.
export const updateInventoryItem = (player: Player<any>, itemId: number, spec: ItemSpec) => {
	const items = inventoryItems(player);
	const next = items.map(s => ItemSpec.clone(s)) as ItemSpec[];
	const idx = next.findIndex(s => s.id === itemId);
	if (idx >= 0) next[idx] = spec;
	else next.push(spec);
	setItems(player, next);
};

// Upserts the player's currently equipped gear (fully gemmed/enchanted) into the
// inventory in one patch. Id-level: an already-owned item's stored setup is
// overwritten by what's actually worn.
export const addEquippedGearToInventory = (player: Player<any>) => {
	const equippedSpecs = player
		.getGear()
		.getEquippedItems()
		.filter(Boolean)
		.map(equipped => equipped!.asSpec());

	const next = inventoryItems(player).map(s => ItemSpec.clone(s)) as ItemSpec[];
	let added = 0;
	let updated = 0;
	for (const spec of equippedSpecs) {
		const idx = next.findIndex(s => s.id === spec.id);
		if (idx >= 0) {
			if (!ItemSpec.equals(next[idx], spec)) {
				next[idx] = spec;
				updated++;
			}
		} else {
			next.push(spec);
			added++;
		}
	}
	if (added + updated > 0) {
		setItems(player, next);
		toastManager.add({ variant: 'success', body: i18n.t('inventory.notifications.equipped_added', { count: added + updated }) });
	}
};
