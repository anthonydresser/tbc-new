// What happens to a bulk candidate between gem optimization and simming: the user's enchant
// allow-list is greedily re-selected per slot by marginal EP. DOM-free; driven from
// features/bulk/model/run.ts through sim.runBulkSim's prepareCandidates hook.
import { BulkEnchantSelection } from '@generated/proto/api';
import { Profession } from '@generated/proto/common';
import type { UIEnchant as Enchant } from '@generated/proto/ui';

import type { Player } from '../player/player';
import type { Database } from '../proto/database';
import type { Gear } from '../proto/gear';
import { canEquipEnchant, enchantAppliesToItem } from '../proto/items';

export const bulkEnchantSelectionKey = (enchant: Enchant): string => `${enchant.effectId}-${enchant.type}`;

export const resolveBulkAllowedEnchants = (db: Database, selections: ReadonlyArray<BulkEnchantSelection>): Enchant[] =>
	selections
		.map(selection => db.enchantEffectIdToEnchant(selection.effectId, selection.type))
		.filter((enchant): enchant is Enchant => enchant != null);

// Re-selects the best allow-listed enchant per slot by marginal EP: each candidate is valued
// against the gear as it stands after the earlier slots have been enchanted, so interactions
// between slots (e.g. two identical weapons taking different enchants) resolve correctly.
export const optimizeBulkEnchantsForGear = (player: Player<any>, gear: Gear, allowedEnchants: ReadonlyArray<Enchant>): Gear => {
	if (!allowedEnchants.length) return gear;

	let optimized = gear;
	for (const slot of gear.getItemSlots()) {
		if (!gear.getEquippedItem(slot)) continue;
		const applicableEnchants = allowedEnchants.filter(
			enchant => enchantAppliesToItem(enchant, gear.getEquippedItem(slot)!.item) && canEquipEnchant(enchant, player.getPlayerSpec(), player.hasProfession(Profession.Enchanting)),
		);
		if (!applicableEnchants.length) continue;

		let bestEnchant: Enchant | null = null;
		let bestEP = 0;
		for (const enchant of applicableEnchants) {
			const currentItem = optimized.getEquippedItem(slot)!;
			const enchantDelta = player.computeEquippedItemEP(currentItem.withEnchant(enchant), slot) - player.computeEquippedItemEP(currentItem, slot);
			if (enchantDelta > bestEP) {
				bestEP = enchantDelta;
				bestEnchant = enchant;
			}
		}

		if (bestEnchant) {
			optimized = optimized.withEquippedItem(slot, optimized.getEquippedItem(slot)!.withEnchant(bestEnchant));
		}
	}
	return optimized;
};
