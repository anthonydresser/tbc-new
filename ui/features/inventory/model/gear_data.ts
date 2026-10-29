import type { GearData } from '@features/gear/types';
import type { Player } from '@sim/player/player';
import type { EquippedItem } from '@sim/proto/equipped_item';
import { inventoryState } from '@sim/settings/inventory_settings';
import { Emitter } from '@sim/state/events';

import { updateInventoryItem } from './items';

/**
 * The selector modal's seam for editing one inventory entry. Keyed by item id —
 * stable across removals (indexes would shift) — so a modal left open on an entry
 * that's just been removed reads back null and its edits no-op. The full tab strip
 * (Items/Enchants/Gems/Suffix) funnels through `equipItem`, so one seam covers
 * every edit.
 */
export const createInventoryGearData = (player: Player<any>, itemId: number): GearData => {
	const changeEvent = new Emitter<void>();
	return {
		equipItem: (newItem: EquippedItem | null) => {
			if (!newItem) return;
			updateInventoryItem(player, itemId, newItem.asSpec());
			changeEvent.emit();
		},
		getEquippedItem: () => {
			const spec = inventoryState(player)?.items.find(s => s.id === itemId);
			return spec ? (player.sim.db.lookupItemSpec(spec)?.withDynamicStats() ?? null) : null;
		},
		subscribe: onChange => changeEvent.on(onChange),
	};
};
