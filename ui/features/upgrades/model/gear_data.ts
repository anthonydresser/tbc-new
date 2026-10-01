import type { GearData } from '@features/gear/types';
import type { Player } from '@sim/player/player';
import type { EquippedItem } from '@sim/proto/equipped_item';
import { patchUpgradeState, upgradeState } from '@sim/settings/upgrade_settings';
import { Emitter } from '@sim/state/events';

import { isUpgradeRunningGuard } from './items';

/**
 * The selector modal's seam for a candidate enchant: equipping writes back onto the
 * candidate instead of onto the player, and the worn item is read out of the slice
 * each time, so a modal left open on a candidate that has just been re-enchanted
 * shows the new choice.
 */
export const createUpgradeCandidateGearData = (player: Player<any>, index: number): GearData => {
	const changeEvent = new Emitter<void>();
	return {
		equipItem: (newItem: EquippedItem | null) => {
			if (!newItem) return;
			if (isUpgradeRunningGuard(player)) return;
			const { candidates } = upgradeState(player);
			const candidate = candidates[index];
			if (!candidate) return;
			patchUpgradeState(
				player,
				{
					candidates: candidates.map((c, idx) =>
						idx === index ? { ...c, equippedItem: newItem.withItem(c.equippedItem.item), selectedEnchant: newItem.enchant } : c,
					),
				},
				['settings'],
			);
			changeEvent.emit();
		},
		getEquippedItem: () => {
			const candidate = upgradeState(player).candidates[index];
			return candidate ? candidate.equippedItem.withEnchant(candidate.selectedEnchant) : null;
		},
		subscribe: onChange => changeEvent.on(onChange),
	};
};
